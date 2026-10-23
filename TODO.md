# Zero-Token-GUIAgent Roadmap & TODO List

## Phase 1: Core Zero-Copy & Zero-Token Runtime (Completed)
- [x] **OS-Level Background Input Hijack (`SkyLightGhostBridge.swift`)**
  - [x] 9-field dual-channel `CGEvent` + `SLEvent` window routing stamp (`MouseRoutingFieldSet`)
  - [x] 28.0pt title-bar `Cmd-Click` (`kCGEventFlagMaskCommand`) anti-raise guard
  - [x] 248-byte (`0xf8`) `SLSEventRecord` AppKitDefined background focus spoofing (`kCPSNoWindows = 0x400`)
  - [x] `CGEventRef + 0x18` hardware-signed keyboard injection (`SLSEventAuthenticationMessage` + `SLEventPostToPid`)
  - [x] 10 FPS `ScreenCaptureKit` (`SCStream`) anti-occlusion window framebuffer keep-alive lease
- [x] **Zero-Token AST Compiler & Delta-Tree Engine (`zero_token_compiler.mjs`)**
  - [x] Bounded UTF-8 & node-count SHA-256 AX tree delta encoder (`ADDED` / `MODIFIED` / `REMOVED`)
  - [x] Window-scoped `snapshot_id` optimistic concurrency lock (`StaleSnapshotError` on stale/drifted state)
  - [x] Immutable JSON request cloning & strict separation of `ok`, `executed`, and `verified` receipts
  - [x] Cooperative deadline & timeout enforcement with subsequent dispatch blocking
  - [x] 30/30 Node.js runtime contract tests passing
- [x] **Merged Kimi-CU (REA) & Codex Computer Use (`SkyComputerUseService`) Capabilities**
  - [x] Meriyah AST top-level binding persistence & UDS session wire protocol (`libs/zero-token-ghost-engine/kimi_cu_rea/`)
  - [x] 30–40ms ultra-fast native `element_index` IPC burst channel (`SkyComputerUseFastIPC`)
  - [x] 14-day rolling `useCount` application launch frequency ranking (`AppUsageFrequencyTable`)
  - [x] 10m / 6h rolling desktop activity summarizer with sticky taint tracking & automatic skill candidate extraction (`SkysightMemoryPipeline`)
  - [x] Per-application domain instruction registry (`AppInstructionsRegistry`)
  - [x] 25/25 Python router & bridge unit tests passing

---

## Phase 2: Real-Device Adapter & End-to-End Verification (In Progress / TODO)
- [ ] **Live macOS Adapter Wiring**
  - [ ] Connect `hybrid_cu_router.py` directly to the compiled `SkyLightGhostBridge` dylib / XPC service over UNIX domain socket
  - [ ] Replace mock/injected transport in benchmark runner with live `kimi-cu` UDS transport and `SkyComputerUseService` JSON-RPC socket
  - [ ] Implement independent post-action AX read-back verifier (`AXValue` / `AXFocused` / window geometry diff) for end-to-end `verified: true` certification
- [ ] **Zero-Copy Shared-Memory Framebuffer Slicing**
  - [ ] Expose `IOSurfaceRef` / `CVPixelBufferRef` from `WindowCaptureKeepAliveLease` directly to Python/Node via POSIX shared memory (`shm_open` / `mmap`) without PNG re-encoding
  - [ ] Benchmark end-to-end memory bandwidth and VLM token reduction on hybrid Electron/Canvas/Web apps
- [ ] **Cloud Host & Multi-VM Seamless Control Plane**
  - [ ] Implement `cloud_websocket` transport adapter in `hybrid_cu_router.py` connecting to `cua-sandbox` / `computer-server` (`ws://` / WebRTC + UDS)
  - [ ] Add R0–R4 capability-based risk gating and human-in-the-loop approval hooks for high-privilege desktop actions
  - [ ] Run full 12-task cross-application benchmark suite on live macOS & Linux cloud containers and record real token/latency traces
