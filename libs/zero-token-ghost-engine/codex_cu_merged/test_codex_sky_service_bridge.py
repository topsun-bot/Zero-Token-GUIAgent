import unittest
from codex_sky_service_bridge import (
    AppUsageFrequencyTable,
    SkyComputerUseFastIPC,
    SkysightMemoryPipeline,
    SkysightObservationSegment,
    AppInstructionsRegistry,
)


class TestCodexSkyServiceBridge(unittest.TestCase):
    def test_14d_app_usage_frequency_table(self) -> None:
        table = AppUsageFrequencyTable()
        now = 1_800_000_000.0
        # Event older than 14 days should be pruned
        table.record_launch_or_focus("com.apple.calculator", "Calculator", now=now - 15 * 86400)
        table.record_launch_or_focus("com.apple.calculator", "Calculator", now=now - 100)
        table.record_launch_or_focus("com.apple.calculator", "Calculator", now=now - 10)
        table.record_launch_or_focus("com.tinyspeck.slackmacgap", "Slack", now=now - 5)

        self.assertEqual(table.get_use_count("com.apple.calculator", now=now), 2)
        ranked = table.list_apps_with_usage(now=now)
        self.assertEqual(ranked[0].bundle_id, "com.apple.calculator")
        self.assertEqual(ranked[0].use_count_14d, 2)
        self.assertEqual(ranked[1].bundle_id, "com.tinyspeck.slackmacgap")
        self.assertEqual(ranked[1].use_count_14d, 1)

    def test_sky_computer_use_fast_ipc_burst_click(self) -> None:
        captured = {}

        def fake_transport(payload):
            captured.update(payload)
            return {"ok": True, "executed": True, "verified": True}

        fast_ipc = SkyComputerUseFastIPC(ipc_transport=fake_transport)
        resp = fast_ipc.perform_fast_element_click("com.apple.calculator", element_index=7)
        self.assertTrue(resp.ok)
        self.assertTrue(resp.executed)
        self.assertTrue(resp.verified)
        self.assertEqual(resp.element_index, 7)
        self.assertTrue(resp.disable_ax_diffing)
        self.assertTrue(resp.skip_screenshot)
        self.assertEqual(captured["method"], "skyshot.performAction")

    def test_skysight_memory_sticky_taint_and_skill_suggestion(self) -> None:
        pipeline = SkysightMemoryPipeline()
        pipeline.ingest_segment(SkysightObservationSegment(1.0, "Numbers", "Budget.numbers", "Edited row 1"))
        pipeline.ingest_segment(SkysightObservationSegment(2.0, "Numbers", "Budget.numbers", "Edited row 2"))
        pipeline.ingest_segment(
            SkysightObservationSegment(
                3.0,
                "Numbers",
                "Budget.numbers",
                "Pasted external web table",
                untrusted_external_content=True,
            )
        )
        rollup = pipeline.build_rollup("10m")
        self.assertTrue(rollup.tainted)
        self.assertIn("tainted: true", rollup.markdown_frontmatter)
        self.assertIsNotNone(rollup.skill_Candidate)
        self.assertEqual(rollup.skill_Candidate["slug"], "auto-numbers-workflow")

    def test_app_instructions_registry(self) -> None:
        reg = AppInstructionsRegistry()
        apps = reg.available_apps()
        self.assertIn("Slack", apps)
        self.assertIn("Notion", apps)
        slack_doc = reg.get_instructions("Slack")
        self.assertIsNotNone(slack_doc)
        self.assertTrue(len(slack_doc) > 20)


if __name__ == "__main__":
    unittest.main()
