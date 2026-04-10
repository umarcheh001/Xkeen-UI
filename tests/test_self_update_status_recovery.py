from __future__ import annotations

import importlib
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from flask import Flask


ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "xkeen-ui"

if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))


def _reload(name: str):
    module = sys.modules.get(name)
    if module is not None:
        return importlib.reload(module)
    return importlib.import_module(name)


class SelfUpdateStatusRecoveryTests(unittest.TestCase):
    def test_try_acquire_lock_reclaims_stale_lock(self):
        state = _reload("services.self_update.state")

        with tempfile.TemporaryDirectory() as tmp:
            lock_file = Path(tmp) / "lock"
            lock_file.write_text(json.dumps({"pid": -1, "created_ts": time.time()}), encoding="utf-8")

            acquired, info = state.try_acquire_lock(str(lock_file))

            self.assertTrue(acquired)
            self.assertTrue(info["exists"])
            self.assertTrue(info["alive"])
            self.assertFalse(info["stale"])

            refreshed = state.read_lock(str(lock_file))
            self.assertTrue(refreshed["exists"])
            self.assertTrue(refreshed["alive"])
            self.assertFalse(refreshed["stale"])

    def test_reconcile_runtime_status_marks_stale_runner_as_failed(self):
        state = _reload("services.self_update.state")

        with tempfile.TemporaryDirectory() as tmp:
            status_file = Path(tmp) / "status.json"
            lock_file = Path(tmp) / "lock"

            state.write_status(
                str(status_file),
                {
                    "state": "running",
                    "step": "backup",
                    "progress": None,
                    "created_ts": time.time() - 10,
                    "started_ts": time.time() - 9,
                    "finished_ts": None,
                    "error": None,
                    "pid": -1,
                    "op": "update",
                    "message": "Creating backup",
                    "updated_ts": time.time() - 5,
                },
            )

            status, lock_info, reconciled = state.reconcile_runtime_status(str(status_file), str(lock_file))

            self.assertTrue(reconciled)
            self.assertFalse(lock_info["exists"])
            self.assertEqual(status["state"], "failed")
            self.assertEqual(status["step"], "backup")
            self.assertEqual(status["error"], "runner_stale")
            self.assertTrue(status["stale"])
            self.assertIn("update.log", status["message"])
            self.assertIsNotNone(status["finished_ts"])

            persisted = state.read_status(str(status_file))
            self.assertEqual(persisted["state"], "failed")
            self.assertEqual(persisted["error"], "runner_stale")
            self.assertTrue(persisted["stale"])

    def test_devtools_status_endpoint_returns_reconciled_stale_status(self):
        state = _reload("services.self_update.state")
        devtools = _reload("routes.devtools")

        with tempfile.TemporaryDirectory() as tmp:
            status_file = Path(tmp) / "status.json"

            state.write_status(
                str(status_file),
                {
                    "state": "running",
                    "step": "backup",
                    "progress": None,
                    "created_ts": time.time() - 10,
                    "started_ts": time.time() - 9,
                    "finished_ts": None,
                    "error": None,
                    "pid": -1,
                    "op": "update",
                    "message": "Creating backup",
                    "updated_ts": time.time() - 5,
                },
            )

            app = Flask("self-update-status-recovery")
            with patch.dict(os.environ, {"XKEEN_UI_UPDATE_DIR": tmp}, clear=False):
                app.register_blueprint(devtools.create_devtools_blueprint(tmp))
                client = app.test_client()
                response = client.get("/api/devtools/update/status?tail=0")

            self.assertEqual(response.status_code, 200)
            payload = response.get_json()
            self.assertTrue(payload["ok"])
            self.assertTrue(payload["reconciled"])
            self.assertEqual(payload["status"]["state"], "failed")
            self.assertEqual(payload["status"]["step"], "backup")
            self.assertEqual(payload["status"]["error"], "runner_stale")
            self.assertTrue(payload["status"]["stale"])
            self.assertFalse(payload["lock"]["exists"])


if __name__ == "__main__":
    unittest.main()
