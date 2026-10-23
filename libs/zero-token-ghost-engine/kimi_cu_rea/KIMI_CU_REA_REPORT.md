# `kimi-cu` (Kimi Computer Use) 逆向工程与“零 Token 硬件自操作”创业可行性深度报告

> [!IMPORTANT]
> **核心结论先行**：
> 1. 你语音里说的 **“Kimi CEO”** 实际是 Kimi Code 安装时植入本机的原生 macOS 守护进程与 MCP 服务：**`kimi-cu` (Kimi Computer Use, v0.6.8)**，本体位于 [KimiCU.app](file:///Applications/KimiCU.app)。
> 2. **为什么 Codex 和 Claude Code 不用再调自己的 Computer Use？** 因为 `kimi-cu` 内置了 [`AgentIntegration`](file:///Users/zhang/Documents/huazhijian/outputs/kimi_cu_reverse/AgentIntegration.swift) 模块，安装时自动扫描本机并执行 `claude mcp add`、`codex mcp add`、`gemini mcp add`，把 [kimi-cu](file:///Applications/KimiCU.app/Contents/MacOS/kimi-cu) 注册为所有 CLI Agent 共享的**本地系统级手脚（MCP Server）**。
> 3. **最大认知纠偏（关乎能否拆公司）**：`kimi-cu` 二进制里**没有任何本地大模型或视觉模型（0 参数）**——它是一个**纯粹、极致的操作系统底层 GUI 驱动器 + 内嵌 JS 批处理沙盒**。它之所以让你感觉“几乎无 Token、极快、不抢鼠标”，是因为它用 **AX 无障碍树差分 (`tree_diff`) + JS 代码批处理 (`NodeRepl`) + macOS 私有 `SkyLight.framework` 后台注入** 替代了传统 Computer Use 极其昂贵的“每步全屏截图 → 云端 VLM 推理 → 抢占物理鼠标点击”死循环。

---

## 一、 为什么装了 Kimi Code，Codex 和 Claude Code 就自动拥有了它？

在反编译 [kimi-cu](file:///Applications/KimiCU.app/Contents/MacOS/kimi-cu) 的 `0x1002da400`–`0x1002dfa1c` 地址段（模块 [`kimi_cu.AgentIntegration`](file:///Users/zhang/Documents/huazhijian/outputs/kimi_cu_reverse/AgentIntegration.swift)）后，可以看到它硬编码了 5 个主流 Agent 的自动注入逻辑：

```mermaid
flowchart LR
    subgraph Agents["本机安装的各大 Coding Agent (大脑)"]
        A1["Kimi Code CLI"]
        A2["Claude Code (~/.claude)"]
        A3["Codex CLI (~/.codex)"]
        A4["Gemini / Antigravity (~/.gemini)"]
        A5["Hermes CLI"]
    end

    subgraph MCP["标准 MCP 协议层 (stdio JSON-RPC)"]
        M["/Applications/KimiCU.app/Contents/MacOS/kimi-cu mcp"]
    end

    subgraph Daemon["常驻高优先级守护进程 (ai.kimi.cu.service)"]
        D["kimi-cu service (Darwin Priority 31 Interactive)"]
        R["内嵌 Node.js 22 VM 沙盒 (trusted-worker.mjs)"]
    end

    subgraph OS["macOS 私有底层框架 (手脚与眼睛)"]
        S1["SkyLight.framework (私有后台焦点/路由 SPI)"]
        S2["SLSEventAuthenticationMessage (签名后台键盘)"]
        S3["ScreenCaptureKit SCStream (10FPS 防后台冻结)"]
        S4["HIServices AXUIElement (无障碍树 + Session Diff)"]
    end

    A1 & A2 & A3 & A4 & A5 -->|"自动注册 MCP"| M
    M -->|"Unix Socket IPC"| D
    D <-->|"kimi-cu-runtime UDS"| R
    D --> S1 & S2 & S3 & S4
```

1. **全自动跨平台夺舍注册**：
   当 [KimiCU.app](file:///Applications/KimiCU.app) 启动或通过 Kimi Code 插件 [kimi-cu-mcp](file:///Users/zhang/.kimi-code/plugins/managed/kimi-cu/bin/kimi-cu-mcp) 初始化时，`AgentIntegration` 会自动在后台执行：
   - `claude mcp add -s user kimi-cu /Applications/KimiCU.app/Contents/MacOS/kimi-cu mcp`
   - `codex mcp add kimi-cu /Applications/KimiCU.app/Contents/MacOS/kimi-cu mcp`
   - `gemini mcp add -s user kimi-cu /Applications/KimiCU.app/Contents/MacOS/kimi-cu mcp`
   - `hermes mcp --accept-hooks add kimi-cu /Applications/KimiCU.app/Contents/MacOS/kimi-cu mcp`
2. **Skill 提示词强引导**：
   它的 [SKILL.md](file:///Users/zhang/.kimi-code/plugins/managed/kimi-cu/skills/kimi-cu/SKILL.md) 明确指示上游大模型：**默认使用 `mode: "ax"`（纯文本无障碍树）而非截图，优先使用 `js()` 工具一次性编写 JavaScript 脚本批量执行多步 GUI 操作**。因此 Codex 和 Claude Code 根本不需要再去调用 Anthropic/OpenAI 官方缓慢且昂贵的截图版 Computer Use。

---

## 二、 深度反编译：`kimi-cu` 的 14 个内部模块与 5 大底层黑科技

我们对 7.7 MB 的未剥离符号二进制 [kimi-cu](file:///Applications/KimiCU.app/Contents/MacOS/kimi-cu) 进行了完整符号提取与 ARM64 汇编反编译，其核心由 **14 个 Swift 模块**组成，已将核心源码完整还原至 [`outputs/kimi_cu_reverse/`](file:///Users/zhang/Documents/huazhijian/outputs/kimi_cu_reverse/README.md)：

| 序号 | 内部模块名 (`kimi_cu.*`) | 二进制地址范围 | 核心职责与逆向发现 |
| :--- | :--- | :--- | :--- |
| 1 | `SkyLight` | `0x1002c33b4`–`0x1002c538c` | `dlopen` 苹果私有 `SkyLight.framework`，伪造 248 字节后台焦点包、无窗口唤醒进程 ([`SkyLight.swift`](file:///Users/zhang/Documents/huazhijian/outputs/kimi_cu_reverse/SkyLight.swift)) |
| 2 | `SignedKeyboard` | `0x1002c28ac`–`0x1002c33a0` | 构造私有 `SLSEventAuthenticationMessage` 签名信封，突破 macOS/Chromium 后台键盘拦截 ([`SignedKeyboard.swift`](file:///Users/zhang/Documents/huazhijian/outputs/kimi_cu_reverse/SignedKeyboard.swift)) |
| 3 | `BackgroundInput` | `0x10005b200`–`0x1000a4600` | 9 字段私有 `CGEvent` 戳记 + `CGEventSetWindowLocation` + 28pt 标题栏 `Cmd-Click` 防弹窗 ([`BackgroundInput.swift`](file:///Users/zhang/Documents/huazhijian/outputs/kimi_cu_reverse/BackgroundInput.swift)) |
| 4 | `Screenshot` | `0x1000fff48`–`0x10012b5c8` | 建立 10 FPS `SCStream` 持续捕获租约，欺骗 WindowServer 与 Chromium 保持后台渲染 ([`WindowCaptureRefresh.swift`](file:///Users/zhang/Documents/huazhijian/outputs/kimi_cu_reverse/WindowCaptureRefresh.swift)) |
| 5 | `AXTree` | `0x10002d5d4`–`0x10005afe4` | 4000 节点预算上限遍历、Electron/CEF 懒加载激活 (`AXManualAccessibility`)、会话级增量差分 `tree_diff` |
| 6 | `AXAction` | `0x100003500`–`0x10002d5d0` | 将 `w3.e19` 元素 ID 映射为原语动作（`AXPress`、`AXConfirm`、`AXScrollToVisible`），失败自动回退后台坐标点击 |
| 7 | `NodeRepl` | `0x1000b40ec`–`0x1000e1800` | 驱动内嵌 Node.js 22 VM 沙盒 ([kernel.mjs](file:///Applications/KimiCU.app/Contents/Resources/node-repl/runtime/kernel.mjs) + [service.mjs](file:///Applications/KimiCU.app/Contents/Resources/node-repl/packages/kimi-cu/trusted-service/service.mjs))，实现单轮 JS 循环操控 GUI |
| 8 | `MCP` / `ServiceIPC` | `0x1000a4800`–`0x1000b40e0` | 暴露 21 个 MCP 工具，通过 Unix Domain Socket 与 `Interactive` 级守护进程通信 |
| 9 | `AgentIntegration` | `0x1002da400`–`0x1002dfa1c` | 自动扫描并向 `claude`、`codex`、`gemini`、`hermes` 注入 MCP 配置 ([`AgentIntegration.swift`](file:///Users/zhang/Documents/huazhijian/outputs/kimi_cu_reverse/AgentIntegration.swift)) |

### 黑科技 1：为什么它点击后台窗口时，既不抢你的物理鼠标，也不把后台窗口弹到前台？
普通自动化工具（如 PyAutoGUI、cliclick、标准 Anthropic Computer Use）调用的是 `CGEventPost(kCGHIDEventTap, event)`，这会直接移动物理鼠标并把目标窗口激活置顶。
而 `kimi-cu` 在 [`BackgroundInput.swift`](file:///Users/zhang/Documents/huazhijian/outputs/kimi_cu_reverse/BackgroundInput.swift) (`0x100062f8c`) 中做了四件事：
1. **双通道 9 字段私有路由戳记**：不走全局 HID Tap，而是同时调用 `CGEventSetIntegerValueField` 和私有 `SLEventSetIntegerValueField` 强行写入 WindowServer 内部路由字段：
   - `0x07` (`mouseEventSubtype`) = `3` (`kCFEventMouseSubtypeWindow`)
   - `0x28` (`40`) = `targetPID`
   - `0x33` (`51`) & `0x3a` (`58`) = `windowID`
   - **`0x5b` (`91`) & `0x5c` (`92`) = `windowID`**（这是苹果未公开的 WindowServer 窗口直达路由槽位）
2. **窗口局部坐标注入**：调用私有 `CGEventSetWindowLocation(event, localPoint)`，直接告诉目标窗口鼠标在窗口内部局部坐标系的哪个点，即便窗口被完全遮挡也能精准命中。
3. **28pt 标题栏 `Cmd-Click` 防置顶 (`0x1000632dc`)**：当点击位置位于窗口顶部 `28.0pt` (`framePressStripHeight`) 内时，自动往 `CGEventFlags` 注入 `kCGEventFlagMaskCommand` (`0x100000`)——利用 macOS 原生“按住 Command 点击后台窗口边框不会将其置顶”的特性，防止 WindowServer 触发 `orderFront`。
4. **248 字节焦点包伪造 (`0x1002c4cd0`)**：在 [`SkyLight.swift`](file:///Users/zhang/Documents/huazhijian/outputs/kimi_cu_reverse/SkyLight.swift) 中，手工构造一个 248 字节 (`0xf8`) 的 `SLSEventRecord` 字节数组（`record[0x08] = 0x0d` AppKitDefined, `offset 0x3c = windowID`, `record[0x8a] = 1`），通过 `SLPSPostEventRecordTo(&psn, record)` 直接发给目标进程，加上 `SLPSSetFrontProcessWithOptions(&psn, 0, 0x400)` (`kCPSNoWindows`)，让后台窗口**以为自己拥有键盘焦点，但实际上留在后台一动不动**。

### 黑科技 2：为什么它能向后台 Chrome / Electron / 飞书输入文字而不被系统丢弃？
从 macOS Sonoma / Sequoia 开始，直接用 `CGEventPostToPid` 发送键盘事件给后台 Chromium/Electron 窗口会被静默丢弃，因为缺少 WindowServer 的事件签名认证。
`kimi-cu`（借鉴了 MIT 开源项目 `trycua/cua`，见 [THIRD_PARTY_NOTICES.md](file:///Applications/KimiCU.app/Contents/Resources/THIRD_PARTY_NOTICES.md)）在 [`SignedKeyboard.swift`](file:///Users/zhang/Documents/huazhijian/outputs/kimi_cu_reverse/SignedKeyboard.swift) (`0x1002c28ac`) 中：
- 直接读取 `CGEventRef` 内存指针偏移 `+0x18` 处的内部 `SLSEventRecord*` 结构体指针（汇编指令 `ldr x2, [x21, #0x18]`）；
- 调用私有 Objective-C 类方法 `[SLSEventAuthenticationMessage messageWithEventRecord:record pid:pid version:0]` 生成系统级认证消息；
- 调用 `SLEventSetAuthenticationMessage(cgEvent, authMsg)` 挂载签名后，再通过 `SLEventPostToPid(pid, cgEvent)` 发送。

### 黑科技 3：为什么后台被遮挡的窗口不会停止渲染或卡死？
macOS 的 App Nap 与 Chromium 的 `WindowOcclusionTracker` 会在窗口被完全遮挡时暂停合成器渲染和 DOM/AX 树刷新。
`kimi-cu` 在 [`WindowCaptureRefresh.swift`](file:///Users/zhang/Documents/huazhijian/outputs/kimi_cu_reverse/WindowCaptureRefresh.swift) (`0x1001173c0`) 中对当前操作的后台窗口开启了一个 **10 FPS (`CMTime(1, 10)`) 的 `ScreenCaptureKit` `SCStream` 持续捕获租约**。只要这个流开着，macOS WindowServer 就会告诉目标应用“你正在被屏幕录制/共享”，从而强制后台应用保持 100% 活跃渲染和 UI 状态更新！

### 黑科技 4：为什么它的延迟能精确到 5 毫秒？
在 [ai.kimi.cu.service.plist](file:///Applications/KimiCU.app/Contents/Library/LaunchAgents/ai.kimi.cu.service.plist) 中，守护进程显式声明了 `<key>ProcessType</key><string>Interactive</string>`。如果在普通 MCP 子进程（Darwin 默认 Background Tier 4）里调 `usleep(5000)`，macOS 内核定时器合并（Timer Coalescing）会把它拉长到 25ms~100ms；而运行在 Tier 31 `Interactive` 的守护进程可以精确维持 5ms 的鼠标按下/抬起节奏。

---

## 三、 战略评估：“装在所有硬件上实现零 Token 自操作、独立拆公司”能不能成？

### 1. 先做残酷的技术祛魅：`kimi-cu` 本身为什么“省 Token”，以及它是不是“零 Token”？

> [!WARNING]
> **事实核查**：`kimi-cu` **不是大脑，也没有内置小模型**。当你在 Claude Code 或 Codex 里用它操作软件时，**决策依然消耗 Claude / Codex 的 Token**。

但为什么你体感上觉得它“几乎不花 Token、快得像硬件自己在动”？因为它通过三层架构设计，把传统 GUI Agent **90%~99% 的冗余 Token 砍掉了**：

| 维度 | 传统 Computer Use (Anthropic / OpenAI 原生) | `kimi-cu` 架构 (AX Diff + JS REPL) | Token 节省比例 |
| :--- | :--- | :--- | :--- |
| **视觉感知开销** | 每走一步截一张全屏高分图（约 1,500~3,000 Vision Tokens/步） | 默认读取 `AXTree` 紧凑文本，且第 2 步起只返回 **增量变化 (`tree_diff`)**（仅几十~几百 Text Tokens） | **节省 85% ~ 95%** |
| **多步执行开销** | 点 10 个按钮 = 10 轮“截图 → 大模型思考 → 返回坐标”往返 | 大模型调用 1 次 `js()` 工具，在 [kernel.mjs](file:///Applications/KimiCU.app/Contents/Resources/node-repl/runtime/kernel.mjs) 沙盒内写 `for` 循环连续执行 10 步 | **中间步骤 0 Token** |
| **固化技能复用** | 每次执行相同任务都要重新看图推理 | 一旦将操作写进 `@kimi/cu` 的 `.mjs` 脚本，后续定时或触发执行完全脱离大模型 | **复跑 100% 零 Token** |

### 2. 你的构想：“所有硬件装上这个底座，无 Token 自我操作”——能不能拆公司？

**结论：如果只抄一个 `kimi-cu`（纯 macOS MCP 驱动插件），拆公司壁垒不够高（开源界已有 `trycua/cua`、macOS 私有 API 也容易被大厂复制）；但如果你把它升级为“端侧自进化 GUI 执行引擎（Edge Action Compiler + Tiny VLM）”，这是一个极有爆发力的独立创业/孵化方向！**

为什么？因为目前全行业的 Agent（OpenClaw、Claude Code、Codex）都卡在同一个死穴上：**“每一次微小的物理/GUI执行，都要把感知数据传回云端大模型烧 Token，且速度慢（2~5秒/步）、还会抢占用户屏幕”**。

如果你要沿着这个方向扩展或拆公司，真正的**技术护城河与产品形态**应当是下面这套 **“三层端侧自操作架构”**：

```mermaid
flowchart TD
    subgraph L1["第一层：云端大模型『一次性编译器』(Cloud Teacher - 仅首次消耗 Token)"]
        C1["Claude / Codex / Kimi 首次探索陌生软件或硬件界面"]
        C2["生成确定性的 @kimi/cu JS 状态机脚本 + 异常恢复锚点"]
        C1 --> C2
    end

    subgraph L2["第二层：端侧零 Token 运行时 (Zero-Token Edge Runtime - 99% 日常运行)"]
        E1["NodeRepl 确定性状态机引擎 (基于 AX 树 ID / 语义锚点直接执行)"]
        E2["端侧微型守卫模型 (本地 0.5B~2B VLM / Apple Neural Engine / Jetson)"]
        E1 -->|"UI 树结构未变 (0 Token, 毫秒级)"| E3["直接完成任务"]
        E1 -->|"弹窗干扰 / 小改版"| E2
        E2 -->|"本地毫秒级修正 (0 云端 Token)"| E3
    end

    subgraph L3["第三层：跨硬件后台虚拟化手脚 (Cross-Hardware Ghost Driver)"]
        H1["macOS: SkyLight + SignedKeyboard + SCStream (已逆向拿全)"]
        H2["Windows: UIAutomation + SendInput/WindowStation 后台桌面"]
        H3["Linux / 机器人端 (G1 / Go2W / 4090): Xvfb / Wayland 虚拟合成器 + ROS2 Bridge"]
        H4["Android / 移动端: 虚拟 DisplaySurface + AccessibilityService"]
    end

    C2 -->|"编译下发固态技能 (.mjs)"| E1
    E3 --> H1 & H2 & H3 & H4
```

### 3. 我们现在就能基于逆向成果做的 3 个直接扩展（立即可落地）

既然我们已经把 [kimi-cu](file:///Applications/KimiCU.app/Contents/MacOS/kimi-cu) 的底层源码（[`outputs/kimi_cu_reverse/`](file:///Users/zhang/Documents/huazhijian/outputs/kimi_cu_reverse/README.md)）和它的内嵌 JS 引擎（[service.mjs](file:///Applications/KimiCU.app/Contents/Resources/node-repl/packages/kimi-cu/trusted-service/service.mjs)）全部摸透了，你可以立刻做以下扩展：

1. **直接脱离大模型、实现真·零 Token 运行（Action Compiler 模式）**：
   - `kimi-cu` 的守护进程通过 Unix Domain Socket (`kimi-cu-runtime`) 接收 JSON-RPC 指令（见 [trusted-protocol.mjs](file:///Applications/KimiCU.app/Contents/Resources/node-repl/runtime/trusted-protocol.mjs)）。
   - 我们可以让 Codex/Claude 第一次操作某个复杂软件（比如飞书客户端、剪映、工业上位机、机器人调试面板）时，把它的 `kimiCU.*` 调用序列**自动录制并编译成独立的 `.mjs` 本地脚本**。
   - 第二次及以后运行该任务时，直接由本地 Node 调用 `kimi-cu` 守护进程执行该 `.mjs` 脚本——**完全不经过任何云端大模型，真正做到 0 Token、毫秒级、后台静默操作！**
2. **注入本地小模型兜底（真·断网自操作硬件）**：
   - 在 Mac (M 系列芯片 MLX) 或你们的 4090 / Jetson 硬件上，挂一个极小的本地模型（如 Qwen2.5-VL-3B / UI-TARS-2B）直接对接 `kimi-cu mcp`。因为 `kimi-cu` 输出的是极简的 `AXTree` 文本树（而非复杂图片），**仅需 1.5B~3B 的本地小模型就能看懂 `w1.e5 [AXButton] "确定"` 并写出点击指令**，从而实现硬件在完全断网、0 云端 Token 费用的情况下自主操作本机所有 GUI 软件。
3. **跨平台移植到你们的机器人与算力矩阵（Linux / Windows / Android）**：
   - 将我们在 [`SkyLight.swift`](file:///Users/zhang/Documents/huazhijian/outputs/kimi_cu_reverse/SkyLight.swift)、[`SignedKeyboard.swift`](file:///Users/zhang/Documents/huazhijian/outputs/kimi_cu_reverse/SignedKeyboard.swift)、[`BackgroundInput.swift`](file:///Users/zhang/Documents/huazhijian/outputs/kimi_cu_reverse/BackgroundInput.swift) 中逆向出来的这套 **“后台焦点欺骗 + 增量无障碍树差分 (`tree_diff`) + 内嵌 JS 批处理沙盒 (`node-repl`)”** 协议完全复刻到 Linux（AT-SPI + 虚拟 Wayland Display）和 Android（VirtualDisplay + Accessibility）上，变成你们统一的跨硬件零 Token 执行底座。
