import Foundation
import CoreGraphics
import ApplicationServices
import ScreenCaptureKit
import CoreMedia
import ObjectiveC

// ============================================================================
// Zero-Token-GUIAgent: Merged Kimi-CU (REA) + Codex SkyComputerUseService Bridge
// ============================================================================
// Combines:
// 1. Kimi-CU `BackgroundInput.MouseRoutingFieldSet` (0x100062f8c):
//    9-field dual-channel CGEvent + SLEvent window routing stamp + 28.0pt
//    Title-Bar Cmd-Click anti-raise guard (`kCGEventFlagMaskCommand = 0x100000`).
// 2. Kimi-CU `SkyLight` (0x1002c4cd0):
//    248-byte (`0xf8`) `SLSEventRecord` AppKitDefined (`0x0d`) focus packet +
//    `SLPSPostEventRecordTo(&psn, record)` + `SLPSSetFrontProcessWithOptions(&psn, 0, 0x400)`.
// 3. Kimi-CU `SignedKeyboard` (0x1002c28ac):
//    Reading `CGEventRef + 0x18` internal `SLSEventRecord*` pointer +
//    `[SLSEventAuthenticationMessage messageWithEventRecord:record pid:pid version:0]` +
//    `SLEventSetAuthenticationMessage` + `SLEventPostToPid`.
// 4. Kimi-CU `Screenshot.WindowCaptureSessions` (0x1001173c0) & `ServiceIPC.BurstContextPolicy`:
//    10 FPS (`CMTime(1, 10)`) ScreenCaptureKit `SCStream` anti-occlusion keep-alive lease +
//    `BurstFrameProbe` / `BurstReuseDecision` zero-copy framebuffer reuse.
// 5. Codex `SkyComputerUseService`:
//    `SyntheticAppFocusEnforcer` + `SystemFocusStealPreventer` (`DisallowedThiefProcess`) +
//    `RefetchableSkyshotAXTree` fast-IPC burst execution (`disableAXDiffing`, `skipScreenshot`).
// ============================================================================

public struct CPSProcessSerNum {
    public var hi: UInt32 = 0
    public var lo: UInt32 = 0
    public init(hi: UInt32 = 0, lo: UInt32 = 0) {
        self.hi = hi
        self.lo = lo
    }
}

public enum CPSActivationConstants {
    /// `kCPSNoWindows = 0x400`: Activates responder chain without raising windows to front.
    public static let kCPSNoWindows: UInt32 = 0x400
    /// `kCGEventFlagMaskCommand = 0x100000`: Prevents macOS WindowServer from raising background window on title-bar click.
    public static let kCGEventFlagMaskCommand: UInt64 = 0x100000
    /// `framePressStripHeight = 28.0`: Top title-bar strip height requiring Cmd-Click guard.
    public static let framePressStripHeight: CGFloat = 28.0
}

/// Exact 9-field Mouse Routing Field Set reconstructed from `KimiCU.BackgroundInput.MouseRoutingFieldSet` (`0x100062f8c`)
public struct MouseRoutingFieldSet {
    public let targetPID: Int64
    public let windowID: Int64
    public let localPoint: CGPoint

    /// Private CGEventField / SLEventField constants stamped on both CG and SL channels:
    /// - 0x07 (7):   Subtype = 3
    /// - 0x28 (40):  kCGEventTargetUnixProcessID = targetPID
    /// - 0x33 (51):  kCGMouseEventWindowUnderMousePointer = windowID
    /// - 0x3a (58):  WindowServer routing target = windowID
    /// - 0x5b (91):  kCGMouseEventWindowUnderMousePointerThatCanHandleThisEvent = windowID
    /// - 0x5c (92):  Secondary WindowServer hit-test window = windowID
    public static let fieldSubtype: UInt32 = 0x07
    public static let fieldTargetPID: UInt32 = 0x28
    public static let fieldWindowUnderPointer: UInt32 = 0x33
    public static let fieldRoutingWindow: UInt32 = 0x3a
    public static let fieldHandlingWindow: UInt32 = 0x5b
    public static let fieldSecondaryHitWindow: UInt32 = 0x5c

    public init(targetPID: pid_t, windowID: CGWindowID, localPoint: CGPoint) {
        self.targetPID = Int64(targetPID)
        self.windowID = Int64(windowID)
        self.localPoint = localPoint
    }
}

/// Reconstructed from `KimiCU.ServiceIPC.BurstContextPolicy` (`0x10002d000`)
public struct BurstContextPolicy {
    public let maxBurstAgeMs: Double
    public let geometryDriftTolerancePx: CGFloat

    public init(maxBurstAgeMs: Double = 120.0, geometryDriftTolerancePx: CGFloat = 2.0) {
        self.maxBurstAgeMs = maxBurstAgeMs
        self.geometryDriftTolerancePx = geometryDriftTolerancePx
    }

    public enum BurstReuseDecision: String {
        case reuseCachedSnapshot = "REUSE_CACHED_SNAPSHOT"
        case refetchAXOnly = "REFETCH_AX_ONLY_SKIP_SCREENSHOT"
        case fullRefreshRequired = "FULL_REFRESH_REQUIRED"
    }

    public func evaluateBurstReuse(
        elapsedMs: Double,
        bboxDeltaPx: CGFloat,
        fastIPCMode: Bool
    ) -> BurstReuseDecision {
        if bboxDeltaPx > geometryDriftTolerancePx {
            return .fullRefreshRequired
        }
        if fastIPCMode && elapsedMs <= maxBurstAgeMs {
            return .refetchAXOnly
        }
        if elapsedMs <= (maxBurstAgeMs * 0.5) {
            return .reuseCachedSnapshot
        }
        return .fullRefreshRequired
    }
}

/// Reconstructed from `Codex SkyComputerUseService.SystemFocusStealPreventer`
public final class SystemFocusStealPreventer {
    public struct DisallowedThiefProcess: Hashable {
        public let pid: pid_t
        public let bundleIdentifier: String
        public init(pid: pid_t, bundleIdentifier: String) {
            self.pid = pid
            self.bundleIdentifier = bundleIdentifier
        }
    }

    private var protectedForegroundPID: pid_t?
    private var disallowedThieves: Set<pid_t> = []

    public init(protectedForegroundPID: pid_t? = nil) {
        self.protectedForegroundPID = protectedForegroundPID
    }

    public func registerManagedBackgroundTarget(pid: pid_t) {
        disallowedThieves.insert(pid)
    }

    public func shouldSuppressFrontmostTransition(candidatePID: pid_t) -> Bool {
        guard let fg = protectedForegroundPID else { return disallowedThieves.contains(candidatePID) }
        return candidatePID != fg && disallowedThieves.contains(candidatePID)
    }
}

/// Dynamic resolver for private SkyLight & CoreGraphics symbols (`0x1002c4cd0` & `0x1002c28ac`)
public final class SkyLightPrivateAPI {
    public static let shared = SkyLightPrivateAPI()

    private let skyLightHandle: UnsafeMutableRawPointer?
    private let coreGraphicsHandle: UnsafeMutableRawPointer?

    // Function pointer types matching Kimi-CU disassembly
    private typealias GetProcessForPIDFn = @convention(c) (pid_t, UnsafeMutablePointer<CPSProcessSerNum>) -> Int32
    private typealias SLPSSetFrontProcessWithOptionsFn = @convention(c) (UnsafePointer<CPSProcessSerNum>, UInt32, UInt32) -> Int32
    private typealias SLPSPostEventRecordToFn = @convention(c) (UnsafePointer<CPSProcessSerNum>, UnsafePointer<UInt8>) -> Int32
    private typealias SLEventSetIntegerValueFieldFn = @convention(c) (CGEvent, UInt32, Int64) -> Void
    private typealias CGEventSetWindowLocationFn = @convention(c) (CGEvent, CGPoint) -> Void
    private typealias SLEventSetAuthenticationMessageFn = @convention(c) (CGEvent, AnyObject) -> Void
    private typealias SLEventPostToPidFn = @convention(c) (pid_t, CGEvent) -> Int32

    private var fnGetProcessForPID: GetProcessForPIDFn?
    private var fnSLPSSetFrontProcessWithOptions: SLPSSetFrontProcessWithOptionsFn?
    private var fnSLPSPostEventRecordTo: SLPSPostEventRecordToFn?
    private var fnSLEventSetIntegerValueField: SLEventSetIntegerValueFieldFn?
    private var fnCGEventSetWindowLocation: CGEventSetWindowLocationFn?
    private var fnSLEventSetAuthenticationMessage: SLEventSetAuthenticationMessageFn?
    private var fnSLEventPostToPid: SLEventPostToPidFn?

    private init() {
        self.skyLightHandle = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)
        self.coreGraphicsHandle = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_LAZY)

        if let h = skyLightHandle {
            if let sym = dlsym(h, "GetProcessForPID") ?? dlsym(h, "_SLPSGetProcessForPID") {
                fnGetProcessForPID = unsafeBitCast(sym, to: GetProcessForPIDFn.self)
            }
            if let sym = dlsym(h, "_SLPSSetFrontProcessWithOptions") ?? dlsym(h, "SLPSSetFrontProcessWithOptions") {
                fnSLPSSetFrontProcessWithOptions = unsafeBitCast(sym, to: SLPSSetFrontProcessWithOptionsFn.self)
            }
            if let sym = dlsym(h, "SLPSPostEventRecordTo") {
                fnSLPSPostEventRecordTo = unsafeBitCast(sym, to: SLPSPostEventRecordToFn.self)
            }
            if let sym = dlsym(h, "SLEventSetIntegerValueField") {
                fnSLEventSetIntegerValueField = unsafeBitCast(sym, to: SLEventSetIntegerValueFieldFn.self)
            }
            if let sym = dlsym(h, "SLEventSetAuthenticationMessage") {
                fnSLEventSetAuthenticationMessage = unsafeBitCast(sym, to: SLEventSetAuthenticationMessageFn.self)
            }
            if let sym = dlsym(h, "SLEventPostToPid") {
                fnSLEventPostToPid = unsafeBitCast(sym, to: SLEventPostToPidFn.self)
            }
        }
        if let cg = coreGraphicsHandle ?? skyLightHandle {
            if let sym = dlsym(cg, "CGEventSetWindowLocation") ?? dlsym(cg, "SLEventSetWindowLocation") {
                fnCGEventSetWindowLocation = unsafeBitCast(sym, to: CGEventSetWindowLocationFn.self)
            }
        }
    }

    // ------------------------------------------------------------------------
    // 1. 248-Byte (`0xf8`) SLSEventRecord Background Focus Spoofing (`0x1002c4cd0`)
    // ------------------------------------------------------------------------
    @discardableResult
    public func spoofBackgroundKeyWindowFocus(pid: pid_t, windowID: CGWindowID, acquireFocus: Bool = true) -> Bool {
        var psn = CPSProcessSerNum()
        if let getPSN = fnGetProcessForPID {
            _ = getPSN(pid, &psn)
        }
        // Step A: Activate process responder chain with kCPSNoWindows (0x400) so no window is raised
        if let setFront = fnSLPSSetFrontProcessWithOptions {
            _ = setFront(&psn, windowID, CPSActivationConstants.kCPSNoWindows)
        }
        // Step B: Construct 248-byte (0xf8) raw SLSEventRecord packet
        var record = [UInt8](repeating: 0, count: 0xf8)
        record[0x04] = 0xf8                           // Packet length marker
        record[0x08] = 0x0d                           // Event type: AppKitDefined (13)
        record[0x8a] = acquireFocus ? 0x01 : 0x02     // 1 = BecomeKeyWindow, 2 = ResignKeyWindow
        var wid = UInt32(windowID)
        withUnsafeBytes(of: &wid) { rawBytes in
            for i in 0..<4 {
                record[0x3c + i] = rawBytes[i]        // Offset 0x3c: target WindowID
            }
        }
        // Fill 16-byte WindowServer routing token at 0x20..0x2f
        for i in 0..<16 {
            record[0x20 + i] = 0xff
        }
        if let postRecord = fnSLPSPostEventRecordTo {
            return postRecord(&psn, record) == 0
        }
        return false
    }

    // ------------------------------------------------------------------------
    // 2. Dual-Channel 9-Field Mouse Routing Stamp (`0x100062f8c`)
    // ------------------------------------------------------------------------
    public func applyMouseRoutingFieldSet(
        event: CGEvent,
        routing: MouseRoutingFieldSet,
        windowFrame: CGRect,
        globalPoint: CGPoint
    ) {
        let fields: [(UInt32, Int64)] = [
            (MouseRoutingFieldSet.fieldSubtype, 3),
            (MouseRoutingFieldSet.fieldTargetPID, routing.targetPID),
            (MouseRoutingFieldSet.fieldWindowUnderPointer, routing.windowID),
            (MouseRoutingFieldSet.fieldRoutingWindow, routing.windowID),
            (MouseRoutingFieldSet.fieldHandlingWindow, routing.windowID),
            (MouseRoutingFieldSet.fieldSecondaryHitWindow, routing.windowID),
        ]

        for (field, val) in fields {
            if let cgField = CGEventField(rawValue: field) {
                event.setIntegerValueField(cgField, value: val)
            }
            fnSLEventSetIntegerValueField?(event, field, val)
        }

        // Stamp window-local coordinates
        fnCGEventSetWindowLocation?(event, routing.localPoint)

        // Kimi-CU 28.0pt Title-Bar Cmd-Click Anti-Raise Guard (`framePressStripHeight = 28.0`)
        let relativeY = globalPoint.y - windowFrame.origin.y
        if relativeY >= 0 && relativeY <= CPSActivationConstants.framePressStripHeight {
            let currentFlags = event.flags.rawValue
            event.flags = CGEventFlags(rawValue: currentFlags | CPSActivationConstants.kCGEventFlagMaskCommand)
        }
    }

    // ------------------------------------------------------------------------
    // 3. Hardware-Signed Keyboard Injection (`SignedKeyboard` @ `0x1002c28ac`)
    // ------------------------------------------------------------------------
    @discardableResult
    public func postSignedKeyboardEvent(event: CGEvent, targetPID: pid_t) -> Bool {
        // Extract internal SLSEventRecord* at offset +0x18 inside CGEventRef
        let unmanagedPtr = Unmanaged.passUnretained(event).toOpaque()
        let eventRecordPtr = unmanagedPtr.advanced(by: 0x18).load(as: UnsafeRawPointer?.self)

        if let authClass = objc_getClass("SLSEventAuthenticationMessage") as? AnyObject,
           let recordPtr = eventRecordPtr {
            let sel = NSSelectorFromString("messageWithEventRecord:pid:version:")
            if authClass.responds(to: sel) {
                typealias AuthMsgFn = @convention(c) (AnyObject, Selector, UnsafeRawPointer, pid_t, Int32) -> AnyObject?
                let imp = authClass.method(for: sel)
                let createAuthMsg = unsafeBitCast(imp, to: AuthMsgFn.self)
                if let authMessage = createAuthMsg(authClass, sel, recordPtr, targetPID, 0) {
                    fnSLEventSetAuthenticationMessage?(event, authMessage)
                }
            }
        }

        if let slPost = fnSLEventPostToPid {
            return slPost(targetPID, event) == 0
        }
        event.postToPid(targetPID)
        return true
    }

    // ------------------------------------------------------------------------
    // 4. Full Background Click Sequence (Spoof Focus -> Stamp 9 Fields -> Post)
    // ------------------------------------------------------------------------
    public func performSilentBackgroundClick(
        pid: pid_t,
        windowID: CGWindowID,
        windowFrame: CGRect,
        globalPoint: CGPoint
    ) -> Bool {
        _ = spoofBackgroundKeyWindowFocus(pid: pid, windowID: windowID, acquireFocus: true)

        let localPoint = CGPoint(
            x: globalPoint.x - windowFrame.origin.x,
            y: globalPoint.y - windowFrame.origin.y
        )
        let routing = MouseRoutingFieldSet(targetPID: pid, windowID: windowID, localPoint: localPoint)

        guard let downEvent = CGEvent(
            mouseEventSource: nil,
            mouseType: .leftMouseDown,
            mouseCursorPosition: globalPoint,
            mouseButton: .left
        ),
        let upEvent = CGEvent(
            mouseEventSource: nil,
            mouseType: .leftMouseUp,
            mouseCursorPosition: globalPoint,
            mouseButton: .left
        ) else {
            return false
        }

        applyMouseRoutingFieldSet(event: downEvent, routing: routing, windowFrame: windowFrame, globalPoint: globalPoint)
        applyMouseRoutingFieldSet(event: upEvent, routing: routing, windowFrame: windowFrame, globalPoint: globalPoint)

        downEvent.postToPid(pid)
        usleep(12_000) // 12ms deterministic dwell
        upEvent.postToPid(pid)
        return true
    }
}

// ============================================================================
// 5. 10-FPS ScreenCaptureKit Anti-Occlusion Keep-Alive Lease (`0x1001173c0`)
// ============================================================================
@available(macOS 12.3, *)
public final class WindowCaptureKeepAliveLease: NSObject, SCStreamOutput {
    private var activeStreams: [CGWindowID: SCStream] = [:]
    private var latestSampleBuffers: [CGWindowID: CMSampleBuffer] = [:]
    private let lock = NSLock()

    public func ensureKeepAliveStream(for window: SCWindow) async throws {
        let wid = window.windowID
        lock.lock()
        if activeStreams[wid] != nil {
            lock.unlock()
            return
        }
        lock.unlock()

        let filter = SCContentFilter(desktopIndependentWindow: window)
        let config = SCStreamConfiguration()
        config.width = Int(window.frame.width)
        config.height = Int(window.frame.height)
        // Kimi-CU `Screenshot.WindowCaptureSessions` 10 FPS keep-alive lease: CMTime(1, 10)
        config.minimumFrameInterval = CMTime(value: 1, timescale: 10)
        config.showsCursor = false
        config.queueDepth = 2

        let stream = SCStream(filter: filter, configuration: config, delegate: nil)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: .global(qos: .userInteractive))
        try await stream.startCapture()

        lock.lock()
        activeStreams[wid] = stream
        lock.unlock()
    }

    public func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid else { return }
        lock.lock()
        for (wid, s) in activeStreams where s === stream {
            latestSampleBuffers[wid] = sampleBuffer
            break
        }
        lock.unlock()
    }
}
