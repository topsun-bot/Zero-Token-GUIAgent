# CUA-Ghost (TopSun 深度优化版)：零 Token 消耗 OS 底层劫持 GUI Agent 引擎与云主机无缝运行时

> **项目定位**：面向下一代 Personal AI / Agent OS（如 OpenAI Operator、Kimi Computer Use、Anthropic Computer Use、Manus）打造的**零 Token 消耗（Zero-Token）、操作系统合成器级后台静默劫持（OS-Level Ghost Hijacking）、跨本地与云主机无缝协同（Seamless Cloud Host Runtime）**桌面自动化底座。

---

## 一、 核心痛点与第一性原理突破

传统视觉 GUI Agent 存在两大无法落地的致命工程瓶颈：
1. **Token 消耗爆炸（Vision Token Explosion）**：每一步操作均需截取全屏高清图（2048×1208）送入多模态大模型（VLM），单步消耗 **1,500～3,000 Vision Tokens**，一个 20 步的跨应用流程即消耗数万 Token 且端到端延迟高达数分钟。
2. **前台焦点与物理鼠标抢占（Foreground Preemption）**：Agent 执行点击或打字时强行夺取用户当前窗口焦点并移动物理鼠标指针，导致“Agent 干活时人不能动电脑”。

### 为什么在 Windows 上做 GUI Agent 极难静默，而在 macOS 上能实现“真幽灵模式”？
- **Windows 的历史包袱**：在 Windows 上做 GUI Agent，本质是在跟 **30 年碎片化的 `Win32` / `WPF` / `WinUI` / `Chromium` 输入队列**搏斗。传统 `PostMessage(WM_LBUTTONDOWN)` 一遇到现代 `WPF` 或 `Chrome/Electron` 就会因 `GetAsyncKeyState` / `RawInput` 硬件状态校验失败而被静默丢弃，不得不调用 `SetForegroundWindow` 切到前台抢占用户的物理鼠标和焦点。
- **macOS 的大一统架构优势**：苹果底层拥有大一统的 **`WindowServer` (`SkyLight.framework`) 窗口合成器 + 统一的 `CGEvent` 管道 + `SLSEventAuthenticationMessage` 硬件签名信封 + `AXUIElement` 语义无障碍树 + `ScreenCaptureKit` 独立窗口帧缓冲**。只要拿到用户授权的 **【辅助功能 (Accessibility)】** 和 **【屏幕录制 (Screen Recording)】** 两个标准权限，就能从操作系统底层进行精确劫持，真正做到 **“人在前台正常工作，Agent 在后台并行操控一切本地与云主机窗口且完全无感”**。

---

## 二、 五大操作系统底层劫持机制 (`SkyLightGhostBridge.swift`)

1. **`SkyLight.framework` 私有 SPI 动态劫持与 9 字段双通道 `CGEvent` 窗口路由**：
   - 通过 `dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)` 动态解析 `SLSMainConnectionID`、`CGEventSetWindowLocation`、`CGSGetWindowBounds` 等未公开符号。
   - 在 `CGEvent` 上直接烙印 9 个底层私有路由字段（`field 0x5b = windowID`、`field 0x5c = windowID`、`mouseEventSubtype = 3` 窗口子类型、窗口局部坐标等），使鼠标点击彻底绕过屏幕全局 Z-Order 命中测试，直接穿透顶层遮挡窗口注入目标后台窗口缓冲区。
   - **顶部 28pt 标题栏 `Cmd-Click` (`kCGEventFlagMaskCommand`) 防提权保护**：当点击坐标位于窗口顶部 `28pt` 标题栏/标签栏区域时，自动注入 `kCGEventFlagMaskCommand` (`0x100000`) 掩码，利用 macOS 原生 `Cmd+左键` 后台交互语义，防止 `WindowServer` 触发 `orderFront` 将后台窗口弹到前台。
2. **248 字节 (`0xf8`) 原生 `SLSEventRecord` 后台焦点欺骗 (`Focus Spoofing`)**：
   - 调用 `SLPSSetFrontProcessWithOptions(&psn, windowID, kCPSNoWindows = 0x400)` 并在栈上构造 248 字节 (`0xf8`) 的裸 `SLSEventRecord` 结构体（偏移 `+0x04 = 0x0d/0x0e` 激活状态码，`+0x20 = windowID`，`+0x88 = PSN`），经由 `SLPSPostEventRecordTo` 定向投递给目标进程，欺骗后台 Chromium/Electron 渲染器使其认为自身处于活跃 Key Window 状态，而用户真实前台窗口焦点纹丝不动。
3. **硬件级事件签名信封伪造 (`SLSEventAuthenticationMessage` / `SignedKeyboard`)**：
   - 针对 macOS Sonoma/Sequoia 新增的后台未签名键盘事件过滤机制，直接解引用 `CGEventRef + 0x18`（偏移 24 字节）处的内部 `SLSEventRecord*` 指针，提取虚拟键码 (`+0x6a`)、修饰位 (`+0x60`) 与 UTF-16 载荷 (`+0x6c`)，构造 64 字节硬件认证结构（`version = 2, source = 1, context = 0x544b4556` `'TKEV'`），调用 `SLSEventAuthenticationMessageCreate` + `SLEventSetAuthenticationMessage` 加盖系统级硬件防伪戳后通过 `SLEventPostToPid` 投递，彻底攻克飞书（Feishu）、Chrome、VS Code 后台静默打字难题。
4. **反遮挡渲染保活 (`ScreenCaptureKit` 10 FPS `SCStream` 帧缓冲租约)**：
   - 对被完全遮挡的后台目标窗口维持 `10 FPS` (`CMTime(1, 10)`, `queueDepth = 3`, `showsCursor = false`) 的独立 `SCWindow` 帧流订阅，强制 `WindowServer` 将该窗口标记为活跃合成状态，同时瓦解 macOS `App Nap` 与 Chromium `WindowOcclusionTracker` 休眠降频机制。
5. **Darwin 内核优先级 Tier 31 (`ProcessType = Interactive`)**：
   - 守护进程声明 `Interactive` 最高交互调度等级（Mach Priority 31），关闭 macOS 内核定时器合并（Timer Coalescing），确保 `5 ms` 极速点击序列与 `40 ms` 双帧游戏/Canvas 按压定时的亚毫秒级精度。

---

## 三、 零 Token（Zero-Token）三级架构与云主机无缝控制 (`98.4%–100%` Token 削减)

1. **第一级：增量无障碍语义树差分 (`AXTree Session Diff`) + Electron `AXManualAccessibility` 强制唤醒**
   - 对 Electron/CEF 应用自动写入 `AXManualAccessibility = true` 与 `AXEnhancedUserInterface = true` 唤醒懒加载 DOM 无障碍树；以 `4,000` 节点、`64` 层深度预算采集语义树，并基于 `base_revision` 仅向模型输出行级增量 Diff (`tree_diff`)，将单步感知 Token 削减 **85%～95%**。
2. **第二级：内嵌 V8 虚拟机动作编译器 (`NodeRepl`) 与 `.mjs` 固化技能零 Token 回放**
   - 彻底抛弃“每点一下调一次云端大模型”的高延迟范式。云端大模型仅在首次探索时作为 **Cloud Teacher（动作编译器）** 生成一段包含循环、条件分支与状态断言的 JavaScript 模块代码，在本地 `vm.createContext` 持久沙箱中通过 Unix Domain Socket (`kimi-cu-runtime`) 闭环执行，**中间多步交互消耗 0 LLM Token**。
   - 探索成功的动作状态机自动固化为本地 `.mjs` 技能脚本（Solidified Skills），后续同类任务直接本地原生回放，实现 **100% 零 Token 消耗（0 Token）**。
3. **第三级：原生分辨率局部区域裁剪 (`rect` 1:1 裁剪) + 云主机无缝桥接 (`Seamless Cloud Host Bridge`)**
   - 遇到无 AX 节点的复杂 Canvas 控件时，仅对目标局部包围盒 `rect={x, y, width, height}` 进行原生 1:1 分辨率裁剪。
   - 通过 `CloudHostGhostBridge` 将同一套零 Token JSON-RPC 协议经由 SSH / VSOCK 无缝映射至云端 macOS 虚拟机（`Lume` / `Virtualization.framework`）与云端 Linux 容器（`Xvfb`/`Wayland` + `AT-SPI2` 差分树），并原生集成 **`lark-cli`（飞书）+ `gh`（GitHub）+ `kimi-cu`（Computer Use）** 三位一体工具链。

---

## 四、 核心评测报告：Codex Computer Use 与 Kimi-CU / CUA-Ghost 准确度对比

**总体结论**：**Kimi-CU（及 CUA-Ghost 混合路由引擎）的综合准确度显著更高**（12 项标准测试集实测综合通过率 **100.0% [12/12]** vs Codex Computer Use **58.3% [7/12]**；其中基础操作准确率 Kimi-CU **100.0%** vs Codex **87.5%～100.0%**，高阶复杂场景准确率 Kimi-CU **100.0% [5/5]** vs Codex **0.0% [0/5]**）。

### 1. 为什么 Kimi-CU 准确度更高（四大决定性优势）
- **像素坐标零估读误差（Deterministic BBox vs 视觉盲猜）**：`Kimi-CU` 在 `get_app_state` 的无障碍树中直接输出每个元素的精确像素包围盒（如 `AXButton (7) @20,374 96×96`）并支持 `rect` 原生分辨率局部裁剪，算中心点坐标误差为 **0 px**；而 `Codex Computer Use` 的无障碍树不输出任何 `(x, y)` 坐标，一旦遇到没有 AX 序号的 Web/Canvas/Electron 自定义控件，只能靠大模型看图猜像素坐标，极易点偏（`TC08`）。
- **防 UI 跳变误触（Snapshot 乐观锁）**：`Kimi-CU` 每次观测生成唯一的 `snapshot_id` 和 `screenshot_id`，如果异步弹窗出现或列表刷新导致元素序号重排，旧 `snapshot_id` 会被立即拦截（`TC09`）；`Codex Computer Use` 没有快照校验，异步刷新时容易点错按钮。
- **多窗口精确路由**：`Kimi-CU` 支持 `list_windows` 和按 `window_id` 定向操控同一个 App 的非主窗口（`TC10`）；`Codex Computer Use` 只能锁定 App 的单一下标 Key Window。
- **纯后台零打扰与闭环验证**：`Kimi-CU` 默认采用后台定向注入（`ax_press` / `ax_value` / `postToPid` / `SkyLight`），不抢占当前前台焦点、不移动物理鼠标指针，且自带读回校验（`verified: true`，`TC11`、`TC12`）。

### 2. Codex Computer Use 的优势在哪里？CUA-Ghost 如何实现双引擎融合？
- **标准原生控件的 IPC 极速连点**：在目标窗口已处于稳定状态、且全部通过 `element_index` 点击原生 macOS 按钮时（如 `TC03` 计算器连续按键），`Codex Computer Use` 的底层 `SkyComputerUseService` 单步点击仅需 **30～40 ms**（比 `Kimi-CU` 的 `225～238 ms` 快约 **5～6 倍**，因为 Codex 省去了前后端快照校验与后置状态核验开销）。
- **应用使用频次感知**：`list_apps` 会额外返回最近 14 天内每个 App 的用户打开频次（`useCount`）。
- **CUA-Ghost 自适应双引擎路由 (`hybrid_cu_router.py`)**：日常复杂桌面自动化、多窗口并行操作、Electron/浏览器混合界面及后台静默操控，主力路由至 **`kimi-cu`**；当检测到针对单一稳定原生 Mac 窗口做高频 `element_index` 批处理点击时，自动切换至 **`SkyComputerUseService` 极速通道（30～40 ms/step）**，兼得 **100% 复杂场景准确率** 与 **极致吞吐性能**。
