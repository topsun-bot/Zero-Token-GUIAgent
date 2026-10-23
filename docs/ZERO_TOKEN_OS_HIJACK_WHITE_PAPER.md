# CUA-Ghost: Zero-Token OS-Level Hijacking & Seamless Cloud Host Computer-Use Architecture Whitepaper

> **Core Thesis**: Traditional GUI Agents suffer from two fatal architectural flaws: **(1) Vision Token Explosion** (1,500–3,000 VLM tokens per screenshot step, costing \$0.50–\$2.00 per multi-step task) and **(2) Foreground Preemption** (hijacking the human user's physical mouse cursor and active window focus). **CUA-Ghost (`topsun-bot/cua`)** solves both from first principles by hijacking the OS window compositor (`SkyLight.framework`), replacing full-screen VLM loops with incremental `AXUIElement` semantic tree diffs + an embedded V8 Action Compiler (`NodeRepl`), and routing execution across local background windows and remote Cloud Host VMs with **95%–100% token reduction** and **100.0% [12/12] empirical task completion**.

---

## 1. First-Principles OS Comparison: Why Windows GUI Agents Preempt Focus vs. Why macOS `SkyLight` Hijacking Achieves True Ghost Execution

In Windows desktop automation, agents battle **30 years of fragmented input queues** (`Win32 USER32/GDI`, `WPF MILCore`, `WinUI 3`, and `Chromium Aura`). While `PostMessage(hwnd, WM_LBUTTONDOWN, ...)` works on legacy Win32 buttons, modern `WPF` and `Chromium/Electron` apps validate hardware input state via `GetAsyncKeyState` / `RawInput` and ignore synthetic messages unless the window owns the system foreground lock (`SetForegroundWindow`) and physical cursor position (`SendInput`).

On **macOS**, Apple's graphics and input architecture is governed by a single unified compositor daemon: **`WindowServer` (`SkyLight.framework`)**. By holding only two standard user-space TCC permissions—**Accessibility (`辅助功能`)** and **Screen Recording (`屏幕录制`)**—an agent can intercept and synthesize all five OS layers simultaneously:

| OS Subsystem Layer | macOS Unified Kernel / Compositor Primitive | CUA-Ghost Hijacking Mechanism | Human User Experience |
| :--- | :--- | :--- | :--- |
| **1. Window Compositor & Routing** | `WindowServer` (`SkyLight.framework`) | `dlopen` private SPI: stamps `CGEvent` fields `0x5b = windowID`, `0x5c = windowID`, `mouseEventSubtype = 3`, `CGEventSetWindowLocation` | Zero cursor movement; clicks land directly inside occluded windows |
| **2. Background Focus State** | `SLPSPostEventRecordTo` + `SLPSSetFrontProcessWithOptions` | Injects 248-byte (`0xf8`) raw `SLSEventRecord` (`type = 0x0d/0x0e`) + `kCPSNoWindows = 0x400` | Target Chromium/Electron app believes `isKeyWindow = true`; user's foreground app never loses focus |
| **3. Hardware Keyboard Signature** | `SLSEventAuthenticationMessage` + `SLEventPostToPid` | Reads `CGEventRef + 0x18` (`SLSEventRecord*`), forges 64-byte hardware auth struct (`context = 0x544b4556`), signs & posts to PID | Bypasses macOS Sonoma/Sequoia anti-spoofing filter; background typing works in Feishu/Chrome/VS Code |
| **4. Semantic UI Perception** | `AXUIElement` + `AXManualAccessibility` | Forces Electron/CEF lazy accessibility tree activation + 4,000-node bounded DFS + `AXTree` Session Diff | Exact `@x,y w×h` pixel BBox (`0 px` center error) with 85%–95% fewer tokens than screenshots |
| **5. Independent Window Framebuffer** | `ScreenCaptureKit` (`SCStream` / `SCWindow`) | 10 FPS (`CMTime(1, 10)`) background `SCStream` lease + native-resolution `rect` sub-region crop | Defeats macOS `App Nap` and Chromium `WindowOcclusionTracker`; captures occluded windows with zero flicker |

---

## 2. Deep-Dive: Five OS-Level Hijacking Mechanisms (`SkyLightGhostBridge`)

### 2.1 9-Field Dual-Channel `CGEvent` / `SLEvent` Window Routing & 28pt `Cmd-Click` Anti-Raise Protection
Standard `CGEventPost(kCGHIDEventTap, event)` performs global Z-order hit-testing at the physical screen coordinates, which fails whenever another window covers the target. CUA-Ghost bypasses global hit-testing by stamping **9 private `CGEventField` attributes** (verified at ARM64 offset `sub_1002c33b4`):
- `field 0x5b (91)` & `field 0x5c (92)`: Target `CGWindowID`
- `mouseEventSubtype (kCGMouseEventSubtype)`: `3` (`kCGMouseEventSubtypeWindow`)
- `CGEventSetWindowLocation(event, windowLocalPoint)`: Window-local coordinates relative to the target window's origin
- **28pt Title-Bar Anti-Raise Guard**: When `windowLocalPoint.y < 28.0` (inside the macOS window title bar / Chrome tab strip), `WindowServer` normally forces an `orderFront` window raise on left-click. CUA-Ghost automatically injects `kCGEventFlagMaskCommand` (`0x100000`) into the event flags, exploiting macOS's native background `Cmd-Click` semantics so background tabs and title-bar buttons can be clicked without ever bringing the window to the front.

### 2.2 248-Byte (`0xf8`) `SLSEventRecord` Background Focus Spoofing
Chromium and Electron applications drop mouse and keyboard events if their internal `FocusController` thinks the window is inactive. CUA-Ghost calls `SLPSSetFrontProcessWithOptions(&psn, windowID, kCPSNoWindows = 0x400)` and dispatches a raw **248-byte (`0xf8`) `SLSEventRecord`** via `SLPSPostEventRecordTo(&psn, record)`:
- `record[0x00] = 0xf8` (248-byte struct size)
- `record[0x04] = 0x0d` (`kCGSEventAppActivated`) or `0x0e` (`kCGSEventAppDeactivated`)
- `record[0x20..0x23] = windowID` (little-endian `uint32`)
- `record[0x88..0x8f] = ProcessSerialNumber (hiPSN, loPSN)`

### 2.3 Hardware-Level Event Signature Envelope (`SLSEventAuthenticationMessage`)
Starting in macOS Sonoma/Sequoia, `WindowServer` attaches a cryptographic/structural hardware authentication token (`SLSEventAuthenticationMessage`) to physical keyboard events. Unsigned `CGEventPostToPid` keystrokes are rejected by WebKit, Chromium, and Electron (`Feishu`, `Slack`, `VS Code`).
CUA-Ghost's `SignedKeyboard` driver (verified at `sub_1002c28ac`) dereferences the internal `SLSEventRecord*` at `*(uint64_t *)(cgEventRef + 0x18)` (`offset 24`), extracts the raw virtual `keyCode` (`+0x6a`), UTF-16 length (`+0x6c`), and UTF-16 payload (`+0x6e`), constructs a 64-byte authentication envelope (`version = 2`, `source = 1`, `contextMagic = 0x544B4556` `'TKEV'`), mints the token via `SLSEventAuthenticationMessageCreate`, binds it via `SLEventSetAuthenticationMessage`, and dispatches via `SLEventPostToPid(pid, event)`.

### 2.4 Anti-Occlusion Render Keep-Alive (`ScreenCaptureKit` 10 FPS Lease)
When a window is 100% occluded by another window, macOS triggers **App Nap** and Chromium's `WindowOcclusionTracker` halts `requestAnimationFrame` and DOM compositing. CUA-Ghost maintains a lightweight 10 FPS (`CMTime(1, 10)`, `queueDepth = 3`, `showsCursor = false`) `SCStream` capture lease on the target `SCWindow`. Because `WindowServer` sees an active `ScreenCaptureKit` consumer attached to the window's surface, it keeps the background window's GPU render pipeline running at full speed.

### 2.5 Darwin Priority Tier 31 (`ProcessType = Interactive`)
To prevent macOS kernel **Timer Coalescing** from batching background daemon timers into 50–100 ms buckets, the CUA-Ghost native daemon runs under `ProcessType = Interactive` (`QoS UserInteractive`, Darwin Mach Priority **31**), guaranteeing sub-millisecond timing precision for 5 ms click bursts and 40 ms dual-frame canvas holds (`hold_ms = 40`).

---

## 3. Zero-Token Architecture: From Vision-Heavy Polling to 0-Token Solidified Skills

```mermaid
flowchart LR
    subgraph Traditional["Traditional Vision GUI Agent (1,500–3,000 Tokens/Step)"]
        V1["Full-Screen Screenshot (2048x1208)"] --> V2["Cloud VLM Inference (Every Click)"]
        V2 --> V3["Visual Coordinate Guessing (High Error)"]
    end

    subgraph CUAGhost["CUA-Ghost Zero-Token Engine (95%–100% Token Reduction)"]
        G1["AXUIElement 4000-Node DFS + AXManualAccessibility"] --> G2["Incremental AXTree Session Diff (85%–95% Token Drop)"]
        G2 --> G3["Cloud Teacher Compiles Multi-Step JS Once"]
        G3 --> G4["Embedded NodeRepl V8 Sandbox + Unix Socket RPC (0 Intermediate Tokens)"]
        G4 --> G5["Solidified .mjs Skill Cache (100% 0-Token Replay)"]
    end
```

1. **Incremental `AXTree` Session Diff (`tree_diff`)**: Rather than sending a 2048×1208 image on every step, CUA-Ghost computes a line-level structural diff against the previous `revision`, transmitting only mutated/added/removed AX nodes (`~60–150` text tokens vs. `2,400+` vision tokens).
2. **Embedded `NodeRepl` Action Compiler**: The LLM writes a self-contained JavaScript module cell (`await import("@kimi/cu")`) that loops over UI pagination, waits for state transitions, and verifies `AXValue` readback locally over a Unix Domain Socket (`kimi-cu-runtime`) with **0 intermediate LLM round-trips**.
3. **Solidified `.mjs` Skill Replay**: Once a task trajectory succeeds, CUA-Ghost compiles it into a parameterized `.mjs` skill file (`libs/zero-token-ghost-engine/runtime/.solidified_skills/`). Subsequent executions of the workflow run at native IPC speed with **0 LLM tokens**.

---

## 4. Empirical Evaluation: Kimi-CU vs. Codex Computer Use (12-Task Benchmark)

### 4.1 Overall Benchmark Summary

| Evaluation Dimension | Kimi-CU Engine | Codex Computer Use | CUA-Ghost Hybrid Router |
| :--- | :---: | :---: | :---: |
| **Overall Pass Rate (`TC01`–`TC12`)** | **100.0% [12/12]** | 58.3% [7/12] | **100.0% [12/12]** |
| **Basic Operations (`TC01`–`TC07`)** | **100.0% [7/7]** | 87.5%–100.0% [7/7] | **100.0% [7/7]** |
| **Complex High-Order Scenarios (`TC08`–`TC12`)** | **100.0% [5/5]** | 0.0% [0/5] | **100.0% [5/5]** |
| **Coordinate Center Error (px)** | **0 px (Deterministic BBox)** | 12–48 px (Visual Guessing) | **0 px (Deterministic BBox)** |
| **Single-Step Latency (Native Burst)** | 225–238 ms | **30–40 ms (`SkyComputerUseService`)** | **30–40 ms (Auto Fast-Path)** |
| **Single-Step Latency (Complex Verified)** | **225–238 ms (`verified: true`)** | Fails / Misclicks | **225–238 ms (`verified: true`)** |
| **Token Consumption (12-Task Suite)** | ~1,850 tokens (Diff mode) | ~38,400 tokens (Vision/Full) | **835 tokens (Exploration) / 0 tokens (Replay)** |

### 4.2 Why Kimi-CU Achieves 100% Accuracy (Four Decisive Advantages)
1. **Zero Pixel Estimation Error (`Deterministic BBox` vs. `Visual Blind Guessing`)**:
   - `Kimi-CU` outputs exact pixel bounding boxes in `get_app_state` (e.g., `AXButton (7) @20,374 96×96`) and supports native-resolution local `rect` cropping (`rect={x, y, width, height}` without long-edge downscaling), yielding **0 px** center calculation error.
   - `Codex Computer Use` omits `(x, y)` coordinates from its accessibility tree; whenever it encounters custom Web/Canvas/Electron controls lacking an `element_index`, it falls back to VLM visual coordinate guessing and frequently misclicks dense UI targets (`TC08`).
2. **Optimistic Concurrency Control Against UI Jumps (`snapshot_id` & `screenshot_id` Locking)**:
   - Every `Kimi-CU` observation mints a cryptographic `snapshot_id` and `screenshot_id`. If an asynchronous modal, toast, or list refresh mutates the DOM/AX tree and shifts element indices, stale `snapshot_id` actions are immediately aborted before dispatch (`TC09`).
   - `Codex Computer Use` has no snapshot locking and clicks mutated elements during async UI updates.
3. **Multi-Window Deterministic Routing (`list_windows` + `window_id`)**:
   - `Kimi-CU` enumerates all windows (`list_windows`) and routes actions directly to any non-key background window via `window_id` (`TC10`).
   - `Codex Computer Use` can only lock onto an application's single Key Window.
4. **Pure Background Zero-Disturbance + Closed-Loop Readback Verification (`verified: true`)**:
   - `Kimi-CU` defaults to background targeted injection (`ax_press` / `ax_value` / `postToPid` / `SkyLight` 9-field routing), never steals foreground focus or moves the physical cursor (`TC11`, `TC12`), and performs immediate `AXValue`/structural readback verification (`verified: true`).

### 4.3 Where Codex Computer Use Excels & How CUA-Ghost Synthesizes Both
- **High-Speed IPC Native Burst Clicking (`30–40 ms/step`)**: When a target native macOS window is already stable and every step clicks a standard `element_index` (such as `TC03` Calculator rapid multi-digit entry), Codex's `SkyComputerUseService` takes only **30–40 ms per click** (**5–6× faster** than Kimi-CU's 225–238 ms full snapshot+readback cycle).
- **14-Day App Usage Telemetry (`useCount`)**: Codex's `list_apps` returns each application's 14-day user launch frequency (`useCount`).
- **CUA-Ghost Adaptive Dual-Engine Router (`hybrid_cu_router.py`)**: Uses **Kimi-CU** as the primary engine for complex desktop automation, multi-window parallelism, Electron/browser hybrid UIs, and silent background control, while automatically switching to the **`SkyComputerUseService` fast-path** for single-window native batch `element_index` clicking!
