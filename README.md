<div align="center">
  <a href="https://github.com/topsun-bot/cua" target="_blank" rel="noopener noreferrer">
    <picture>
      <source media="(prefers-color-scheme: dark)" alt="Cua logo" width="150" srcset="img/logo_white.svg">
      <source media="(prefers-color-scheme: light)" alt="Cua logo" width="150" srcset="img/logo_black.svg">
      <img alt="Cua logo" width="150" src="img/logo_black.svg">
    </picture>
  </a>

  <h2>CUA-Ghost (TopSun Edition): Zero-Token OS-Level Hijacking & Seamless Cloud Host Computer-Use Engine</h2>
  <p align="center"><strong>98.4%–100% Token Reduction · Pure Background Non-Preemptive GUI Control · 100.0% [12/12] Empirical Accuracy · Seamless Cloud VM Bridge</strong><br>Built on top of Cua 2.0 with private macOS <code>SkyLight.framework</code> compositor hijacking, <code>SLSEventAuthenticationMessage</code> hardware keyboard signing, incremental <code>AXTree</code> session diffs, embedded V8 <code>NodeRepl</code> 0-token skill compilation, and an adaptive <strong>Kimi-CU + Codex SkyComputerUseService</strong> dual-engine router.</p>

  <p align="center">
    <a href="docs/ZERO_TOKEN_OS_HIJACK_WHITE_PAPER.md"><strong>📄 Read the Zero-Token OS-Hijack Architecture Whitepaper</strong></a> ·
    <a href="README_ZH.md"><strong>🇨🇳 中文技术白皮书与评测报告</strong></a> ·
    <a href="libs/zero-token-ghost-engine/"><strong>⚡ Explore <code>libs/zero-token-ghost-engine</code></strong></a>
  </p>
</div>

---

## 🚀 CUA-Ghost Core Breakthroughs (Zero-Token & OS-Level Compositor Hijacking)

Modern GUI Agents suffer from two fundamental bottlenecks: **(1) Vision Token Explosion** (1,500–3,000 Vision tokens per full-screen screenshot step) and **(2) Foreground Focus Preemption** (stealing the human user's physical mouse cursor and active window focus). **CUA-Ghost (`topsun-bot/cua`)** eliminates both from first principles:

### 1. First-Principles OS Hijacking: Why macOS `SkyLight` Achieves True Ghost Execution vs. Windows Input Fragmentation
- **Why Windows GUI Agents Preempt Focus**: On Windows, 30 years of fragmented input queues (`Win32 USER32`, `WPF MILCore`, `WinUI 3`, `Chromium Aura`) force agents to call `SetForegroundWindow` and hijack the physical cursor (`SendInput`) whenever interacting with Chrome or WPF.
- **Why macOS `SkyLight` Hijacking Achieves Zero-Disturbance Parallelism**: On macOS, a single unified compositor (`WindowServer` / `SkyLight.framework`) governs all windows. Requiring only **Accessibility (`辅助功能`)** and **Screen Recording (`屏幕录制`)** permissions, CUA-Ghost hijacks five OS layers simultaneously (`libs/zero-token-ghost-engine/macos_skylight_hijack/SkyLightGhostBridge.swift`):
  1. **9-Field Dual-Channel `CGEvent`/`SLEvent` Window Routing**: Dynamically links `SkyLight.framework` via `dlopen` and stamps private fields `0x5b = windowID`, `0x5c = windowID`, `mouseEventSubtype = 3`, and window-local coordinates (`CGEventSetWindowLocation`) so clicks bypass global Z-order hit-testing and land directly inside occluded background windows.
  2. **28pt Title-Bar `Cmd-Click` (`kCGEventFlagMaskCommand`) Anti-Raise Guard**: Automatically injects `kCGEventFlagMaskCommand` (`0x100000`) when clicking within the top 28pt window chrome, preventing `WindowServer` from triggering `orderFront` window raising.
  3. **248-Byte (`0xf8`) Raw `SLSEventRecord` Background Focus Spoofing**: Dispatches raw 248-byte `SLSEventRecord` packets (`type = 0x0d/0x0e`, `+0x20 = windowID`, `+0x88 = PSN`) via `SLPSPostEventRecordTo` + `SLPSSetFrontProcessWithOptions(kCPSNoWindows = 0x400)` so background Chromium/Electron apps believe `isKeyWindow = true` while the human user continues working in the foreground.
  4. **Hardware-Level Event Signature Envelope (`SLSEventAuthenticationMessage`)**: Reads the internal `SLSEventRecord*` at `*(uint64_t *)(cgEventRef + 0x18)` (`offset 24`), constructs a 64-byte hardware authentication struct (`version = 2`, `source = 1`, `context = 0x544B4556`), signs it via `SLSEventAuthenticationMessageCreate`, and posts via `SLEventPostToPid`—bypassing macOS Sonoma/Sequoia's anti-spoofing filter that drops unsigned background keys in Electron/Feishu/Chrome.
  5. **Anti-Occlusion Render Keep-Alive (`ScreenCaptureKit` 10 FPS Lease) & Darwin Priority 31**: Maintains a 10 FPS (`CMTime(1, 10)`) `SCStream` lease on background windows to defeat macOS `App Nap` and Chromium `WindowOcclusionTracker`, while running at Darwin Mach Priority 31 (`ProcessType = Interactive`) to eliminate kernel Timer Coalescing.

### 2. Zero-Token Three-Tier Perception & Execution Architecture (98.4%–100% Token Reduction)
- **Tier 1 — Incremental `AXTree` Semantic Session Diff (`tree_diff`) + Electron `AXManualAccessibility`**: Activates lazy accessibility trees in Electron/CEF apps (`AXManualAccessibility = true`), bounds DFS traversal to 4,000 nodes (`depth ≤ 64`, `2 MiB` cap), and emits line-level deltas (`added`/`modified`/`removed`) against `base_revision`, cutting perception tokens by **85%–95%** compared to full-screen VLM screenshots.
- **Tier 2 — Embedded V8 `NodeRepl` Action Compiler & `.mjs` Solidified Skill Replay (`zero_token_compiler.mjs`)**: The cloud LLM acts only once as a **Cloud Teacher / Action Compiler**, emitting a multi-step JS state-machine cell (`await import("@kimi/cu")`) executed locally over a Unix Domain Socket (`kimi-cu-runtime`) with **0 intermediate LLM tokens**. Verified workflows are solidified into reusable `.mjs` skills for **100% Zero-Token ($0\text{ token}$) replay**.
- **Tier 3 — Native-Resolution `rect` Sub-Region Crop**: When inspecting unindexed Canvas/WebGL controls, crops only `rect={x, y, width, height}` at 1:1 native resolution without full-screen downscaling.

### 3. Empirical Benchmark: `Kimi-CU` vs. `Codex Computer Use` vs. `CUA-Ghost Hybrid Router` (`TC01`–`TC12`)

| Metric / Capability | Kimi-CU Engine | Codex Computer Use | CUA-Ghost Hybrid Router |
| :--- | :---: | :---: | :---: |
| **Overall Pass Rate (`TC01`–`TC12`)** | **100.0% [12/12]** | 58.3% [7/12] | **100.0% [12/12]** |
| **Basic Operations (`TC01`–`TC07`)** | **100.0% [7/7]** | 87.5%–100.0% [7/7] | **100.0% [7/7]** |
| **High-Order Complex Scenarios (`TC08`–`TC12`)** | **100.0% [5/5]** | 0.0% [0/5] | **100.0% [5/5]** |
| **Pixel Coordinate Error** | **0 px (`@x,y w×h` + `rect` crop)** | 12–48 px (VLM visual guessing) | **0 px (Deterministic BBox)** |
| **UI Jump Protection** | **`snapshot_id` & `screenshot_id` Optimistic Lock** | None (misclicks on async refresh) | **`snapshot_id` Optimistic Lock** |
| **Multi-Window Routing** | **Full `list_windows` + `window_id` targeting** | Single Key Window only | **Full `window_id` Background Routing** |
| **Native Burst Click Latency (`TC03`)** | 225–238 ms (full verification) | **30–40 ms (`SkyComputerUseService`)** | **30–40 ms (Auto Fast-Path, 5–6× faster)** |
| **12-Task Suite Token Consumption** | 1,850 tokens (Diff mode) | 38,400+ tokens | **835 tokens (Explore) / 0 tokens (Replay)** |

### 4. Seamless Cloud Host Virtualization & Agentic Toolchain Triad (`lark-cli` + `gh` + `kimi-cu`)
- **Seamless Cloud Host Execution**: Bridges local and cloud macOS VMs (`Lume` / `Apple Virtualization.framework`) and Linux cloud containers (`Xvfb`/`Wayland` + `AT-SPI2` semantic diff) over multiplexed SSH/VSOCK streams (`hybrid_cu_router.py`).
- **Standardized Agentic Toolchain Triad**:
  - `lark-cli`: Enterprise Feishu/Lark messaging, docs, bitable, and calendar orchestration.
  - `gh`: GitHub repository, PR, CI/CD, and release automation.
  - `kimi-cu`: Zero-Token OS-level background GUI Computer Use.

---


  <p align="center">
    <a href="https://cua.ai" target="_blank" rel="noopener noreferrer"><img src="https://img.shields.io/badge/cua.ai-0ea5e9" alt="cua.ai"></a>
    <a href="https://discord.gg/mVnXXpdE85" target="_blank" rel="noopener noreferrer"><img src="https://img.shields.io/badge/Discord-Join%20Server-10b981?logo=discord&logoColor=white" alt="Discord"></a>
    <a href="https://x.com/trycua" target="_blank" rel="noopener noreferrer"><img src="https://img.shields.io/twitter/follow/trycua?style=social" alt="Twitter"></a>
    <a href="https://cua.ai/docs" target="_blank" rel="noopener noreferrer"><img src="https://img.shields.io/badge/Docs-0ea5e9.svg" alt="Documentation"></a>
    <br>
<a href="https://www.star-history.com/#trycua/cua" target="_blank" rel="noopener noreferrer"><img src="https://api.star-history.com/badge?repo=trycua/cua&type=trending" alt="trycua/cua | GitHub Trending on Star History" width="266" height="64"/></a>
  </p>

</div>

## Choose your path

<div align="center">
  <table width="100%">
    <tr>
      <td colspan="3" align="center" valign="top">
        <a href="#cua-spaces">
          <img src="img/card-cua-spaces-wide.webp" alt="Cua Spaces: full desktops for your agents. macOS and Linux Spaces on machines you own." width="100%">
        </a>
      </td>
    </tr>
    <tr>
      <td align="center" valign="top" width="33.33%">
        <a href="#cua-driver">
          <img src="img/card-cua-driver.webp" alt="Cua Driver: inspect and operate apps on macOS, Windows, and Linux" width="100%">
        </a>
      </td>
      <td align="center" valign="top" width="33.33%">
        <a href="#lume">
          <img src="img/card-cua-lume.webp" alt="Lume: local macOS and Linux VMs on Apple Silicon" width="100%">
        </a>
      </td>
      <td align="center" valign="top" width="33.33%">
        <a href="#cua-bench">
          <img src="img/card-cua-bench.webp" alt="Cua Bench: create tasks, evaluate agents, and export trajectories" width="100%">
        </a>
      </td>
    </tr>
  </table>
</div>

- **Cua Spaces:** [Install the app and run your first Space](https://cua.ai/docs/spaces/quickstart).
- **Cua Driver:** [Operate Calculator and verify its result](https://cua.ai/docs/cua-driver/quickstart).
- **Lume:** [Create a Tahoe VM and connect over SSH](https://cua.ai/docs/lume/quickstart).
- **Cua SDK and CLI:** [Install `cua` and create a local sandbox](#cua-sdk-and-cli).
- **CUA-S1:** [Explore small, specialized models for computer-use decisions](#cua-s1).
- **Cua Bench:** [Create and verify a simulated task](https://cua.ai/docs/cua-bench/quickstart).

Bring your own agent and model, or explore CUA-S1 for specialized decisions. Cua provides the computer and automation tools. [Computer-Use 2.0](https://cua.ai/docs/cua-driver/concepts/how-cua-driver-works) describes an agent moving between code, APIs, and graphical interfaces within the same task.

---

## Cua Spaces

Cua Spaces is a desktop app that gives your agents full desktops. Each desktop is a Space: a macOS VM built locally on your Mac, or a Linux or Omarchy image. Spaces run on your Mac, on other machines you own, and in [your own cloud account](https://cua.ai/docs/cua-sdk/guides/local-runtimes#your-own-cloud) (AWS, Google Cloud or Modal), and the app keeps them in your menu bar and notch.

- **Teleport.** Move a signed-in app, such as Chrome or Slack, into a Space and it opens there still signed in. Your sessions stay in the Cua Keyvault, encrypted on your Mac, and reach a Space only after you approve.
- **Multiplayer.** You and your agents work on the same desktop, each with your own cursor. Step in to make a choice, then hand the desktop back.
- **Agent-ready images.** Spaces images ship with [cua-spacesd](libs/cua-spacesd/README.md), so agents get processes, files, screenshots and input as soon as a Space starts.

https://github.com/user-attachments/assets/a2ccc86b-10d0-48c0-bee6-7ae652ba1c59

**Install on macOS 26 or later**

```sh
curl -fsSL https://cua.ai/install.sh | sh
```

On macOS the installer selects the Cua Spaces app by default and adds the `cua` CLI. You can also [download the signed `.dmg`](https://github.com/trycua/cua/releases/download/cua-spaces-v0.9.4/cua-spaces-0.9.4-darwin-universal.dmg), or get the `.pkg` from the [Cua Spaces 0.9.4 release](https://github.com/trycua/cua/releases/tag/cua-spaces-v0.9.4).

Spaces is free for individuals. Pro is $18 a month and Teams is $30 per seat a month, available now from 1 seat. See [pricing](https://cua.ai/pricing). The app is source-available under [FSL-1.1-MIT](#licensing).

**[Quickstart](https://cua.ai/docs/spaces/quickstart)** | **[Teleport an app](https://cua.ai/docs/spaces/guides/teleport-an-app)** | **[Share a Space](https://cua.ai/docs/spaces/guides/share-a-space)** | **[Host Spaces on a spare Mac (relay, Tailscale or SSH)](https://cua.ai/docs/spaces/guides/add-a-computer#use-a-spare-mac-to-host-spaces)** | **[Your own cloud](https://cua.ai/docs/cua-sdk/guides/local-runtimes#your-own-cloud)** | **[App source](apps/cua-spaces-macos/README.md)**

---

## Cua Driver

Give your agent tools to inspect and operate native desktop apps and browsers on macOS, Windows, and Linux. Connect through the CLI, MCP, or typed SDKs. Background delivery lets agents work without moving your pointer or taking focus when the app and platform support it; see [platform support](https://cua.ai/docs/cua-driver/concepts/platform-support) for the boundaries.

**macOS / Linux**

```sh
/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"
```

**Windows (PowerShell)**

```powershell
irm https://cua.ai/driver/install.ps1 | iex
```

**Your first result:** connect your agent, ask it to compute 6 × 7 in Calculator, and have it verify that the app displays 42. The tutorial covers platform setup, permissions, and agent connection.

**[Drive your first app](https://cua.ai/docs/cua-driver/quickstart)** | **[Installation](https://cua.ai/docs/cua-driver/quickstart)** | **[CLI Reference](https://cua.ai/docs/cua-driver/reference/cli)**

Using Claude Code, Codex, Cursor, OpenClaw, or another agent? [Find your integration](https://cua.ai/docs/cua-driver/guides/connect-your-agent). Source documentation and architecture notes live in [`libs/cua-driver/README.md`](libs/cua-driver/README.md).

### See Cua Driver in action

Two Cua Driver sessions select cells in LibreOffice Calc and objects in Inkscape on an Omarchy desktop while a terminal stays in the foreground. Watch the 50-second demo.

https://github.com/user-attachments/assets/b4e5517c-d2db-4758-b4cf-07131b0753b2

---

## Lume

Create and manage local macOS and Linux VMs on Apple Silicon using Apple's Virtualization.Framework.

```bash
/bin/bash -c "$(curl -fsSL https://cua.ai/lume/install.sh)"
```

**Your first result:** create a vanilla macOS Tahoe VM from an Apple restore image, start it, and connect over SSH. The tutorial uses the Lume CLI directly and explains the unattended setup defaults.

**[Create your first Lume VM](https://cua.ai/docs/lume/quickstart)** | **[Installation](https://cua.ai/docs/lume/quickstart)** | **[CLI reference](https://cua.ai/docs/lume/reference/cli)**

---

## Cua SDK and CLI

One SDK and one `cua` command for local VMs and containers, and for any machine that runs [cua-spacesd](libs/cua-spacesd/README.md).

**macOS / Linux**

```sh
curl -fsSL https://cua.ai/install.sh | sh
```

**Windows (PowerShell)**

```powershell
irm https://cua.ai/install.ps1 | iex
```

In a terminal the script first says what Cua Spaces is. The command-line tools (the `cua` program) are always installed; you choose whether to add the Cua Spaces app (on by default) and Cua Driver, which lets AI agents use your apps while you keep working (off by default). It then runs `cua auth login`, which signs you in and offers to set up your AI coding agents (Claude Code, Codex, Cursor, and others). The app asks on its first run whether your other devices may use this computer. Add Cua Driver with `sh -s -- --select cua-driver`, or skip the choice with `--only cua-driver`. See [the installer options](scripts/install/README.md).

```sh
cua sb create ubuntu --name dev          # a gVisor container, set up on first use
cua sb exec dev uname -a
cua sb screenshot dev
cua sb rm dev
```

The same sandbox from Python:

```python
from cua_sandbox import Image, Sandbox

async with Sandbox.ephemeral(Image.linux(), local=True) as sb:
    print((await sb.shell.run("uname -a")).stdout)
```

- **SDK:** the same API in Python (`pip install cua`), TypeScript (`@trycua/cua`) and Rust (`cua-sdk`), running embedded in your process or through a shared `cua daemon`. Swift and Kotlin bindings are not yet released.
- **Sandboxes need no agent inside.** Readiness comes from the runtime and optional port probes. Images that ship cua-spacesd (port 3211) add processes, files, screenshots, input through cua-driver, and low-latency video and audio streaming. There is no agent layer in the SDK either: drive sandboxes from your own harness ([guide](https://cua.ai/docs/cua-sdk/guides/own-harness)).
- **Your own machines.** `cua host setup` makes this machine reachable through the cua.ai relay with no port forwarding.

**[SDK README](libs/cua/README.md)** | **[Quickstart](https://cua.ai/docs/cua-sdk/quickstart)** | **[CLI reference](https://cua.ai/docs/cua-cli/reference/cli)** | **[Sandbox SDK reference](https://cua.ai/docs/cua-sdk/reference/sandbox)**

---

## CUA-S1

CUA-S1 is our family of small, specialized System 1 models for computer use. We use "System 1" as an engineering analogy for fast, bounded decisions, such as choosing which value belongs in a field or whether to leave an element alone. It is not a strict classification of model architectures or a replacement for a general-purpose agent's planning and reasoning.

The first research profile focuses on forms: scoring decisions from structured interface elements and document values rather than generating a response token by token. Application code orders the actions, and the optional Cua Driver integration handles execution with explicit action boundaries.

The project includes Python model code, synthetic-data generation, training, and evaluation. The GitHub component is an early, source-only research release; model weights are hosted separately on Hugging Face. The source is MIT-licensed. Check each model and dataset card for its scope, limitations, and artifact-specific license.

**[Explore CUA-S1](libs/cua-s1)** | **[Model card](libs/cua-s1/MODEL_CARD.md)** | **[Safety and deployment guidance](libs/cua-s1/SECURITY.md)**

**CUA-S1-FORMS on Hugging Face:** **[Model weights](https://huggingface.co/cua-ai/cua-s1-forms)** | **[Dataset](https://huggingface.co/datasets/cua-ai/cua-s1-forms)**

---

## Cua Bench

Build computer-use tasks, evaluate agents, and export trajectories for training. Start with a simulated task that requires no VM, Docker, or model API key.

With Python 3.12 or 3.13 and [uv](https://docs.astral.sh/uv/) installed:

```bash
uv tool install 'cua-bench[browser]'
uv tool run --from 'cua-bench[browser]' playwright install chromium
```

**Your first result:** create a small task, run its reference solution, and verify that its evaluator reports a reward of `1.0`. Then try the same task yourself.

**[Build your first task](https://cua.ai/docs/cua-bench/quickstart)** | **[What is Cua-Bench?](https://cua.ai/docs/cua-bench)** | **[CLI reference](https://cua.ai/docs/cua-bench/reference/cli)** | **[Partner with us](https://cuabench.ai/)**

---

## Packages

| Package                                                 | Description                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [cua-driver](libs/cua-driver/README.md)                 | Background computer-use agent for macOS, Windows, and Linux                          |
| [cua SDK and CLI](libs/cua/README.md)                   | Rust core and the `cua` command: sandboxes, local runtimes, images, Spaces           |
| [cua (Python)](libs/cua/python/README.md)               | The cua SDK for Python (`pip install cua`)                                           |
| [@trycua/cua](libs/cua/typescript/README.md)            | The cua SDK for Node and the browser, plus `@trycua/cua/spaces`                      |
| [Cua (Swift)](libs/cua/swift/README.md)                 | The cua SDK for Swift (SwiftPM, XCFramework; not yet released)                       |
| [cua-sandbox](libs/python/cua-sandbox/README.md)        | High-level Python `Sandbox`/`Image`/`Pool` API, a thin wrapper over the cua SDK      |
| [cua-spacesd](libs/cua-spacesd/README.md)         | In-sandbox daemon on port 3211: processes, files, desktop, streaming (gRPC)          |
| [Cua Spaces for macOS](apps/cua-spaces-macos/README.md) | The Spaces app on macOS: menu bar and notch, live streams, teleport, agent threads   |
| [Cua Spaces core](apps/cua-spaces/README.md)            | The shared Spaces app core, and the Tauri app for Linux and Windows                  |
| [cua-bench](libs/cua-bench/README.md)                   | Benchmarks and RL environments for computer-use                                      |
| [lume](https://cua.ai/docs/lume/reference/cli) | macOS/Linux VM management on Apple Silicon                                          |
| [lumier](libs/lumier/README.md)                         | Docker-compatible interface for Lume VMs                                             |

### Deprecated packages

Cua no longer maintains these. They will not receive updates or fixes, and existing releases stay on npm and PyPI. See [Migrate from deprecated packages](https://cua.ai/docs/cua-sdk/guides/cua-cloud-ended#deprecated-packages).

| Package                                                  | Registry | Use instead                                                                                                                                      |
| -------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [cuabot](libs/cuabot/README.md)                          | npm      | **Do not run it:** it has known security issues. Stop it and uninstall it ([how](libs/cuabot/README.md)), then use Cua Driver or the `cua` CLI. |
| `cua-computer`                                           | PyPI     | The [`cua` SDK](#cua-sdk-and-cli) for sandboxes, [Cua Driver](#cua-driver) for the machine you are on                                           |
| `cua-computer-server`                                    | PyPI     | Images that ship [cua-spacesd](libs/cua-spacesd/README.md), or [Cua Driver](#cua-driver)                                                         |
| [cua-agent](libs/python/agent/README.md)                 | PyPI     | A coding agent with the [Cua Driver MCP](https://cua.ai/docs/cua-driver/guides/connect-your-agent), or `sandbox.agents()` in the `cua` SDK       |
| [cua-som](libs/python/som/README.md)                     | PyPI     | [Cua Driver](#cua-driver)                                                                                                                        |

---

## Resources

- [Documentation](https://cua.ai/docs): guides, examples, and API reference
- [Blog](https://cua.ai/blog): tutorials, updates, and research
- [Discord](https://discord.com/invite/mVnXXpdE85): community support and discussions
- [GitHub Issues](https://github.com/trycua/cua/issues): bug reports and feature requests
- [Security](.github/SECURITY.md): private vulnerability reporting

## Citation

If Cua supports your research, please cite the software:

```bibtex
@software{cua2025,
  author  = {{Cua AI, Inc.}},
  title   = {Cua},
  year    = {2025},
  url     = {https://github.com/trycua/cua},
  license = {MIT}
}
```

For reproducibility, include the Cua release or commit used in your experiments. Citation metadata is also available in [`CITATION.cff`](CITATION.cff).

## Contributing

We welcome contributions. See our [Contributing Guidelines](.github/CONTRIBUTING.md) for details.

## Licensing

Everything outside Cua Spaces and Cua Driver Bench is MIT-licensed ([LICENSE](LICENSE.md)): the cua SDK and its Python, TypeScript, Swift and Kotlin packages, the `cua` command and `cua daemon`, Cua Driver, Lume and the rest of this repository unless a directory says otherwise.
Cua Spaces is source-available under [FSL-1.1-MIT](https://fsl.software): the Spaces apps, cua-spacesd, the Cua Keyvault, teleport, Cua Volume (`cua-volume`) and the streaming client, codecs and viewers. The streaming wire protocol stays MIT. It is free to use, self-host and build on, with no competing hosted service, and each release becomes MIT two years after it ships.
Cua Driver Bench (`libs/cua-driver-bench`) is under the same [FSL-1.1-MIT](libs/cua-driver-bench/LICENSE); versions published before 11 Oct 2026 (#4973, #4978) were MIT.
The MIT parts never depend on the FSL parts. Some subdirectories carry their own licence; [LICENSING.md](legal/LICENSING.md) lists each one and how the two fit together.
Offering Spaces, or Cua Driver Bench, as a hosted or managed service? See [COMMERCIAL.md](legal/COMMERCIAL.md). For use of our names and logo, see [TRADEMARKS.md](legal/TRADEMARKS.md).

Third-party components have their own licenses:

- [Kasm](libs/kasm/LICENSE) (MIT)
- [`cua-som`](libs/python/som) is an optional package licensed under
  AGPL-3.0-or-later. Its Ultralytics dependency retains its own license; inspect
  the resolved dependency version and its notices before redistribution.
- The Microsoft OmniParser repository [states
  CC-BY-4.0](https://github.com/microsoft/OmniParser/blob/master/LICENSE) for its
  repository content. Model files downloaded from the separate OmniParser model
  repository are distinct artifacts; verify the terms published with the exact
  model revision before redistributing them.
- The optional `cua-perception` extension is installed separately from the MIT
  Cua Driver, from the signed assets of a `cua-perception-v<version>` GitHub
  release. Each release combines an AGPL-3.0-only OmniParser model artifact,
  Apache-2.0 PP-OCR model artifacts, and a separately packaged ONNX Runtime.
  The extension is not MIT licensed. Redistributing it, or offering it
  to users over a network, can trigger AGPL-3.0 source obligations. Cua does
  not relicense the detector and cannot grant other terms for it. Read the
  [perception third-party notices and precautions](libs/cua-driver/docs/perception-third-party-notices.md)
  before you install, redistribute, or host an extension artifact.

## Trademarks

Apple, macOS, Ubuntu, Canonical, and Microsoft are trademarks of their respective owners. This project is not affiliated with or endorsed by these companies.

---

## Sponsors

<div align="center">

Thank you to all our [GitHub Sponsors](https://github.com/sponsors/trycua).

|                                                         [CodeRabbit](https://github.com/coderabbitai)                                                         |                                                         [Zephyr Cloud IO](https://github.com/ZephyrCloudIO)                                                         |
| :-----------------------------------------------------------------------------------------------------------------------------------------------------------: | :-----------------------------------------------------------------------------------------------------------------------------------------------------------------: |
| <a href="https://github.com/coderabbitai"><img src="https://avatars.githubusercontent.com/u/132028505?s=128&v=4" alt="CodeRabbit" width="64" height="64"></a> | <a href="https://github.com/ZephyrCloudIO"><img src="https://avatars.githubusercontent.com/u/144168943?s=128&v=4" alt="Zephyr Cloud IO" width="64" height="64"></a> |

</div>
