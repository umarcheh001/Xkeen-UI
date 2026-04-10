from __future__ import annotations

import importlib
import io
import sys
import urllib.error
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "xkeen-ui"

if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))


def _reload(name: str):
    module = sys.modules.get(name)
    if module is not None:
        return importlib.reload(module)
    return importlib.import_module(name)


class SelfUpdateGithubFallbackTests(unittest.TestCase):
    def test_fetch_latest_release_from_web_resolves_tag_and_assets(self):
        github = _reload("services.self_update.github")

        repo = "umarcheh001/Xkeen-UI"
        latest_url = f"https://github.com/{repo}/releases/latest"
        asset_url = f"https://github.com/{repo}/releases/latest/download/xkeen-ui-routing.tar.gz"
        sha_url = f"https://github.com/{repo}/releases/latest/download/xkeen-ui-routing.tar.gz.sha256"

        def fake_req_no_redirect(url: str, *, timeout=None, headers=None):
            if url == latest_url:
                return {
                    "url": url,
                    "status": 302,
                    "location": f"https://github.com/{repo}/releases/tag/v1.7.3",
                    "final_url": latest_url,
                }
            if url == asset_url:
                return {
                    "url": url,
                    "status": 302,
                    "location": "https://release-assets.githubusercontent.com/fake-asset",
                    "final_url": url,
                }
            if url == sha_url:
                return {
                    "url": url,
                    "status": 302,
                    "location": "https://release-assets.githubusercontent.com/fake-sha",
                    "final_url": url,
                }
            raise urllib.error.HTTPError(url, 404, "Not Found", None, None)

        with patch.object(github, "_cfg_github_web_base", lambda: "https://github.com"):
            with patch.object(github, "_release_asset_candidates", lambda: ["xkeen-ui-routing.tar.gz"]):
                with patch.object(github, "_sha_candidate_names", lambda asset_name: ["xkeen-ui-routing.tar.gz.sha256"]):
                    with patch.object(github, "_req_no_redirect", fake_req_no_redirect):
                        result = github._fetch_latest_release_from_web(repo, fallback_meta={"status": 500, "message": "api failed"})

        self.assertTrue(result["ok"])
        self.assertIsNone(result["error"])
        self.assertEqual(result["latest"]["tag"], "v1.7.3")
        self.assertEqual(result["latest"]["html_url"], f"https://github.com/{repo}/releases/tag/v1.7.3")
        self.assertEqual(result["latest"]["asset"]["download_url"], asset_url)
        self.assertEqual(result["latest"]["sha256_asset"]["download_url"], sha_url)
        self.assertEqual(result["meta"]["source"], "github_web_fallback")
        self.assertEqual(result["meta"]["api"]["status"], 500)

    def test_fetch_latest_release_uses_web_fallback_when_api_errors(self):
        github = _reload("services.self_update.github")

        api_error = urllib.error.HTTPError(
            "https://api.github.com/repos/umarcheh001/Xkeen-UI/releases/latest",
            500,
            "Server Error",
            None,
            io.BytesIO(b"<html>Internal Server Error</html>"),
        )

        def fake_req_json(url: str, *, timeout=None):
            raise api_error

        seen: dict[str, object] = {}

        def fake_web_fallback(repo: str, *, fallback_meta=None):
            seen["repo"] = repo
            seen["fallback_meta"] = dict(fallback_meta or {})
            return {
                "ok": True,
                "error": None,
                "latest": {
                    "tag": "v1.7.3",
                    "name": "v1.7.3",
                    "html_url": "https://github.com/umarcheh001/Xkeen-UI/releases/tag/v1.7.3",
                    "published_at": None,
                    "draft": False,
                    "prerelease": False,
                    "body": "",
                    "assets": [],
                    "asset": None,
                    "sha256_asset": None,
                },
                "meta": {"repo": repo, "source": "github_web_fallback"},
            }

        with patch.object(github, "_req_json", fake_req_json):
            with patch.object(github, "_fetch_latest_release_from_web", fake_web_fallback):
                result = github._fetch_latest_release("umarcheh001/Xkeen-UI")

        self.assertTrue(result["ok"])
        self.assertEqual(result["latest"]["tag"], "v1.7.3")
        self.assertEqual(seen["repo"], "umarcheh001/Xkeen-UI")
        self.assertEqual(seen["fallback_meta"]["status"], 500)
        self.assertIn("Internal Server Error", seen["fallback_meta"]["message"])


if __name__ == "__main__":
    unittest.main()
