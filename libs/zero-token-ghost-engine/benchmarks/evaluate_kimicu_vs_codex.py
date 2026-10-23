#!/usr/bin/env python3
"""Write illustrative fixture data; this does not evaluate a computer-use tool.

The original task values and narrative notes are preserved for audit. They are
hard-coded, unverified examples, not observed successes, failures, timings,
model usage or platform behavior. No GUI, network or model API is called.
The historical filename is retained so existing local links remain valid.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List


LEGACY_ILLUSTRATIVE_TASKS: List[Dict[str, Any]] = [
    {
        "id": "TC01",
        "category": "basic",
        "name": "Native App Launch & Semantic State Inspection",
        "target_app": "Calculator / System Settings",
        "kimicu_pass": True,
        "codex_pass": True,
        "kimicu_latency_ms": 225,
        "codex_latency_ms": 42,
        "vision_baseline_tokens": 2400,
        "cua_ghost_tokens": 110,
        "notes": "Both succeed; Codex returns 14-day useCount in list_apps.",
    },
    {
        "id": "TC02",
        "category": "basic",
        "name": "Single-Window Native Control Click by Element Index",
        "target_app": "Calculator (com.apple.calculator)",
        "kimicu_pass": True,
        "codex_pass": True,
        "kimicu_latency_ms": 228,
        "codex_latency_ms": 35,
        "vision_baseline_tokens": 2100,
        "cua_ghost_tokens": 65,
        "notes": "Single deterministic AXPress on stable native button.",
    },
    {
        "id": "TC03",
        "category": "basic",
        "name": "High-Frequency Multi-Digit Native Calculator Burst (10-Step Sequence)",
        "target_app": "Calculator (com.apple.calculator)",
        "kimicu_pass": True,
        "codex_pass": True,
        "kimicu_latency_ms": 232,
        "codex_latency_ms": 34,
        "vision_baseline_tokens": 21000,
        "cua_ghost_tokens": 0,
        "notes": "Codex SkyComputerUseService achieves 30–40ms/step (5–6x faster than 225–238ms); CUA-Ghost solidifies loop into 0-token .mjs skill + Sky IPC fast-path.",
    },
    {
        "id": "TC04",
        "category": "basic",
        "name": "Native TextField Value Replacement & Readback Verification",
        "target_app": "Notes / TextEdit",
        "kimicu_pass": True,
        "codex_pass": True,
        "kimicu_latency_ms": 230,
        "codex_latency_ms": 58,
        "vision_baseline_tokens": 2200,
        "cua_ghost_tokens": 80,
        "notes": "Kimi-CU verifies write via AXValue readback (`verified: true`).",
    },
    {
        "id": "TC05",
        "category": "basic",
        "name": "Standard Menu Command & Keyboard Shortcut Execution (`cmd+f` / `cmd+t`)",
        "target_app": "Safari / Finder",
        "kimicu_pass": True,
        "codex_pass": True,
        "kimicu_latency_ms": 226,
        "codex_latency_ms": 48,
        "vision_baseline_tokens": 2300,
        "cua_ghost_tokens": 75,
        "notes": "Kimi-CU translates Cmd chords matching menu items into direct AXMenuItem press so background windows execute shortcuts without foreground focus.",
    },
    {
        "id": "TC06",
        "category": "basic",
        "name": "Scroll Area Navigation & Off-Screen Element Discovery",
        "target_app": "System Settings",
        "kimicu_pass": True,
        "codex_pass": True,
        "kimicu_latency_ms": 234,
        "codex_latency_ms": 65,
        "vision_baseline_tokens": 4600,
        "cua_ghost_tokens": 140,
        "notes": "AXTree pagination (offset/limit up to 4000 nodes) + incremental session diff.",
    },
    {
        "id": "TC07",
        "category": "basic",
        "name": "Primary Window Web Link Navigation & Form Fill",
        "target_app": "Google Chrome (Primary Window)",
        "kimicu_pass": True,
        "codex_pass": True,
        "kimicu_latency_ms": 238,
        "codex_latency_ms": 110,
        "vision_baseline_tokens": 2800,
        "cua_ghost_tokens": 95,
        "notes": "Standard indexed AXLink/AXTextField in primary browser window.",
    },
    {
        "id": "TC08",
        "category": "complex",
        "name": "Dense Custom Web/Canvas/Electron Control Click (No AX Index)",
        "target_app": "Chrome / Electron Custom Canvas UI",
        "kimicu_pass": True,
        "codex_pass": False,
        "kimicu_latency_ms": 236,
        "codex_latency_ms": 890,
        "vision_baseline_tokens": 3200,
        "cua_ghost_tokens": 180,
        "notes": "Kimi-CU outputs exact `@x,y w×h` BBox + native-resolution `rect` local crop (0 px error). Codex AX tree lacks (x,y) coordinates and misses dense targets via VLM visual guessing.",
    },
    {
        "id": "TC09",
        "category": "complex",
        "name": "Asynchronous UI Jump / Modal Popup Interception Under Race Condition",
        "target_app": "Chrome / Electron Dynamic Modal",
        "kimicu_pass": True,
        "codex_pass": False,
        "kimicu_latency_ms": 229,
        "codex_latency_ms": 410,
        "vision_baseline_tokens": 2900,
        "cua_ghost_tokens": 90,
        "notes": "Kimi-CU `snapshot_id` & `screenshot_id` optimistic locking immediately rejects stale element indices after DOM shift; Codex lacks snapshot locking and misclicks destructive button.",
    },
    {
        "id": "TC10",
        "category": "complex",
        "name": "Same-App Multi-Window Parallel Background Operation (Non-Key Window)",
        "target_app": "Google Chrome (4 Open Windows, Target = Occluded Window #2)",
        "kimicu_pass": True,
        "codex_pass": False,
        "kimicu_latency_ms": 231,
        "codex_latency_ms": 520,
        "vision_baseline_tokens": 3100,
        "cua_ghost_tokens": 0,
        "notes": "Kimi-CU routes directly to `window_id` via SkyLight 0x5b/0x5c window fields; Codex can only target the single Key Window.",
    },
    {
        "id": "TC11",
        "category": "complex",
        "name": "Fully Occluded Electron/Feishu Background Keyboard & Text Injection",
        "target_app": "Feishu / Lark & VS Code (Electron/Chromium)",
        "kimicu_pass": True,
        "codex_pass": False,
        "kimicu_latency_ms": 235,
        "codex_latency_ms": 640,
        "vision_baseline_tokens": 3000,
        "cua_ghost_tokens": 0,
        "notes": "Kimi-CU activates `AXManualAccessibility`, spoofs 248-byte `SLSEventRecord` focus, and signs key events via `SLSEventAuthenticationMessage`; Codex drops keys or raises window.",
    },
    {
        "id": "TC12",
        "category": "complex",
        "name": "Concurrent Human Foreground Work + Agent Background Execution (Zero Focus/Cursor Steal)",
        "target_app": "Human Active in Foreground + Agent Operating Background Apps",
        "kimicu_pass": True,
        "codex_pass": False,
        "kimicu_latency_ms": 233,
        "codex_latency_ms": 780,
        "vision_baseline_tokens": 3400,
        "cua_ghost_tokens": 0,
        "notes": "Kimi-CU detects `user_intervened` without touching physical cursor or foreground focus (`kCPSNoWindows = 0x400` + 28pt Cmd-Click protection + 10 FPS SCStream keep-alive).",
    },
]


def compute_summary() -> Dict[str, Any]:
    """Build an explicitly non-empirical dataset without performance claims."""
    return {
        "schema_version": "2.0",
        "evidence_type": "illustrative_fixture",
        "measurement_status": "not_measured",
        "dataset_name": "CUA-Ghost illustrative GUI task fixtures",
        "source_commit": "e1b33b71c73e8705546e4c60c478f5904b8a32fe",
        "notice": (
            "Hard-coded examples retained for traceability. Original outcomes, "
            "timings, token values and notes are unverified; do not use them to "
            "rank tools, claim successful execution or report token savings."
        ),
        "generator_scope": "Offline JSON generation only; no GUI, network or model calls.",
        "total_tasks": len(LEGACY_ILLUSTRATIVE_TASKS),
        "tasks": [
            {
                "id": task["id"],
                "evidence_type": "illustrative_fixture",
                "measurement_status": "not_measured",
                "legacy_unverified_values": task.copy(),
            }
            for task in LEGACY_ILLUSTRATIVE_TASKS
        ],
    }


if __name__ == "__main__":
    fixture = compute_summary()
    out_path = Path(__file__).parent / "benchmark_results_12_tasks.json"
    out_path.write_text(json.dumps(fixture, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {fixture['total_tasks']} illustrative fixtures to {out_path.name}; no evaluation was run.")
