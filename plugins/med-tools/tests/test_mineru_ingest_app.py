from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from server import mineru_ingest_app as app


class MinerUIngestAppTests(unittest.TestCase):
    def test_server_registers_expected_tools_and_defaults(self) -> None:
        tools = app.mcp._tool_manager._tools
        self.assertEqual(
            set(tools),
            {
                "mineru_ingest_health",
                "mineru_ingest_submit",
                "mineru_ingest_status",
                "mineru_ingest_result",
                "mineru_ingest_validate",
                "mineru_ingest_batch_submit",
                "mineru_ingest_batch_status",
                "mineru_ingest_batch_result",
                "mineru_ingest_batch_validate",
            },
        )
        parameters = tools["mineru_ingest_submit"].parameters
        self.assertEqual(parameters["properties"]["language"]["default"], "ch")
        self.assertEqual(parameters["properties"]["device"]["default"], "cpu")
        self.assertEqual(parameters["properties"]["max_chars"]["default"], 1200)
        self.assertEqual(parameters["properties"]["overlap_chars"]["default"], 160)

    def test_tools_return_json_strings(self) -> None:
        fake_service = mock.Mock()
        fake_service.health.return_value = {"ok": True, "service": "mineru-ingest-tools"}
        fake_service.status.return_value = {"job_id": "job-1", "status": "queued"}
        with mock.patch.object(app, "_service", return_value=fake_service):
            health = json.loads(app.mineru_ingest_health())
            status = json.loads(app.mineru_ingest_status("job-1"))
        self.assertTrue(health["ok"])
        self.assertEqual(status["job_id"], "job-1")

    def test_remote_mode_selects_http_facade_without_changing_tool_names(self) -> None:
        fake_service = mock.Mock()
        with mock.patch.dict(os.environ, {"MED_RAG_MINERU_REMOTE_MODE": "remote"}):
            with mock.patch.object(
                app, "RemoteMinerUIngestService", return_value=fake_service
            ) as constructor:
                self.assertIs(app._service(), fake_service)
        constructor.assert_called_once_with()

    def test_public_health_payload_redacts_absolute_paths(self) -> None:
        fake_service = mock.Mock()
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir) / "user-7"
            home.mkdir()
            model_root = Path(temp_dir) / "models"
            fake_service.environment = {"PILOT_HOME": str(home)}
            fake_service.health.return_value = {
                "output_root": str(home / "med-tools" / "mineru-ingest"),
                "runtime": {
                    "launcher": str(home / "bin" / "mineru"),
                    "model_root": str(model_root),
                    "error": f"missing model directory: {model_root}",
                },
            }
            with mock.patch.object(app, "_service", return_value=fake_service):
                payload = json.loads(app.mineru_ingest_health())

        self.assertEqual(payload["output_root"], "med-tools/mineru-ingest")
        self.assertEqual(payload["runtime"]["launcher"], "<configured>")
        self.assertEqual(payload["runtime"]["model_root"], "<configured>")
        self.assertNotIn(str(home), json.dumps(payload, ensure_ascii=False))
        self.assertNotIn(str(model_root), json.dumps(payload, ensure_ascii=False))

    def test_tool_errors_are_returned_without_absolute_paths(self) -> None:
        fake_service = mock.Mock()
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir) / "user-7"
            home.mkdir()
            secret = Path(temp_dir) / "models"
            fake_service.environment = {"PILOT_HOME": str(home)}
            fake_service.status.side_effect = ValueError(
                f"cannot read {secret / 'missing.json'}"
            )
            with mock.patch.object(app, "_service", return_value=fake_service):
                payload = json.loads(app.mineru_ingest_status("job-1"))

        self.assertFalse(payload["ok"])
        self.assertNotIn(str(secret), json.dumps(payload, ensure_ascii=False))

    def test_batch_tool_accepts_documents_and_legacy_pdfs_alias(self) -> None:
        fake_service = mock.Mock()
        fake_service.submit_batch.return_value = {"batch_id": "batch-1", "status": "running"}
        with mock.patch.object(app, "_service", return_value=fake_service):
            result = json.loads(
                app.mineru_ingest_batch_submit(documents=[{"path": "/tmp/a.txt"}])
            )
            self.assertEqual(result["batch_id"], "batch-1")
            fake_service.submit_batch.assert_called_once()
            self.assertEqual(
                fake_service.submit_batch.call_args.kwargs["documents"],
                [{"path": "/tmp/a.txt"}],
            )

    def test_launcher_selects_platform_specific_python_and_parses_config_without_shell(self) -> None:
        launcher = Path(__file__).parents[1] / "run-mineru-ingest.cjs"
        node_script = r"""
const launcher = require(process.argv[1]);
const result = {
  unix: launcher.selectPython('/plugin', 'darwin', (path) => path === '/plugin/.venv/bin/python'),
  windows: launcher.selectPython('/plugin', 'win32', (path) => path === '/plugin/.venv/Scripts/python.exe'),
  config: launcher.parseConfigFile(process.argv[2]),
};
process.stdout.write(JSON.stringify(result));
"""
        with tempfile.TemporaryDirectory() as temp_dir:
            config = Path(temp_dir) / "mineru.env"
            config.write_text(
                "MED_RAG_MINERU_MAX_WORKERS='1'\n"
                "MED_RAG_MINERU_LAUNCHER=\"/opt/mineru -m cli\"\n",
                encoding="utf-8",
            )
            completed = subprocess.run(
                ["node", "-e", node_script, str(launcher), str(config)],
                check=True,
                capture_output=True,
                text=True,
            )
            payload = json.loads(completed.stdout)
            self.assertEqual(payload["unix"], "/plugin/.venv/bin/python")
            self.assertEqual(payload["windows"], "/plugin/.venv/Scripts/python.exe")
            self.assertEqual(payload["config"]["MED_RAG_MINERU_MAX_WORKERS"], "1")
            self.assertEqual(payload["config"]["MED_RAG_MINERU_LAUNCHER"], "/opt/mineru -m cli")

    def test_config_parser_rejects_shell_code(self) -> None:
        launcher = Path(__file__).parents[1] / "run-mineru-ingest.cjs"
        node_script = r"""
const launcher = require(process.argv[1]);
try {
  launcher.parseConfigFile(process.argv[2]);
  process.stdout.write('accepted');
} catch (error) {
  process.stdout.write('rejected');
}
"""
        with tempfile.TemporaryDirectory() as temp_dir:
            config = Path(temp_dir) / "bad.env"
            config.write_text("echo hacked\n", encoding="utf-8")
            completed = subprocess.run(
                ["node", "-e", node_script, str(launcher), str(config)],
                check=True,
                capture_output=True,
                text=True,
            )
            self.assertEqual(completed.stdout, "rejected")

    def test_plugin_adds_ingest_server_without_replacing_med_tools_launcher(self) -> None:
        plugin = json.loads(
            (Path(__file__).parents[1] / "plugin.json").read_text(encoding="utf-8")
        )
        servers = plugin["mcpServers"]
        self.assertEqual(
            servers["med-tools"]["args"],
            ["${env:PILOT_HOME}/plugins/med-tools/run-mcp.cjs"],
        )
        self.assertEqual(
            servers["mineru-ingest-tools"]["args"],
            ["${env:PILOT_HOME}/plugins/med-tools/run-mineru-ingest.cjs"],
        )
        self.assertEqual(
            set(
                (
                    "PILOT_HOME",
                    "PILOTDECK_DISABLE_LOCAL_AUTH",
                    "HOME",
                    "PATH",
                    "MED_RAG_MINERU_CONFIG_FILE",
                )
            )
            - set(servers["mineru-ingest-tools"]["env"]),
            set(),
        )


if __name__ == "__main__":
    unittest.main()
