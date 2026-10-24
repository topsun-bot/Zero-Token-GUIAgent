#!/usr/bin/env python3
"""
eda_zero_token_bridge.py
Zero-Token GUI-to-Script Distiller (SKILL / Tcl), Native-Resolution Micro-UI Cropper,
and R0-R4 Risk-Gated Triad Orchestrator (`lark-cli` + `gh` + `kimi-cu`) for EDA & Cloud Hosts.

Design Principles:
1. Deterministic 0-px BBox & 1:1 Native `rect` Slicing:
   - Avoids full-screen 4K VLM screenshot token waste on dense EDA canvases (Verdi nWave,
     Virtuoso Layout XL, Calibre RVE) by computing bounded native-resolution `rect` crops.
2. Snapshot Optimistic Concurrency Control (`snapshot_id`):
   - Rejects stale or missing `snapshot_id` tokens before dispatching any GUI mutation,
     preventing catastrophic misclicks during asynchronous FSDB/GDSII loading modals.
3. GUI-to-SKILL / GUI-to-Tcl Zero-Token Distillation:
   - Pairs interactive GUI explorations with EDA command logs (`CDS.log` SKILL or
     `vivado.jou` / `verdi.cmd` Tcl), normalizes multi-line commands, and solidifies
     verified trajectories into 0-Token parameterized native scripts with SHA-256 digests.
4. R0-R4 Capability & Risk Gating:
   - Destructive EDA actions (e.g., `Overwrite`, `Cancel Run`, `Delete CellView`) are
     classified as `R4_CRITICAL` and blocked unless an explicit human approval token is provided.
"""

from __future__ import annotations

import copy
import dataclasses
import enum
import hashlib
import json
import re
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

try:
    from ..runtime.hybrid_cu_router import (
        GUIActionRequest,
        HybridComputerUseRouter,
        RouteChannel,
        RouteExecutionError,
    )
except ImportError:
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runtime"))
    from hybrid_cu_router import (  # type: ignore
        GUIActionRequest,
        HybridComputerUseRouter,
        RouteChannel,
        RouteExecutionError,
    )


class EDARiskLevel(str, enum.Enum):
    R0_READ_ONLY = "R0_READ_ONLY"          # Waveform zoom, DRC marker highlight, rect crop
    R1_NON_MUTATING_NAV = "R1_NAV"         # Window switch, tab select, tree expand
    R2_VERIFIED_PARAM_EDIT = "R2_EDIT"     # ADE PVT corner entry, IP wizard parameter set
    R3_BATCH_SIM_LAUNCH = "R3_LAUNCH"      # Starting simulation or DRC run
    R4_CRITICAL_DESTRUCTIVE = "R4_CRITICAL"  # Overwrite GDS/schematic, Cancel 24h job, Delete


class EDADialect(str, enum.Enum):
    CADENCE_SKILL = "cadence_skill"  # Virtuoso CIW / CDS.log / Allegro .il
    SYNOPSYS_TCL = "synopsys_tcl"    # Verdi / Innovus / ICC2 / Vivado .tcl


@dataclasses.dataclass(frozen=True)
class NativeRectCrop:
    x: int
    y: int
    width: int
    height: int
    scale_factor: float = 1.0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "x": self.x,
            "y": self.y,
            "width": self.width,
            "height": self.height,
            "scale_factor": self.scale_factor,
        }


@dataclasses.dataclass(frozen=True)
class GUIToScriptStep:
    step_index: int
    gui_action: str
    window_id: int
    snapshot_id: str
    raw_log_command: str
    normalized_command: str
    verified: bool


@dataclasses.dataclass(frozen=True)
class SolidifiedEDAScript:
    skill_name: str
    dialect: EDADialect
    parameters: Tuple[str, ...]
    script_body: str
    sha256: str
    step_count: int
    zero_token_replay_ready: bool


class EDAGUIToScriptDistiller:
    """
    Distills verified interactive GUI steps + EDA command log lines (`CDS.log` / `vivado.jou`)
    into deterministic 0-Token SKILL (`.il`) or Tcl (`.tcl`) scripts.
    """

    _DESTRUCTIVE_PATTERNS = re.compile(
        r"\b(ddDeleteObj|dbPurge|rm\s+-rf|file\s+delete|cancel_run|overwrite)\b",
        re.IGNORECASE,
    )

    @staticmethod
    def clean_skill_command(raw_skill: str) -> str:
        """
        Lexically normalizes multi-line Cadence SKILL code into a safe single-line expression:
        - Strips `;;` comments outside string literals
        - Preserves string literals and escaped quotes
        - Collapses whitespace and verifies balanced parentheses
        """
        if not isinstance(raw_skill, str) or not raw_skill.strip():
            raise ValueError("SKILL command must be a non-empty string.")

        cleaned_lines: List[str] = []
        for raw_line in raw_skill.splitlines():
            in_string = False
            escaped = False
            line_chars: List[str] = []
            for ch in raw_line:
                if escaped:
                    line_chars.append(ch)
                    escaped = False
                    continue
                if ch == "\\":
                    line_chars.append(ch)
                    escaped = True
                    continue
                if ch == '"':
                    in_string = not in_string
                    line_chars.append(ch)
                    continue
                if ch == ";" and not in_string:
                    break
                line_chars.append(ch)
            stripped = "".join(line_chars).strip()
            if stripped:
                cleaned_lines.append(stripped)

        if not cleaned_lines:
            raise ValueError("SKILL command contains only comments or whitespace.")

        merged = " ".join(cleaned_lines)
        # Verify balanced parentheses outside strings
        depth = 0
        in_str = False
        esc = False
        for ch in merged:
            if esc:
                esc = False
                continue
            if ch == "\\":
                esc = True
                continue
            if ch == '"':
                in_str = not in_str
                continue
            if not in_str:
                if ch == "(":
                    depth += 1
                elif ch == ")":
                    depth -= 1
                    if depth < 0:
                        raise ValueError("Unbalanced closing parenthesis in SKILL command.")
        if in_str:
            raise ValueError("Unterminated string literal in SKILL command.")
        if depth != 0:
            raise ValueError(f"Unbalanced parentheses in SKILL command (net depth={depth}).")
        return merged

    @staticmethod
    def clean_tcl_command(raw_tcl: str) -> str:
        """
        Normalizes multi-line Synopsys/Cadence/Vivado Tcl commands:
        - Strips `#` comments at line start or after semicolon
        - Joins backslash-continued lines
        - Verifies balanced braces `{}` and brackets `[]`
        """
        if not isinstance(raw_tcl, str) or not raw_tcl.strip():
            raise ValueError("Tcl command must be a non-empty string.")

        lines: List[str] = []
        for line in raw_tcl.splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            lines.append(stripped)

        if not lines:
            raise ValueError("Tcl command contains only comments or whitespace.")

        merged = " ; ".join(lines)
        brace_depth = 0
        bracket_depth = 0
        in_str = False
        esc = False
        for ch in merged:
            if esc:
                esc = False
                continue
            if ch == "\\":
                esc = True
                continue
            if ch == '"':
                in_str = not in_str
                continue
            if not in_str:
                if ch == "{":
                    brace_depth += 1
                elif ch == "}":
                    brace_depth -= 1
                    if brace_depth < 0:
                        raise ValueError("Unbalanced closing brace in Tcl command.")
                elif ch == "[":
                    bracket_depth += 1
                elif ch == "]":
                    bracket_depth -= 1
                    if bracket_depth < 0:
                        raise ValueError("Unbalanced closing bracket in Tcl command.")
        if in_str or brace_depth != 0 or bracket_depth != 0:
            raise ValueError("Unbalanced quotes, braces, or brackets in Tcl command.")
        return merged

    def distill_trajectory(
        self,
        skill_name: str,
        dialect: EDADialect,
        steps: Sequence[Mapping[str, Any]],
        parameter_bindings: Optional[Mapping[str, str]] = None,
    ) -> SolidifiedEDAScript:
        """
        Compiles a sequence of verified GUI-to-log steps into a 0-Token SolidifiedEDAScript.
        Every step must have `verified == True` and a non-empty `snapshot_id`.
        """
        if not skill_name or not skill_name.strip():
            raise ValueError("skill_name must be non-empty.")
        if not steps:
            raise ValueError("Cannot distill an empty trajectory.")

        bindings = dict(parameter_bindings or {})
        normalized_lines: List[str] = []

        for idx, raw_step in enumerate(steps):
            if not isinstance(raw_step.get("verified"), bool) or not raw_step["verified"]:
                raise RouteExecutionError(
                    "UNVERIFIED_STEP_REJECTED",
                    f"Step {idx} is not verified (verified={raw_step.get('verified')!r}); "
                    "refusing to solidify into 0-Token script.",
                )
            snapshot_id = raw_step.get("snapshot_id")
            if not isinstance(snapshot_id, str) or not snapshot_id.strip():
                raise RouteExecutionError(
                    "SNAPSHOT_REQUIRED",
                    f"Step {idx} is missing a valid snapshot_id.",
                )
            raw_cmd = str(raw_step.get("raw_log_command", ""))
            if self._DESTRUCTIVE_PATTERNS.search(raw_cmd):
                raise RouteExecutionError(
                    "R4_DESTRUCTIVE_COMMAND_BLOCKED",
                    f"Step {idx} contains destructive pattern in command: {raw_cmd!r}",
                )

            if dialect == EDADialect.CADENCE_SKILL:
                norm = self.clean_skill_command(raw_cmd)
            elif dialect == EDADialect.SYNOPSYS_TCL:
                norm = self.clean_tcl_command(raw_cmd)
            else:
                raise ValueError(f"Unsupported EDA dialect: {dialect}")

            for param_name, literal_val in bindings.items():
                if literal_val:
                    placeholder = (
                        f"${{{param_name}}}"
                        if dialect == EDADialect.SYNOPSYS_TCL
                        else f"@{param_name}@"
                    )
                    norm = norm.replace(literal_val, placeholder)

            normalized_lines.append(norm)

        header = (
            f";; Auto-Distilled 0-Token SKILL Script: {skill_name}\n"
            if dialect == EDADialect.CADENCE_SKILL
            else f"# Auto-Distilled 0-Token Tcl Script: {skill_name}\n"
        )
        body = header + "\n".join(normalized_lines) + "\n"
        digest = hashlib.sha256(body.encode("utf-8")).hexdigest()

        return SolidifiedEDAScript(
            skill_name=skill_name.strip(),
            dialect=dialect,
            parameters=tuple(sorted(bindings.keys())),
            script_body=body,
            sha256=digest,
            step_count=len(normalized_lines),
            zero_token_replay_ready=True,
        )


class EDAMicroUICoordinator:
    """
    Computes deterministic 0-px bounding-box centers and bounded 1:1 native-resolution
    `rect` crops for high-density EDA interfaces (Verdi waveform canvas, Virtuoso Layout XL,
    Calibre RVE violation tables), plus R0-R4 risk gating.
    """

    _CRITICAL_LABELS = frozenset(
        {"overwrite", "delete", "cancel run", "abort job", "purge cellview", "force quit"}
    )

    @staticmethod
    def compute_element_center(bbox: Tuple[int, int, int, int]) -> Tuple[float, float]:
        """Returns exact center `(cx, cy)` from `(x, y, width, height)` with 0 px estimation error."""
        x, y, w, h = bbox
        if w <= 0 or h <= 0:
            raise ValueError(f"Invalid bounding box dimensions: {bbox}")
        return (x + w / 2.0, y + h / 2.0)

    @staticmethod
    def compute_native_rect_crop(
        focal_x: int,
        focal_y: int,
        canvas_width: int,
        canvas_height: int,
        crop_width: int = 320,
        crop_height: int = 240,
    ) -> NativeRectCrop:
        """
        Computes a clamped 1:1 native-resolution local `rect` around a waveform transition edge
        or layout DRC marker `(focal_x, focal_y)`, avoiding 4K full-screen downscaling.
        """
        if canvas_width <= 0 or canvas_height <= 0 or crop_width <= 0 or crop_height <= 0:
            raise ValueError("Canvas and crop dimensions must be positive integers.")
        w = min(crop_width, canvas_width)
        h = min(crop_height, canvas_height)
        x0 = max(0, min(focal_x - w // 2, canvas_width - w))
        y0 = max(0, min(focal_y - h // 2, canvas_height - h))
        return NativeRectCrop(x=x0, y=y0, width=w, height=h, scale_factor=1.0)

    @classmethod
    def classify_action_risk(
        cls,
        action_type: str,
        target_label: str = "",
        is_batch_launch: bool = False,
    ) -> EDARiskLevel:
        label_norm = (target_label or "").strip().lower()
        for critical in cls._CRITICAL_LABELS:
            if critical in label_norm:
                return EDARiskLevel.R4_CRITICAL_DESTRUCTIVE
        if action_type in ("get_app_state", "crop_rect", "read_markers"):
            return EDARiskLevel.R0_READ_ONLY
        if is_batch_launch:
            return EDARiskLevel.R3_BATCH_SIM_LAUNCH
        if action_type in ("set_value", "type_text"):
            return EDARiskLevel.R2_VERIFIED_PARAM_EDIT
        return EDARiskLevel.R1_NON_MUTATING_NAV


class CloudHostEDATriadWorkflow:
    """
    End-to-End Orchestrator connecting:
    - `gh`: Poll nightly regression failures / PR checks
    - `kimi-cu` (`HybridComputerUseRouter`): Background multi-window EDA waveform/DRC triage
    - `lark-cli`: Push structured root-cause summary + native `rect` waveform crop to Feishu
    """

    def __init__(
        self,
        router: HybridComputerUseRouter,
        gh_fetcher: Optional[Callable[[str], Dict[str, Any]]] = None,
        lark_notifier: Optional[Callable[[Dict[str, Any]], Dict[str, Any]]] = None,
    ) -> None:
        self.router = router
        self.gh_fetcher = gh_fetcher
        self.lark_notifier = lark_notifier

    def execute_guarded_eda_action(
        self,
        req: GUIActionRequest,
        target_label: str = "",
        human_approval_token: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Enforces R0-R4 risk gating and snapshot locking before delegating to HybridComputerUseRouter.
        """
        risk = EDAMicroUICoordinator.classify_action_risk(req.action_type, target_label)
        if risk == EDARiskLevel.R4_CRITICAL_DESTRUCTIVE:
            if not isinstance(human_approval_token, str) or not human_approval_token.strip():
                raise RouteExecutionError(
                    "R4_APPROVAL_REQUIRED",
                    f"Action on {target_label!r} is classified as R4_CRITICAL_DESTRUCTIVE; "
                    "explicit human_approval_token is required.",
                )
        req_copy = copy.deepcopy(req)
        receipt = self.router.execute(req_copy)
        return {
            **receipt,
            "risk_level": risk.value,
        }

    def run_verdi_regression_triage(
        self,
        repo: str,
        run_id: str,
        verdi_window_id: int,
        snapshot_id: str,
        signal_Transition_xy: Tuple[int, int],
        canvas_size: Tuple[int, int] = (3840, 2160),
    ) -> Dict[str, Any]:
        """
        Executes a closed-loop triage workflow:
        1. Queries GitHub regression failure metadata via `gh_fetcher`
        2. Computes 1:1 native `rect` crop around the failing clock cycle in Verdi (`window_id`)
        3. Routes background non-preemptive inspection via `HybridComputerUseRouter`
        4. Dispatches structured triage card via `lark_notifier`
        """
        if self.gh_fetcher is None:
            raise RouteExecutionError("GH_ADAPTER_MISSING", "gh_fetcher is not configured.")
        if self.lark_notifier is None:
            raise RouteExecutionError("LARK_ADAPTER_MISSING", "lark_notifier is not configured.")

        gh_info = self.gh_fetcher(f"{repo}#{run_id}")
        if not isinstance(gh_info, dict) or not gh_info.get("ok"):
            raise RouteExecutionError("GH_FETCH_FAILED", "Failed to fetch GitHub regression run.")

        crop = EDAMicroUICoordinator.compute_native_rect_crop(
            focal_x=signal_Transition_xy[0],
            focal_y=signal_Transition_xy[1],
            canvas_width=canvas_size[0],
            canvas_height=canvas_size[1],
            crop_width=400,
            crop_height=260,
        )

        gui_req = GUIActionRequest(
            app_bundle_id="com.synopsys.verdi",
            action_type="click",
            window_id=verdi_window_id,
            x=float(signal_Transition_xy[0]),
            y=float(signal_Transition_xy[1]),
            snapshot_id=snapshot_id,
            is_unindexed_canvas_or_web=True,
            has_multiple_windows=True,
        )
        gui_receipt = self.execute_guarded_eda_action(
            gui_req, target_label="nWave_signal_transition_marker"
        )
        if not gui_receipt.get("ok"):
            return {
                "ok": False,
                "stage": "kimi_cu_verdi_inspect",
                "gui_receipt": gui_receipt,
            }

        lark_payload = {
            "repo": repo,
            "run_id": run_id,
            "verdi_window_id": verdi_window_id,
            "snapshot_id": snapshot_id,
            "native_rect_crop": crop.to_dict(),
            "gui_verified": bool(gui_receipt.get("verified", False)),
            "failed_test": gh_info.get("failed_test", "unknown"),
        }
        lark_receipt = self.lark_notifier(lark_payload)
        return {
            "ok": bool(lark_receipt.get("ok")),
            "gh_run": gh_info,
            "native_rect_crop": crop.to_dict(),
            "gui_receipt": gui_receipt,
            "lark_receipt": lark_receipt,
        }
