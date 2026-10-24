#!/usr/bin/env python3
"""Unit tests for eda_zero_token_bridge.py (offline, deterministic contracts)."""

import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runtime"))

from eda_zero_token_bridge import (
    CloudHostEDATriadWorkflow,
    EDADialect,
    EDAGUIToScriptDistiller,
    EDAMicroUICoordinator,
    EDARiskLevel,
)
from hybrid_cu_router import (
    GUIActionRequest,
    HybridComputerUseRouter,
    RouteChannel,
    RouteExecutionError,
)


class EDAGUIToScriptDistillerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.distiller = EDAGUIToScriptDistiller()

    def test_clean_skill_strips_comments_and_preserves_strings(self) -> None:
        raw = """
        ;; Open Virtuoso schematic and set VDD
        geOpen(?window 1 ?lib "analog_lib" ?cell "opamp ; v2" ?view "schematic") ; inline comment
        cdfGetInstCDF(instId)->vdd->value = "0.75"
        """
        cleaned = self.distiller.clean_skill_command(raw)
        self.assertEqual(
            cleaned,
            'geOpen(?window 1 ?lib "analog_lib" ?cell "opamp ; v2" ?view "schematic") '
            'cdfGetInstCDF(instId)->vdd->value = "0.75"',
        )

    def test_clean_skill_rejects_unbalanced_parentheses_or_quotes(self) -> None:
        for bad in ('geOpen(?window 1', 'geOpen(?window 1))', 'geOpen("unterminated)'):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    self.distiller.clean_skill_command(bad)

    def test_clean_tcl_joins_commands_and_checks_braces(self) -> None:
        raw = """
        # Zoom to assertion failure time in Verdi
        wvSetCursor -win $_nWave1 125000.0
        wvZoomWindow -win $_nWave1 124000.0 126000.0
        """
        cleaned = self.distiller.clean_tcl_command(raw)
        self.assertEqual(
            cleaned,
            "wvSetCursor -win $_nWave1 125000.0 ; wvZoomWindow -win $_nWave1 124000.0 126000.0",
        )
        with self.assertRaises(ValueError):
            self.distiller.clean_tcl_command("foreach sig {clk rst { puts $sig }")

    def test_distill_trajectory_solidifies_verified_steps_with_parameter_slots(self) -> None:
        steps = [
            {
                "gui_action": "set_value",
                "window_id": 201,
                "snapshot_id": "snap-ade-01",
                "raw_log_command": 'asiSetEnvOptionVal(session "temperature" "125.0")',
                "verified": True,
            },
            {
                "gui_action": "click",
                "window_id": 201,
                "snapshot_id": "snap-ade-02",
                "raw_log_command": 'asiSetEnvOptionVal(session "modelFiles" "tt_1v8")',
                "verified": True,
            },
        ]
        script = self.distiller.distill_trajectory(
            skill_name="ade_pvt_corner_setup",
            dialect=EDADialect.CADENCE_SKILL,
            steps=steps,
            parameter_bindings={"TEMP_C": "125.0", "CORNER": "tt_1v8"},
        )
        self.assertTrue(script.zero_token_replay_ready)
        self.assertEqual(script.step_count, 2)
        self.assertEqual(script.parameters, ("CORNER", "TEMP_C"))
        self.assertIn("@TEMP_C@", script.script_body)
        self.assertIn("@CORNER@", script.script_body)
        self.assertEqual(len(script.sha256), 64)

    def test_distill_rejects_unverified_step_or_missing_snapshot(self) -> None:
        with self.assertRaises(RouteExecutionError) as err1:
            self.distiller.distill_trajectory(
                "bad_skill",
                EDADialect.SYNOPSYS_TCL,
                [{"snapshot_id": "s1", "raw_log_command": "puts ok", "verified": False}],
            )
        self.assertEqual(err1.exception.code, "UNVERIFIED_STEP_REJECTED")

        with self.assertRaises(RouteExecutionError) as err2:
            self.distiller.distill_trajectory(
                "bad_skill",
                EDADialect.SYNOPSYS_TCL,
                [{"snapshot_id": "   ", "raw_log_command": "puts ok", "verified": True}],
            )
        self.assertEqual(err2.exception.code, "SNAPSHOT_REQUIRED")

    def test_distill_blocks_r4_destructive_commands(self) -> None:
        with self.assertRaises(RouteExecutionError) as err:
            self.distiller.distill_trajectory(
                "danger_skill",
                EDADialect.CADENCE_SKILL,
                [
                    {
                        "snapshot_id": "s1",
                        "raw_log_command": 'ddDeleteObj(ddGetObj("lib" "top"))',
                        "verified": True,
                    }
                ],
            )
        self.assertEqual(err.exception.code, "R4_DESTRUCTIVE_COMMAND_BLOCKED")


class EDAMicroUICoordinatorTests(unittest.TestCase):
    def test_zero_px_error_bbox_center_and_clamped_native_rect_crop(self) -> None:
        cx, cy = EDAMicroUICoordinator.compute_element_center((20, 374, 8, 8))
        self.assertEqual((cx, cy), (24.0, 378.0))

        crop = EDAMicroUICoordinator.compute_native_rect_crop(
            focal_x=3800,
            focal_y=50,
            canvas_width=3840,
            canvas_height=2160,
            crop_width=400,
            crop_height=260,
        )
        self.assertEqual(crop.x, 3440)
        self.assertEqual(crop.y, 0)
        self.assertEqual(crop.width, 400)
        self.assertEqual(crop.height, 260)
        self.assertEqual(crop.scale_factor, 1.0)


class CloudHostEDATriadWorkflowTests(unittest.TestCase):
    def test_r4_critical_action_requires_human_approval_token(self) -> None:
        router = HybridComputerUseRouter(
            {RouteChannel.KIMICU_BACKGROUND_VERIFIED: lambda req: {"ok": True, "verified": True}}
        )
        workflow = CloudHostEDATriadWorkflow(router=router)
        req = GUIActionRequest(
            app_bundle_id="com.cadence.virtuoso",
            action_type="click",
            element_index=9,
            snapshot_id="snap-99",
        )
        with self.assertRaises(RouteExecutionError) as err:
            workflow.execute_guarded_eda_action(req, target_label="Overwrite GDSII File")
        self.assertEqual(err.exception.code, "R4_APPROVAL_REQUIRED")

        approved = workflow.execute_guarded_eda_action(
            req,
            target_label="Overwrite GDSII File",
            human_approval_token="APPROVE-SIGN-OFF-001",
        )
        self.assertTrue(approved["ok"])
        self.assertEqual(approved["risk_level"], EDARiskLevel.R4_CRITICAL_DESTRUCTIVE.value)

    def test_verdi_regression_triage_connects_gh_kimicu_and_lark(self) -> None:
        captured_lark = {}

        def fake_gh(query: str):
            return {"ok": True, "query": query, "failed_test": "pcie_link_training_timeout"}

        def fake_kimicu_crop(req: GUIActionRequest):
            return {"ok": True, "executed": True, "verified": True, "window_id": req.window_id}

        def fake_lark(payload):
            captured_lark.update(payload)
            return {"ok": True, "message_id": "om_feishu_12345"}

        router = HybridComputerUseRouter({RouteChannel.KIMICU_RECT_NATIVE_CROP: fake_kimicu_crop})
        workflow = CloudHostEDATriadWorkflow(
            router=router, gh_fetcher=fake_gh, lark_notifier=fake_lark
        )
        result = workflow.run_verdi_regression_triage(
            repo="topsun-bot/asic-core",
            run_id="90812",
            verdi_window_id=4102,
            snapshot_id="snap-verdi-77",
            signal_Transition_xy=(1920, 1080),
        )
        self.assertTrue(result["ok"])
        self.assertTrue(result["gui_receipt"]["verified"])
        self.assertEqual(captured_lark["failed_test"], "pcie_link_training_timeout")
        self.assertEqual(captured_lark["native_rect_crop"]["width"], 400)


if __name__ == "__main__":
    unittest.main()
