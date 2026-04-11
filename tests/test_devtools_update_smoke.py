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
        self.assertEqual(payload["security"]["sha_strict"], "1")

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
