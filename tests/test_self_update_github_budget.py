from __future__ import annotations

import importlib
import sys
import time
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "xkeen-ui"

if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

github = importlib.import_module("services.self_update.github")

REPO = "umarcheh001/Xkeen-UI"


def _api_release(tag: str) -> dict:
    return {
        "tag_name": tag,
        "name": tag,
        "html_url": f"https://github.com/{REPO}/releases/tag/{tag}",
        "published_at": "2026-10-03T00:00:00Z",
        "draft": False,
        "prerelease": False,
        "body": "Что нового",
        "assets": [
            {
                "name": "xkeen-ui-routing.tar.gz",
                "size": 1,
                "browser_download_url": f"https://github.com/{REPO}/releases/download/{tag}/xkeen-ui-routing.tar.gz",
            }
        ],
    }


@pytest.fixture(autouse=True)
def _clean_state(monkeypatch):
    monkeypatch.delenv("XKEEN_UI_UPDATE_CHECK_CACHE_TTL", raising=False)
    monkeypatch.delenv("XKEEN_UI_UPDATE_BRANCH", raising=False)
    github._REL_CACHE.clear()
    github._REL_FUTURES.clear()
    github._MAIN_CACHE.clear()
    github._MAIN_FUTURES.clear()
    yield
    github._REL_CACHE.clear()
    github._REL_FUTURES.clear()
    github._MAIN_CACHE.clear()
    github._MAIN_FUTURES.clear()


def _count_api(monkeypatch, tag_for_api: str):
    calls = []

    def fake_req_json(url, *, timeout=None):
        calls.append(url)
        return _api_release(tag_for_api), {"url": url, "status": 200}

    monkeypatch.setattr(github, "_req_json", fake_req_json)
    return calls


def test_release_details_are_reused_while_the_latest_tag_has_not_moved(tmp_path, monkeypatch):
    calls = _count_api(monkeypatch, "v2.9.2")
    monkeypatch.setattr(github.github_client, "latest_release_tag", lambda repo, *, timeout: "v2.9.2")

    first = github._fetch_latest_release(REPO, cache_dir=str(tmp_path))
    second = github._fetch_latest_release(REPO, cache_dir=str(tmp_path))

    assert len(calls) == 1
    assert first["latest"]["body"] == "Что нового"
    assert second["ok"] is True
    assert second["latest"]["tag"] == "v2.9.2"
    assert second["latest"]["body"] == "Что нового"


def test_release_details_are_fetched_again_once_a_new_tag_appears(tmp_path, monkeypatch):
    current = ["v2.9.2"]
    calls = []

    def fake_req_json(url, *, timeout=None):
        calls.append(url)
        return _api_release(current[0]), {"url": url, "status": 200}

    monkeypatch.setattr(github, "_req_json", fake_req_json)
    monkeypatch.setattr(github.github_client, "latest_release_tag", lambda repo, *, timeout: current[0])

    github._fetch_latest_release(REPO, cache_dir=str(tmp_path))
    current[0] = "v2.9.3"
    result = github._fetch_latest_release(REPO, cache_dir=str(tmp_path))

    assert len(calls) == 2
    assert result["latest"]["tag"] == "v2.9.3"


def test_update_check_survives_a_panel_restart_without_asking_github(tmp_path, monkeypatch):
    _count_api(monkeypatch, "v2.9.2")
    monkeypatch.setattr(github.github_client, "latest_release_tag", lambda repo, *, timeout: "v2.9.2")
    github.github_get_latest_release(REPO, wait_seconds=2.0, cache_dir=str(tmp_path))

    github._REL_CACHE.clear()
    github._REL_FUTURES.clear()

    def must_not_fetch(*_args, **_kwargs):
        raise AssertionError("GitHub must not be asked while the stored check is fresh")

    monkeypatch.setattr(github, "_fetch_latest_release", must_not_fetch)

    result, stale = github.github_get_latest_release(REPO, wait_seconds=2.0, cache_dir=str(tmp_path))

    assert stale is False
    assert result["latest"]["tag"] == "v2.9.2"


def test_stored_update_check_expires(tmp_path, monkeypatch):
    calls = _count_api(monkeypatch, "v2.9.2")
    monkeypatch.setattr(github.github_client, "latest_release_tag", lambda repo, *, timeout: "v2.9.2")
    github.github_get_latest_release(REPO, wait_seconds=2.0, cache_dir=str(tmp_path))
    github._REL_CACHE.clear()
    github._REL_FUTURES.clear()
    tag_checks = []
    monkeypatch.setattr(
        github.github_client,
        "latest_release_tag",
        lambda repo, *, timeout: tag_checks.append(repo) or "v2.9.2",
    )
    real_time = time.time
    monkeypatch.setattr(github.time, "time", lambda: real_time() + 24 * 3600)

    result, _stale = github.github_get_latest_release(REPO, wait_seconds=2.0, cache_dir=str(tmp_path))

    assert tag_checks == [REPO]
    assert len(calls) == 1
    assert result["latest"]["tag"] == "v2.9.2"


def test_main_channel_with_a_known_branch_costs_one_api_request(monkeypatch):
    calls = []

    def fake_req_json(url, *, timeout=None):
        calls.append(url)
        return {"sha": "a" * 40, "html_url": "https://example.test/commit", "commit": {}}, {"url": url}

    monkeypatch.setattr(github, "_req_json", fake_req_json)

    result = github._fetch_latest_main(REPO, "main")

    assert result["ok"] is True
    assert calls == [f"https://api.github.com/repos/{REPO}/commits/main"]
