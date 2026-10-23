# TopSun-CUA (`CUA-Ghost`) 全仓系统架构图、数据流图（DFD/时序图）与 UML 设计规约

本文档对 [`topsun-cua`](../README.md) 仓库进行全栈软件工程建模，涵盖：
1. **五层全域系统架构图（System Architecture Diagram）**
2. **核心数据流图（Data Flow Diagrams, DFD Layer 0 / Layer 1）与端到端交互时序图（Sequence Diagram）**
3. **核心模块 UML 类图（Class Diagram）与并发状态机图（State Machine Diagram）**

---

## 一、 全仓五层系统架构图（System Architecture）

`topsun-cua` 采用 **“上层零 Token 认知编译 + 中层强契约跨语言安全门禁 + 底层 OS 合成器无感劫持 + 跨平台云主机虚拟化底座”** 的五层解耦架构：

```mermaid
flowchart TB
    subgraph L1["Layer 1: 智能体编排与三位一体工具链层 (Agentic Orchestration & Toolchain Triad)"]
        A1["ToolchainTriadOrchestrator<br/>(lark-cli 飞书 | gh GitHub | kimi-cu GUI)"]
        A2["CUA-S1 / Cloud Teacher LLM<br/>(libs/cua-s1 & libs/cuabot)"]
        A3["Cua Bench & 12-Task Eval Suite<br/>(libs/cua-bench & evaluate_kimicu_vs_codex.py)"]
    end

    subgraph L2["Layer 2: CUA-Ghost 零 Token 认知编译与双引擎自适应路由层 (libs/zero-token-ghost-engine)"]
        B1["HybridComputerUseRouter<br/>(Kimi-CU 100% 精度通道 vs Codex Sky 30-40ms 极速通道)"]
        B2["AXTreeSessionDiffEngine<br/>(4000-Node DFS + 行级增量 Diff + snapshot_id 乐观锁)"]
        B3["ZeroTokenSkillRuntime (NodeRepl V8 沙箱)<br/>(Unix Socket 零 Token 循环 & .mjs 技能固化回放)"]
    end

    subgraph L3["Layer 3: 跨语言契约、授权门禁与核心驱动运行时 (libs/cua-driver/rust/crates/cua-driver-*)"]
        C1["cua-driver-contract<br/>(ToolInput / ClickInput / ActionTarget / JSON Schema)"]
        C2["cua-driver-core::tool::ToolRegistry<br/>(DISPATCH_AUTHORIZATION_CONTEXT / 单飞锁 / 录制回放)"]
        C3["cua-driver-core::capture_registry<br/>(CaptureId / ScreenshotToActionTransform 仿射变换)"]
        C4["cua-cursor-motion<br/>(Dubins / Fitts / SignatureArc 虚拟光标轨迹规划)"]
        C5["cua-driver-sdk (UniFFI)<br/>(Python / TypeScript / Rust / MCP Wire 绑定)"]
    end

    subgraph L4["Layer 4: 操作系统原生适配与底层合成器劫持层 (Platform Adapters & OS Hijack)"]
        direction LR
        subgraph MacOS["macOS 幽灵劫持引擎 (platform-macos + SkyLightGhostBridge)"]
            M1["ClickTool / SetValueTool / PressKeyTool"]
            M2["WindowPxFrame (1x/2x Retina 校验) & PixelClickRoute"]
            M3["FocusGuard / WindowChangeDetector / KeyFocusGuard"]
            M4["SkyLight 私有 SPI (dlopen)<br/>9字段路由 (0x5b/0x5c) + 28pt Cmd-Click + 248B SLSEventRecord"]
            M5["SignedKeyboard (SLSEventAuthenticationMessage)<br/>+ 10 FPS SCStream 反遮挡渲染保活"]
        end
        subgraph Linux["Linux 合成器适配 (platform-linux)"]
            L_1["AT-SPI2 语义树 + X11 XTest"]
            L_2["wayland-helper / hyprland-plugin / kwin-target-helper"]
        end
        subgraph Windows["Windows 桌面适配 (platform-windows)"]
            W_1["cua-driver-uia (UIAutomation 快照)"]
            W_2["Win32 PostMessage / SendInput / WGC / VirtualDesk"]
        end
    end

    subgraph L5["Layer 5: 本地与云主机无缝虚拟化底座 (Virtualization & Cloud Host Substrate)"]
        V1["libs/lume & lumier<br/>(Apple Virtualization.framework macOS/Linux VM)"]
        V2["libs/cua-spacesd & apps/cua-spaces-macos<br/>(Space 守护进程 / Keyvault 会话 Teleport)"]
        V3["libs/fleet & kasm & xfce-cua & qemu-docker<br/>(云端容器集群 / Xvfb / WebRTC / SSH-VSOCK 隧道)"]
    end

    L1 --> L2
    L2 --> L3
    L3 --> L4
    L4 --> L5
```

---

## 二、 核心数据流图（Data Flow Diagrams & Sequence Diagrams）

### 2.1 数据流图一：零 Token 感知差分 $\rightarrow$ 动作编译 $\rightarrow$ 固化技能回放闭环（DFD）

展示数据如何从 OS 原始帧缓冲与无障碍树，经过三级数据压缩，将单步 `2,400+ Vision Tokens` 降维至 `60~150 Diff Tokens` 乃至 `0 Token` 本地回放：

```mermaid
flowchart LR
    subgraph OS["OS 原始状态源"]
        O1[("AXUIElement 树<br/>(Electron AXManualAccessibility)")]
        O2[("ScreenCaptureKit<br/>(SCWindow 独立帧缓冲)")]
    end

    subgraph Perception["1. 感知降维管线"]
        P1["限界 DFS 采样器<br/>(≤4000 节点, ≤64 层, ≤2MiB)"]
        P2["AXTreeSessionDiffEngine<br/>(比对 base_revision 生成 + / ~ / - 行)"]
        P3["局部原生裁剪器<br/>(rect={x,y,w,h} 1:1 裁剪)"]
    end

    subgraph Compiler["2. 认知编译与 V8 沙箱"]
        C1["Cloud Teacher LLM<br/>(仅首轮介入一次)"]
        C2["ZeroTokenSkillRuntime<br/>(vm.createContext 持久沙箱)"]
        C3[(".solidified_skills/*.mjs<br/>固化技能仓库")]
    end

    subgraph IPC["3. 本地/云端高速执行"]
        I1["Unix Domain Socket / VSOCK<br/>(JSON-RPC 0-Token 循环)"]
    end

    O1 --> P1 --> P2
    O2 -->|"仅在无 AX 序号 Canvas 时触发"| P3
    P2 -->|"~60-150 Text Tokens<br/>(节省 85%-95%)"| C1
    P3 -->|"局部小图"| C1
    C1 -->|"编译多步 JS 状态机代码"| C2
    C2 <-->|"0 中间 LLM Token<br/>亚毫秒级循环读写"| I1
    C2 -->|"验证通过后持久化"| C3
    C3 -->|"后续同类任务直接加载<br/>(100% 0-Token)"| C2
```

### 2.2 数据流图二：多模态坐标空间逆变换流水线（Coordinate Transformation Pipeline）

展示一次点击请求中的坐标数据如何在 **5 个几何空间** 之间流转与验证：

```mermaid
flowchart LR
    S1["1. 模型观测坐标空间<br/>Screenshot Pixel (sx_shot, sy_shot)<br/>或 Element Token (s<hash>:idx)"]
    S2["2. 捕获仿射逆变换空间<br/>ScreenshotToActionTransform::apply<br/>或 zoom_to_window / screenshot_scale"]
    S3["3. 窗口原生捕获像素空间<br/>Native Window Capture Px (cx, cy)"]
    S4["4. WindowPxFrame 1x/2x 验证与拆分<br/>lx = cx / scale, ly = cy / scale<br/>sx = bounds.x + lx, sy = bounds.y + ly"]
    S5A["5A. 逻辑屏幕绝对坐标<br/>Screen Logical Pt (screen_x, screen_y)<br/>→ 供 SkyLight 9字段路由 & 虚拟光标动画"]
    S5B["5B. 窗口局部逻辑坐标<br/>Window-Local Logical Pt (win_local_x, win_local_y)<br/>→ 供公开 postToPid 的 CGEventSetWindowLocation"]

    S1 --> S2 --> S3 --> S4
    S4 --> S5A
    S4 --> S5B
```

### 2.3 端到端交互时序图（Sequence Diagram：后台窗口点击完整流转）

```mermaid
sequenceDiagram
    autonumber
    participant Agent as Agent / NodeRepl Sandbox
    participant Router as HybridComputerUseRouter
    participant Core as ToolRegistry & ActionTarget
    participant Click as ClickTool (platform-macos)
    participant Frame as CaptureRegistry & WindowPxFrame
    participant Guard as FocusGuard & WindowChangeDetector
    participant Sky as SkyLight / mouse.rs / SkyLightGhostBridge
    participant Target as 目标后台窗口 (Chrome / Feishu)

    Agent->>Router: 发起点击请求 (pid, window_id, x, y, capture_id / snapshot_id)
    Router->>Router: 判定通道 (多窗口/Canvas → Kimi-CU 精确通道; 单窗口原生连点 → Sky IPC)
    Router->>Core: 调用 ToolRegistry::invoke("click", args)
    Core->>Core: normalize_action_target(args) & enforce_delivery_target()
    Core->>Click: ClickTool::invoke(normalized_args)

    alt 携带 capture_id / x, y 像素路径
        Click->>Frame: admit_window_click(capture_id, pid, wid, cx, cy)
        Frame-->>Click: 返回逆变换后的窗口原生像素 (cx, cy)
        Click->>Frame: px_frame::resolve_or_refuse(wid)
        Frame->>Frame: 实时截取 PNG 校验 1x/2x Retina scale (±0.03)
        Frame-->>Click: 返回 (screen_x, screen_y, win_local_x, win_local_y)
        Click->>Click: 校验 0 <= lx <= width 且非 Chromium <select>
    else 携带 element_token 语义路径
        Click->>Click: snapshots.resolve(pid) → element_screen_center(el)
    end

    Click->>Click: gate_background_window_action(pid, wid) 获取进程级互斥租约
    Click->>Sky: element_at_screen_position(pid, screen_x, screen_y) 尝试后台 AXPress 捷径
    alt AX 捷径未命中，进入后台像素路由 (PixelClickRoute::BackgroundPid)
        Click->>Guard: WindowChangeDetector::snapshot_allowing_activation(prior_front, pid)
        Click->>Guard: key_focus_guard::protect(pid) 锁定用户当前 Key Window
        Click->>Sky: prepare_background_pixel_click(pid, wid)
        Sky->>Target: SLPSPostEventRecordTo(248字节 SLSEventRecord, 0x0d) + kCPSNoWindows(0x400)
        Click->>Sky: click_at_xy_with_window_local (Chromium 5步序列)
        Sky->>Target: 1. Move(screen_target, f0=2) → 2. Down/Up(-1,-1, f0=1/2) → 3. Down/Up(screen_target, f0=3/3)<br/>烙印 f40=pid, f51/f91/f92=wid, f58=clickGroupID, 顶部28pt加 Cmd 掩码
        Click->>Guard: restore_user_focus_after_background_pixel() 恢复用户前台焦点
    end
    Click->>Guard: finish_window_observation(snapshot) 汇总窗口变化与读回结果
    Click-->>Agent: 返回 ToolResult { ok, path, verified, effect }
```

---

## 三、 核心模块 UML 设计图（Class Diagram & State Machine Diagram）

### 3.1 全栈核心类图（UML Class Diagram）

```mermaid
classDiagram
    direction TB

    class ToolInput {
        <<interface>>
        +TOOL_NAME: &'static str
        +validate() Result~(), String~
        +input_schema() Value
    }

    class ClickInput {
        +target: ActionTarget
        +position: ClickPosition
        +delivery_mode: InputDeliveryMode
        +session: Option~String~
        +button: Option~ClickButton~
        +count: Option~u32~
        +validate() Result~(), String~
    }

    class ClickPosition {
        <<enumeration>>
        Coordinates(x: f64, y: f64)
        Element(element_token: String)
        CapturedCoordinates(x: f64, y: f64, capture_id: String)
    }

    class ActionTarget {
        <<enumeration>>
        Window(pid: u32, window_id: u64)
        Desktop(display_id: String)
    }

    class Tool {
        <<interface>>
        +def() ToolDef
        +invoke(args: Value) ToolResult
    }

    class ToolState {
        +snapshots: SnapshotStore
        +capture_bindings: CaptureBindings
        +cursor_registry: CursorRegistry
        +session_config: SessionConfig
    }

    class CaptureRegistry {
        -entries: HashMap~CaptureId, StoredCapture~
        +store_capture(...) Result~CaptureId, CaptureStoreError~
        +admit_window_click(capture_id, pid, wid, x, y) Result~(f64, f64), ToolResult~
        +prune_expired()
    }

    class ScreenshotToActionTransform {
        +m11: f64
        +m12: f64
        +m21: f64
        +m22: f64
        +tx: f64
        +ty: f64
        +apply(x: f64, y: f64) (f64, f64)
    }

    class ClickTool {
        -state: Arc~ToolState~
        +invoke(args: Value) ToolResult
    }

    class WindowPxFrame {
        +bounds: WindowBounds
        +scale: f64
        +to_screen(cx: f64, cy: f64) (f64, f64, f64, f64)
    }

    class PixelClickRoute {
        <<enumeration>>
        ForegroundHid
        BackgroundPid
        RefuseBackground(PointerReadingToolkit)
    }

    class SkyLightPrivateSPI {
        +shared: SkyLightPrivateSPI
        +kCGEventFieldWindowIDPrimary: CGEventField = 0x5B
        +kCGEventFieldWindowIDSecondary: CGEventField = 0x5C
        +kCPSNoWindows: UInt32 = 0x400
        +spoofBackgroundKeyFocus(pid: pid_t, windowID: UInt32, activate: Bool) Bool
        +stampBackgroundWindowFields(event: CGEvent, windowID: UInt32, screenPoint: CGPoint, windowLocalPoint: CGPoint)
        +postSignedKeyboardEvent(pid: pid_t, event: CGEvent, isKeyDown: Bool) Bool
        +activateElectronAccessibility(pid: pid_t)
    }

    class AntiOcclusionRenderKeepAlive {
        -activeStreams: Dictionary~UInt32, SCStream~
        +acquireKeepAliveLease(windowID: UInt32)
        +releaseKeepAliveLease(windowID: UInt32)
    }

    class HybridComputerUseRouter {
        +select_route(req: GUIActionRequest) RoutingDecision
    }

    class AXTreeSessionDiffEngine {
        +maxNodes: Int = 4000
        +maxDepth: Int = 64
        -sessions: Map~String, SessionState~
        +observe(bundleId, windowId, rawTreeText, disableDiff) DiffResult
        +verifySnapshotLock(bundleId, windowId, snapshotId) Bool
    }

    class ZeroTokenSkillRuntime {
        -persistentContext: vm.Context
        -skillCacheDir: String
        +executeCell(code: String) ExecutionResult
        +solidifySkill(skillName: String, compiledJsCode: String) SkillArtifact
        +replaySolidifiedSkill(skillName: String, params: Object) ExecutionResult
    }

    ToolInput <|.. ClickInput
    ClickInput *-- ClickPosition
    ClickInput *-- ActionTarget
    Tool <|.. ClickTool
    ClickTool o-- ToolState
    ToolState *-- CaptureRegistry
    CaptureRegistry *-- ScreenshotToActionTransform
    ClickTool ..> WindowPxFrame : resolves coordinates
    ClickTool ..> PixelClickRoute : selects transport
    ClickTool ..> SkyLightPrivateSPI : dispatches background input
    HybridComputerUseRouter ..> ClickTool : routes verified actions
    ZeroTokenSkillRuntime ..> AXTreeSessionDiffEngine : validates snapshot_id
    SkyLightPrivateSPI ..> AntiOcclusionRenderKeepAlive : pairs with 10FPS SCStream
```

### 3.2 鼠标点击与并发快照锁状态机图（UML State Diagram）

```mermaid
stateDiagram-v2
    [*] --> Idle

    Idle --> Observed : get_window_state / get_app_state<br/>签发 snapshot_id & capture_id
    Observed --> ValidatingTarget : 收到 click 请求<br/>normalize_action_target()

    state ValidatingTarget {
        [*] --> CheckLock
        CheckLock --> LockRejected : snapshot_id 或 capture_id 过期/不匹配
        CheckLock --> CheckGeometry : 快照锁通过
        CheckGeometry --> GeometryRejected : WindowNotFound / FrameMismatch (非 1x/2x)<br/>或局部坐标越界 (lx < 0 || lx > width)
        CheckGeometry --> CheckSelectGuard : 几何校验通过
        CheckSelectGuard --> SelectRejected : 后台点击 Chromium <select> (防弹窗提权)
        CheckSelectGuard --> TargetAdmitted : 通过 gate_background_window_action 互斥门禁
    }

    LockRejected --> [*] : 返回 stale_snapshot / invalid_capture 错误 (Fail-Closed)
    GeometryRejected --> [*] : 返回 px_frame_mismatch / out_of_bounds 错误
    SelectRejected --> [*] : 返回 select_menu_would_raise_window (引导改用 set_value)

    TargetAdmitted --> AXSemanticPath : 寻址为 element_token<br/>或像素点命中 AXUIElement (AXPress)
    TargetAdmitted --> SkyIPCBurstPath : HybridRouter 判定为单窗口稳定原生连点
    TargetAdmitted --> BackgroundPixelPath : 无 AX 序号的 Canvas / Web / 多窗口像素点击
    TargetAdmitted --> ForegroundHIDPath : delivery_mode == "foreground" 或 scope == "desktop"

    AXSemanticPath --> ReadbackVerification : AXUIElementPerformAction("AXPress")
    SkyIPCBurstPath --> Completed : SkyComputerUseService 30-40ms 极速派发

    state BackgroundPixelPath {
        [*] --> FocusPrologue
        FocusPrologue --> ChromiumFiveStepStream : SLPSPostEventRecordTo (248B 0x0d)<br/>+ SLPSSetFrontProcessWithOptions(kCPSNoWindows=0x400)
        ChromiumFiveStepStream --> RestoreUserKeyFocus : 1. Move(target) → 2. Down/Up(-1,-1)<br/>→ 3. Down/Up(target, 9字段烙印 + 28pt Cmd保护)
        RestoreUserKeyFocus --> [*] : restore_user_focus_after_background_pixel()
    }

    BackgroundPixelPath --> ReadbackVerification
    ForegroundHIDPath --> ReadbackVerification : CGDisplay::warp + HID Tap + 恢复原前台进程

    state ReadbackVerification {
        [*] --> PollAXState
        PollAXState --> VerifiedConfirmed : Toggle/Row AXValue 或 AXSelected 改变并稳定 250ms
        PollAXState --> SuspectedNoop : 元素未声明 AXPress 且无状态变化 (建议切换 px)
        PollAXState --> UnverifiableDelivered : 像素点击已投递，交由下次差分观测确认
    }

    VerifiedConfirmed --> Completed
    SuspectedNoop --> Completed
    UnverifiableDelivered --> Completed
    Completed --> [*] : 轨迹验证通过后可固化为 .mjs 0-Token 技能
```


---

## 五、 全局入口地图 (Global Entrypoint Map)

```mermaid
flowchart LR
    subgraph ZeroTokenEntries["1. Zero-Token 幽灵引擎入口 (Python / Node.js / Swift)"]
        E1["hybrid_cu_router.py\n(双轨路由 & Triad 编排器)"]
        E2["zero_token_compiler.mjs\n(AX 差分压缩 & QuickJS 固化)"]
        E3["evaluate_kimicu_vs_codex.py\n(12 项黄金基准评测入口)"]
        E4["SkyLightGhostBridge.swift\n(macOS SkyLight SPI 动态库入口)"]
    end

    subgraph DriverEntries["2. CUA-Driver 核心守护进程与 MCP 入口 (Rust)"]
        D1["cua-driver/src/main.rs\n(cua-driver 统一二进制主入口)"]
        D2["cua-driver/src/serve.rs\n(serve 守护进程 Unix Socket/Pipe)"]
        D3["cua-driver/src/proxy.rs\n(mcp stdio JSON-RPC 代理)"]
        D4["cua-driver/src/mcp_http.rs\n(HTTP MCP 服务端)"]
        D5["cua-driver/src/private_worker.rs\n(AppKit 主线程隔离 Worker)"]
        D1 --> D2
        D1 --> D3
        D1 --> D4
        D1 --> D5
    end

    subgraph CloudAndAgentEntries["3. 云主机/虚拟化与 Agent CLI 入口"]
        C1["cua-cli/src/main.rs\n(cua 全局 CLI 入口)"]
        C2["cua-spacesd/src/main.rs\n(云工作区守护进程)"]
        C3["cua-relay/src/main.rs\n(云端流媒体/控制中继)"]
        C4["cua-spaces-macos/main.swift\n(macOS 原生多工作区宿主 App)"]
        C5["cua_agent/cli.py\n(Python Agent CLI 入口)"]
        C6["cua_s1/server.py\n(CUA-S1 视觉模型推理服务)"]
    end
```

---

## 六、 横切机制、扩展指南与领域避坑指南

详见主会话技术剖析报告。
