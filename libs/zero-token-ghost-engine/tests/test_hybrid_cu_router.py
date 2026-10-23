"""Offline contracts: no real CLI, socket, GUI or network calls are made."""

import importlib.util
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "runtime" / "hybrid_cu_router.py"
SPEC = importlib.util.spec_from_file_location("ghost_hybrid_router", MODULE_PATH)
router_module = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = router_module
SPEC.loader.exec_module(router_module)

GUIActionRequest = router_module.GUIActionRequest
HybridComputerUseRouter = router_module.HybridComputerUseRouter
RouteChannel = router_module.RouteChannel
RouteExecutionError = router_module.RouteExecutionError
ToolchainTriadOrchestrator = router_module.ToolchainTriadOrchestrator


def request(**kwargs):
    return GUIActionRequest(app_bundle_id="fixture.app", action_type="click", **kwargs)


class RoutePolicyTests(unittest.TestCase):
    def setUp(self):
        self.router = HybridComputerUseRouter()

    def test_default_selects_backend_policy_without_measurements(self):
        decision = self.router.select_route(request())
        self.assertEqual(decision.channel, RouteChannel.KIMICU_BACKGROUND_VERIFIED)
        self.assertTrue(decision.supported)

    def test_window_target_selects_window_route(self):
        for fields in ({"window_id": 42}, {"has_multiple_windows": True}):
            with self.subTest(fields=fields):
                self.assertEqual(
                    self.router.select_route(request(**fields)).channel,
                    RouteChannel.KIMICU_MULTI_WINDOW_TARGETED,
                )

    def test_unindexed_control_selects_crop_route(self):
        self.assertEqual(
            self.router.select_route(request(is_unindexed_canvas_or_web=True)).channel,
            RouteChannel.KIMICU_RECT_NATIVE_CROP,
        )

    def test_native_burst_requires_snapshot_token(self):
        for token in (None, "", "   "):
            with self.subTest(token=token):
                decision = self.router.select_route(
                    request(element_index=1, is_stable_native_burst=True, snapshot_id=token)
                )
                self.assertNotEqual(decision.channel, RouteChannel.CODEX_SKY_IPC_BURST)
        self.assertEqual(
            self.router.select_route(
                request(element_index=1, is_stable_native_burst=True, snapshot_id="snapshot-1")
            ).channel,
            RouteChannel.CODEX_SKY_IPC_BURST,
        )

    def test_electron_or_target_window_does_not_use_native_burst(self):
        for fields in ({"is_electron_or_chromium": True}, {"window_id": 42}):
            with self.subTest(fields=fields):
                decision = self.router.select_route(
                    request(element_index=1, snapshot_id="s", is_stable_native_burst=True, **fields)
                )
                self.assertNotEqual(decision.channel, RouteChannel.CODEX_SKY_IPC_BURST)

    def test_every_route_leaves_empirical_properties_unknown(self):
        requests = [
            request(),
            request(window_id=42),
            request(is_unindexed_canvas_or_web=True),
            request(element_index=1, snapshot_id="s", is_stable_native_burst=True),
            request(cloud_host_endpoint="fixture.invalid"),
        ]
        for req in requests:
            decision = self.router.select_route(req)
            with self.subTest(channel=decision.channel):
                for field in (
                    "expected_latency_ms",
                    "zero_foreground_steal",
                    "optimistic_lock_enforced",
                    "bbox_pixel_error_px",
                ):
                    self.assertIsNone(getattr(decision, field))

    def test_cloud_is_explicitly_unsupported(self):
        decision = self.router.select_route(request(cloud_host_endpoint="fixture.invalid"))
        self.assertEqual(decision.channel, RouteChannel.CLOUD_HOST_REMOTE_BRIDGE)
        self.assertFalse(decision.supported)


class ExecutionTests(unittest.TestCase):
    def assertRefusal(self, code, router, req):
        with self.assertRaises(RouteExecutionError) as caught:
            router.execute(req)
        self.assertEqual(caught.exception.code, code)

    def test_missing_adapter_refuses_instead_of_simulating_success(self):
        self.assertRefusal("ADAPTER_NOT_CONFIGURED", HybridComputerUseRouter(), request())

    def test_missing_selected_adapter_does_not_fall_back(self):
        other_adapter = Mock()
        router = HybridComputerUseRouter({RouteChannel.KIMICU_BACKGROUND_VERIFIED: other_adapter})
        self.assertRefusal("ADAPTER_NOT_CONFIGURED", router, request(window_id=42))
        other_adapter.assert_not_called()

    def test_cloud_refuses_even_if_an_adapter_is_supplied(self):
        adapter = Mock()
        router = HybridComputerUseRouter({RouteChannel.CLOUD_HOST_REMOTE_BRIDGE: adapter})
        self.assertRefusal(
            "UNSUPPORTED_ROUTE", router, request(cloud_host_endpoint="fixture.invalid")
        )
        adapter.assert_not_called()

    def test_index_without_snapshot_refuses_before_adapter(self):
        adapter = Mock()
        router = HybridComputerUseRouter({channel: adapter for channel in RouteChannel})
        for token in (None, "", "   "):
            for fields in ({}, {"window_id": 42}, {"is_stable_native_burst": True}):
                with self.subTest(token=token, fields=fields):
                    self.assertRefusal(
                        "SNAPSHOT_REQUIRED",
                        router,
                        request(element_index=1, snapshot_id=token, **fields),
                    )
        adapter.assert_not_called()

    def test_screenshot_token_does_not_substitute_for_index_snapshot(self):
        self.assertRefusal(
            "SNAPSHOT_REQUIRED",
            HybridComputerUseRouter(),
            request(element_index=1, screenshot_id="image-1"),
        )

    def test_success_receipt_and_request_are_preserved(self):
        receipt = {"ok": True, "verified": False, "action_id": "fixture-1"}
        adapter = Mock(return_value=receipt)
        router = HybridComputerUseRouter({RouteChannel.CODEX_SKY_IPC_BURST: adapter})
        req = request(element_index=1, snapshot_id="s", is_stable_native_burst=True)
        self.assertIs(router.execute(req), receipt)
        self.assertIs(adapter.call_args.args[0], req)
        self.assertEqual(receipt, {"ok": True, "verified": False, "action_id": "fixture-1"})

    def test_failed_receipt_is_not_promoted_to_success(self):
        receipt = {"ok": False, "error": "TARGET_NOT_FOUND"}
        router = HybridComputerUseRouter(
            {RouteChannel.KIMICU_BACKGROUND_VERIFIED: lambda req: receipt}
        )
        self.assertIs(router.execute(request()), receipt)
        self.assertFalse(receipt["ok"])

    def test_adapter_exception_propagates(self):
        failure = RuntimeError("BACKEND_UNAVAILABLE")
        adapter = Mock(side_effect=failure)
        router = HybridComputerUseRouter({RouteChannel.KIMICU_BACKGROUND_VERIFIED: adapter})
        with self.assertRaises(RuntimeError) as caught:
            router.execute(request())
        self.assertIs(caught.exception, failure)

    def test_adapter_can_reject_stale_snapshot_without_retry(self):
        stale = RouteExecutionError("STALE_SNAPSHOT", "Fixture backend rejected token.")
        adapter = Mock(side_effect=stale)
        router = HybridComputerUseRouter({RouteChannel.CODEX_SKY_IPC_BURST: adapter})
        self.assertRefusal(
            "STALE_SNAPSHOT",
            router,
            request(element_index=1, snapshot_id="old", is_stable_native_burst=True),
        )
        self.assertEqual(adapter.call_count, 1)

    def test_invalid_adapter_receipt_is_rejected(self):
        for receipt in (None, [], {}, {"ok": "true"}, {"ok": 1}):
            with self.subTest(receipt=receipt):
                adapter = Mock(return_value=receipt)
                router = HybridComputerUseRouter({RouteChannel.KIMICU_BACKGROUND_VERIFIED: adapter})
                self.assertRefusal("INVALID_ADAPTER_RECEIPT", router, request())


class ToolchainHealthTests(unittest.TestCase):
    def test_version_probe_does_not_claim_authentication_or_business_connection(self):
        completed = subprocess.CompletedProcess([], 0, "fixture-version 1\n", "")
        with patch.object(router_module.subprocess, "run", return_value=completed) as run:
            status = ToolchainTriadOrchestrator().health_check()
        self.assertEqual(run.call_count, 2)
        for call in run.call_args_list:
            self.assertEqual(call.args[0][-1], "--version")
        self.assertEqual(status["triad"]["feishu"]["tool"], "lark-cli")
        self.assertEqual(status["triad"]["github"]["tool"], "gh")
        self.assertEqual(status["triad"]["computer_use"]["tool"], "kimi-cu")
        for tool in ("gh", "lark-cli"):
            self.assertTrue(status[tool]["available"])
            self.assertEqual(status[tool]["check"], "cli_version_only")
            self.assertIsNone(status[tool]["authenticated"])
            self.assertIsNone(status[tool]["business_connection_verified"])
        self.assertEqual(status["kimi-cu"]["check"], "not_probed")
        self.assertIsNone(status["kimi-cu"]["available"])

    def test_failed_version_probe_reports_unavailable(self):
        completed = subprocess.CompletedProcess([], 1, "", "fixture unavailable\n")
        with patch.object(router_module.subprocess, "run", return_value=completed):
            status = ToolchainTriadOrchestrator().health_check()
        self.assertFalse(status["gh"]["available"])
        self.assertEqual(status["gh"]["output"], "fixture unavailable")

    def test_missing_cli_does_not_abort_other_health_checks(self):
        completed = subprocess.CompletedProcess([], 0, "fixture lark\n", "")
        with patch.object(
            router_module.subprocess,
            "run",
            side_effect=[FileNotFoundError("missing"), completed],
        ):
            status = ToolchainTriadOrchestrator().health_check()
        self.assertFalse(status["gh"]["available"])
        self.assertTrue(status["lark-cli"]["available"])

    def test_whitespace_output_is_handled(self):
        completed = subprocess.CompletedProcess([], 0, " \n", "")
        with patch.object(router_module.subprocess, "run", return_value=completed):
            status = ToolchainTriadOrchestrator().health_check()
        self.assertEqual(status["gh"]["output"], "")


if __name__ == "__main__":
    unittest.main()
