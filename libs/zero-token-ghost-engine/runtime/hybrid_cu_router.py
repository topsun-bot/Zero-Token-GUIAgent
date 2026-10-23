#!/usr/bin/env python3
"""Route policy and an explicit adapter boundary for GUI actions.

No GUI backend or cloud transport is provided here. Route names are policy
labels, not measurements. Adapters must check the current target, permissions
and snapshot freshness before dispatch, and return their actual outcome.
"""

from __future__ import annotations

import dataclasses
import enum
import json
import subprocess
from typing import Any, Callable, Dict, Mapping, Optional


class RouteChannel(str, enum.Enum):
    KIMICU_BACKGROUND_VERIFIED = "kimicu_background_verified"
    KIMICU_RECT_NATIVE_CROP = "kimicu_rect_native_crop"
    KIMICU_MULTI_WINDOW_TARGETED = "kimicu_multi_window_targeted"
    CODEX_SKY_IPC_BURST = "codex_sky_ipc_burst"
    CLOUD_HOST_REMOTE_BRIDGE = "cloud_host_remote_bridge"


@dataclasses.dataclass
class GUIActionRequest:
    app_bundle_id: str
    action_type: str  # "click", "set_value", "press_key", "get_app_state"
    window_id: Optional[int] = None
    element_index: Optional[int] = None
    x: Optional[float] = None
    y: Optional[float] = None
    snapshot_id: Optional[str] = None
    screenshot_id: Optional[str] = None
    is_electron_or_chromium: bool = False
    is_unindexed_canvas_or_web: bool = False
    is_stable_native_burst: bool = False
    has_multiple_windows: bool = False
    cloud_host_endpoint: Optional[str] = None


@dataclasses.dataclass
class RoutingDecision:
    channel: RouteChannel
    rationale: str
    supported: bool = True
    # Compatibility fields: policy does not imply measurements or enforcement.
    expected_latency_ms: Optional[float] = None
    zero_foreground_steal: Optional[bool] = None
    optimistic_lock_enforced: Optional[bool] = None
    bbox_pixel_error_px: Optional[float] = None


class RouteExecutionError(RuntimeError):
    """A refusal before dispatch, or an invalid adapter receipt."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


ActionAdapter = Callable[[GUIActionRequest], Dict[str, Any]]


class HybridComputerUseRouter:
    """Select a policy route; execute only through an explicitly supplied adapter."""

    def __init__(self, adapters: Optional[Mapping[RouteChannel, ActionAdapter]] = None) -> None:
        self.adapters = dict(adapters or {})

    @staticmethod
    def _has_snapshot_token(req: GUIActionRequest) -> bool:
        return isinstance(req.snapshot_id, str) and bool(req.snapshot_id.strip())

    def select_route(self, req: GUIActionRequest) -> RoutingDecision:
        if req.cloud_host_endpoint:
            return RoutingDecision(
                channel=RouteChannel.CLOUD_HOST_REMOTE_BRIDGE,
                supported=False,
                rationale="Cloud transport is not implemented; execution is unsupported.",
            )
        if req.is_unindexed_canvas_or_web:
            return RoutingDecision(
                channel=RouteChannel.KIMICU_RECT_NATIVE_CROP,
                rationale="Caller identified an unindexed control; select the crop-capable adapter.",
            )
        if req.has_multiple_windows or req.window_id is not None:
            return RoutingDecision(
                channel=RouteChannel.KIMICU_MULTI_WINDOW_TARGETED,
                rationale="Caller supplied a window target or multiple-window flag.",
            )
        if (
            req.is_stable_native_burst
            and not req.is_electron_or_chromium
            and req.element_index is not None
            and req.action_type == "click"
            and self._has_snapshot_token(req)
        ):
            return RoutingDecision(
                channel=RouteChannel.CODEX_SKY_IPC_BURST,
                rationale=(
                    "Caller identified a stable native indexed click and supplied a snapshot token; "
                    "the adapter must still validate freshness before dispatch."
                ),
            )
        return RoutingDecision(
            channel=RouteChannel.KIMICU_BACKGROUND_VERIFIED,
            rationale="Default adapter policy; backend behavior and verification remain unmeasured.",
        )

    def execute(self, req: GUIActionRequest) -> Dict[str, Any]:
        """Return the adapter receipt unchanged; never synthesize GUI success.

        Token presence is checked here, not freshness. Adapters must reject stale
        tokens themselves. ``ok`` is not promoted to a verified postcondition.
        Adapter exceptions propagate without retrying an action.
        """
        decision = self.select_route(req)
        if not decision.supported:
            raise RouteExecutionError("UNSUPPORTED_ROUTE", decision.rationale)
        if req.element_index is not None and not self._has_snapshot_token(req):
            raise RouteExecutionError(
                "SNAPSHOT_REQUIRED", "An indexed action requires a non-empty snapshot_id."
            )
        adapter = self.adapters.get(decision.channel)
        if adapter is None:
            raise RouteExecutionError(
                "ADAPTER_NOT_CONFIGURED", f"No adapter configured for {decision.channel.value}."
            )
        receipt = adapter(req)
        if not isinstance(receipt, dict) or not isinstance(receipt.get("ok"), bool):
            raise RouteExecutionError(
                "INVALID_ADAPTER_RECEIPT", "Adapter must return a dict with a boolean ok field."
            )
        return receipt


class ToolchainTriadOrchestrator:
    """Read-only version probes, not authentication or business connectivity tests.

    Tool mapping: lark-cli -> Feishu/Lark; gh -> GitHub; kimi-cu -> GUI.
    The configured GUI socket is not contacted by this health check.
    """

    def __init__(
        self,
        lark_bin: str = "lark-cli",
        gh_bin: str = "/opt/homebrew/bin/gh",
        kimicu_socket: str = "/tmp/kimi-cu-runtime.sock",
    ) -> None:
        self.lark_bin = lark_bin
        self.gh_bin = gh_bin
        self.kimicu_socket = kimicu_socket

    def health_check(self) -> Dict[str, Any]:
        status: Dict[str, Any] = {
            "triad": {
                "feishu": {"tool": "lark-cli", "role": "Feishu / Lark"},
                "github": {"tool": "gh", "role": "GitHub"},
                "computer_use": {"tool": "kimi-cu", "role": "GUI Computer Use"},
            },
            "scope": "CLI version availability only; no login or business operation is verified.",
            "kimi-cu": {
                "check": "not_probed",
                "socket_path": self.kimicu_socket,
                "available": None,
                "authenticated": None,
                "business_connection_verified": None,
            },
        }
        for key, cmd in [
            ("gh", [self.gh_bin, "--version"]),
            ("lark-cli", [self.lark_bin, "--version"]),
        ]:
            result: Dict[str, Any] = {
                "check": "cli_version_only",
                "authenticated": None,
                "business_connection_verified": None,
            }
            try:
                proc = subprocess.run(cmd, capture_output=True, text=True, timeout=3)
                output = (proc.stdout or proc.stderr).strip().splitlines()
                result.update(available=proc.returncode == 0, output=output[0] if output else "")
            except Exception as exc:
                result.update(available=False, error=str(exc))
            status[key] = result
        return status


if __name__ == "__main__":
    # Policy demonstration only: no adapter is configured and no action is dispatched.
    router = HybridComputerUseRouter()
    request = GUIActionRequest(
        app_bundle_id="com.apple.calculator",
        action_type="click",
        element_index=12,
        snapshot_id="example-token-not-validated",
        is_stable_native_burst=True,
    )
    print(json.dumps(dataclasses.asdict(router.select_route(request)), indent=2))
