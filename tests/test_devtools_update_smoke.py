from __future__ import annotations

import importlib
import os
import sys
import tempfile
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


class DevtoolsUpdateSmokeTests(unittest.TestCase):
    @staticmethod
    def _which_with_update_deps(name: str):
        if name in {"python3", "tar", "curl", "sha256sum"}:
            return f"/usr/bin/{name}"
        return None

    def test_update_info_endpoint_returns_compact_local_update_snapshot(self):
        devtools = _reload("routes.devtools")

        with tempfile.TemporaryDirectory() as tmp:
            app = Flask("devtools-update-info-smoke")
            app.register_blueprint(devtools.create_devtools_blueprint(tmp))

            with patch.dict(os.environ, {"XKEEN_UI_UPDATE_REQUIRE_SHA": "1"}, clear=False), patch.object(
                devtools,
                "get_build_info",
                return_value={
                    "version": "1.6.0",
                    "repo": "umarcheh001/Xkeen-UI",
                    "channel": "stable",
                    "commit": "abc1234",
                },
            ), patch.object(
                devtools,
                "security_snapshot",
                return_value={"sha_strict": "1", "require_sha": "1"},
            ):
                client = app.test_client()
                response = client.get("/api/devtools/update/info")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["build"]["version"], "1.6.0")
        self.assertEqual(payload["settings"]["repo"], "umarcheh001/Xkeen-UI")
        self.assertEqual(payload["settings"]["channel"], "stable")
        self.assertIn("capabilities", payload)
        self.assertIn("tar_exclude", payload["capabilities"])
        self.assertEqual(payload["security"]["sha_strict"], "1")

    def test_update_run_reports_busybox_tar_without_exclude_as_actionable_backup_error(self):
        devtools = _reload("routes.devtools")

        with tempfile.TemporaryDirectory() as tmp:
            app = Flask("devtools-update-tar-exclude")
            with patch.dict(os.environ, {"XKEEN_UI_UPDATE_DIR": tmp}, clear=False):
                app.register_blueprint(devtools.create_devtools_blueprint(tmp))

            with patch.dict(os.environ, {"XKEEN_UI_UPDATE_DIR": tmp}, clear=False), patch.object(
                devtools.shutil,
                "which",
                self._which_with_update_deps,
            ), patch.object(
                devtools, "_tar_supports_exclude", return_value=False
            ):
                client = app.test_client()
                response = client.post("/api/devtools/update/run", json={})

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"], "backup_tar_unsupported")
        self.assertTrue(payload["can_skip_backup"])
        self.assertEqual(payload["install_command"], "opkg update && opkg install tar")
        self.assertIn("opkg update && opkg install tar", payload["hint"])
        self.assertIn("без бэкапа", payload["hint"])

    def test_update_run_skip_backup_bypasses_tar_exclude_preflight_and_passes_env(self):
        devtools = _reload("routes.devtools")
        captured = {}

        class FakeProcess:
            pid = 4242

        def fake_popen(*args, **kwargs):
            captured["args"] = args
            captured["kwargs"] = kwargs
            return FakeProcess()

        with tempfile.TemporaryDirectory() as tmp:
            app = Flask("devtools-update-skip-backup")
            with patch.dict(os.environ, {"XKEEN_UI_UPDATE_DIR": tmp}, clear=False):
                app.register_blueprint(devtools.create_devtools_blueprint(tmp))

            with patch.dict(os.environ, {"XKEEN_UI_UPDATE_DIR": tmp}, clear=False), patch.object(
                devtools.shutil,
                "which",
                self._which_with_update_deps,
            ), patch.object(
                devtools, "_tar_supports_exclude", return_value=False
            ), patch.object(
                devtools.subprocess, "Popen", fake_popen
            ), patch.object(
                devtools, "get_build_info", return_value={"repo": "umarcheh001/Xkeen-UI", "channel": "stable"}
            ):
                client = app.test_client()
                response = client.post("/api/devtools/update/run", json={"skip_backup": True})

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["started"])
        env = captured["kwargs"]["env"]
        self.assertEqual(env["XKEEN_UI_UPDATE_SKIP_BACKUP"], "1")

    def test_update_log_is_exposed_in_devtools_logs(self):
        devtools = _reload("routes.devtools")

        with tempfile.TemporaryDirectory() as tmp:
            update_log = Path(tmp) / "update.log"
            update_log.write_text("update started\nupdate done\n", encoding="utf-8")

            app = Flask("devtools-update-log-smoke")
            with patch.dict(os.environ, {"XKEEN_UI_UPDATE_DIR": tmp}, clear=False):
                app.register_blueprint(devtools.create_devtools_blueprint(tmp))
                client = app.test_client()

                list_response = client.get("/api/devtools/logs")
                tail_response = client.get("/api/devtools/logs/update?lines=50")

        self.assertEqual(list_response.status_code, 200)
        list_payload = list_response.get_json()
        update_meta = next((item for item in list_payload["logs"] if item["name"] == "update"), None)
        self.assertIsNotNone(update_meta)
        self.assertTrue(update_meta["exists"])
        self.assertEqual(update_meta["path"], str(update_log))

        self.assertEqual(tail_response.status_code, 200)
        tail_payload = tail_response.get_json()
        self.assertTrue(tail_payload["ok"])
        self.assertEqual(tail_payload["name"], "update")
        self.assertIn("update done", "".join(tail_payload["lines"]))

    def test_update_check_endpoint_returns_latest_release_without_500(self):
        devtools = _reload("routes.devtools")

        latest = {
            "kind": "stable",
            "tag": "v1.7.4",
            "published_at": "2026-04-11T00:00:00Z",
            "asset": {
                "name": "xkeen-ui-routing.tar.gz",
                "download_url": "https://github.com/umarcheh001/Xkeen-UI/releases/download/v1.7.4/xkeen-ui-routing.tar.gz",
            },
            "sha256_asset": {
                "kind": "sidecar",
                "download_url": "https://github.com/umarcheh001/Xkeen-UI/releases/download/v1.7.4/xkeen-ui-routing.tar.gz.sha256",
            },
        }

        with tempfile.TemporaryDirectory() as tmp:
            app = Flask("devtools-update-check-smoke")

            with patch.dict(os.environ, {"XKEEN_UI_UPDATE_DIR": tmp}, clear=False):
                app.register_blueprint(devtools.create_devtools_blueprint(tmp))

            with patch.dict(
                os.environ,
                {"XKEEN_UI_UPDATE_REQUIRE_SHA": "1"},
                clear=False,
            ), patch.object(
                devtools,
                "get_build_info",
                return_value={
                    "version": "1.6.0",
                    "repo": "umarcheh001/Xkeen-UI",
                    "channel": "stable",
                    "commit": "abc1234",
                },
            ), patch.object(
                devtools,
                "github_get_latest_release",
                return_value=({"ok": True, "latest": latest, "meta": {"source": "smoke"}}, False),
            ), patch.object(
                devtools,
                "security_snapshot",
                return_value={"sha_strict": "1", "require_sha": "1"},
            ), patch.object(
                devtools,
                "is_url_allowed",
                return_value=(True, "allowed"),
            ):
                client = app.test_client()
                response = client.post(
                    "/api/devtools/update/check",
                    json={"force_refresh": True, "wait_seconds": 0.5},
                )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["channel"], "stable")
        self.assertTrue(payload["update_available"])
        self.assertEqual(payload["latest"]["tag"], "v1.7.4")
        self.assertEqual(payload["security"]["download"]["ok"], True)
        self.assertEqual(payload["security"]["checksum"]["ok"], True)
        self.assertEqual(payload["security"]["warnings"], [])
        self.assertEqual(payload["security"]["settings"]["require_sha"], "1")
        self.assertFalse(payload["security"]["will_block_run"])

    def test_update_check_blocks_stable_release_when_required_checksum_is_missing(self):
        devtools = _reload("routes.devtools")

        latest = {
            "kind": "stable",
            "tag": "v1.7.4",
            "published_at": "2026-04-11T00:00:00Z",
            "asset": {
                "name": "xkeen-ui-routing.tar.gz",
                "download_url": "https://github.com/umarcheh001/Xkeen-UI/releases/download/v1.7.4/xkeen-ui-routing.tar.gz",
            },
            "sha256_asset": None,
        }

        with tempfile.TemporaryDirectory() as tmp:
            app = Flask("devtools-update-check-require-sha")

            with patch.dict(os.environ, {"XKEEN_UI_UPDATE_DIR": tmp}, clear=False):
                app.register_blueprint(devtools.create_devtools_blueprint(tmp))

            with patch.dict(
                os.environ,
                {"XKEEN_UI_UPDATE_REQUIRE_SHA": "1"},
                clear=False,
            ), patch.object(
                devtools,
                "get_build_info",
                return_value={
                    "version": "1.6.0",
                    "repo": "umarcheh001/Xkeen-UI",
                    "channel": "stable",
                    "commit": "abc1234",
                },
            ), patch.object(
                devtools,
                "github_get_latest_release",
                return_value=({"ok": True, "latest": latest, "meta": {"source": "smoke"}}, False),
            ), patch.object(
                devtools,
                "security_snapshot",
                return_value={"sha_strict": "1", "require_sha": "1"},
            ), patch.object(
                devtools,
                "is_url_allowed",
                return_value=(True, "allowed"),
            ):
                client = app.test_client()
                response = client.post(
                    "/api/devtools/update/check",
                    json={"force_refresh": True, "wait_seconds": 0.5},
                )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["security"]["checksum"]["present"], False)
        self.assertIn("checksum_required_missing", payload["security"]["warnings"])
        self.assertTrue(payload["security"]["will_block_run"])


if __name__ == "__main__":
    unittest.main()
