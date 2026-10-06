from __future__ import annotations

import email.message
import io
import json
import sys
import urllib.error
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "xkeen-ui"

if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from services import github_client  # noqa: E402


API_URL = "https://api.github.com/repos/XTLS/Xray-core/releases/latest"


class _Response:
    def __init__(self, body: bytes = b"{}", *, status: int = 200, headers: dict[str, str] | None = None):
        self._body = body
        self.status = status
        self.headers = _headers(headers)

    def read(self) -> bytes:
        return self._body

    def geturl(self) -> str:
        return ""

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


def _headers(values: dict[str, str] | None) -> email.message.Message:
    message = email.message.Message()
    for key, value in (values or {}).items():
        message[key] = value
    return message


def _http_error(url: str, status: int, headers: dict[str, str] | None = None) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(url, status, "error", _headers(headers), io.BytesIO(b"{}"))


@pytest.fixture(autouse=True)
def _clean_client(monkeypatch):
    monkeypatch.delenv("XKEEN_UI_GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("XKEEN_UI_GITHUB_API_BASE", raising=False)
    monkeypatch.delenv("XKEEN_UI_GITHUB_WEB_BASE", raising=False)
    github_client.reset_rate_limit_state()
    yield
    github_client.reset_rate_limit_state()


def _record_requests(monkeypatch, responder):
    seen = []

    def fake_open(request, timeout, **_kwargs):
        seen.append(request)
        return responder(request)

    monkeypatch.setattr(github_client, "_open", fake_open)
    return seen


def test_api_request_is_anonymous_without_a_token(monkeypatch):
    seen = _record_requests(monkeypatch, lambda _request: _Response(json.dumps({"tag_name": "v1"}).encode()))

    data, _meta = github_client.api_get_json(API_URL, timeout=3)

    assert data == {"tag_name": "v1"}
    assert seen[0].get_header("Authorization") is None


def test_api_request_carries_the_configured_token(monkeypatch):
    monkeypatch.setenv("XKEEN_UI_GITHUB_TOKEN", "  ghp_example  ")
    seen = _record_requests(monkeypatch, lambda _request: _Response())

    github_client.api_get_json(API_URL, timeout=3)

    assert seen[0].get_header("Authorization") == "Bearer ghp_example"


def test_token_is_never_sent_outside_the_github_api(monkeypatch):
    monkeypatch.setenv("XKEEN_UI_GITHUB_TOKEN", "ghp_example")
    monkeypatch.setenv("XKEEN_UI_GITHUB_API_BASE", "https://mirror.example/api")
    seen = _record_requests(monkeypatch, lambda _request: _Response())

    github_client.api_get_json("https://mirror.example/api/repos/a/b/releases/latest", timeout=3)

    assert seen[0].get_header("Authorization") is None


def test_rate_limit_refusal_stops_further_api_requests_until_reset(monkeypatch):
    now = [1_000_000.0]
    monkeypatch.setattr(github_client.time, "time", lambda: now[0])

    def refuse(request):
        raise _http_error(
            request.full_url,
            403,
            {"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": str(int(now[0]) + 1800)},
        )

    seen = _record_requests(monkeypatch, refuse)

    with pytest.raises(github_client.GitHubRateLimited) as first:
        github_client.api_get_json(API_URL, timeout=3)
    with pytest.raises(github_client.GitHubRateLimited):
        github_client.api_get_json(API_URL, timeout=3)

    assert len(seen) == 1
    assert first.value.retry_at == now[0] + 1800
    assert github_client.rate_limit_retry_at() == now[0] + 1800

    now[0] += 1801
    with pytest.raises(github_client.GitHubRateLimited):
        github_client.api_get_json(API_URL, timeout=3)
    assert len(seen) == 2


def test_retry_after_header_is_honoured_when_reset_time_is_absent(monkeypatch):
    now = [1_000_000.0]
    monkeypatch.setattr(github_client.time, "time", lambda: now[0])
    _record_requests(monkeypatch, lambda request: (_ for _ in ()).throw(_http_error(request.full_url, 429, {"Retry-After": "120"})))

    with pytest.raises(github_client.GitHubRateLimited) as refused:
        github_client.api_get_json(API_URL, timeout=3)

    assert refused.value.retry_at == now[0] + 120


def test_ordinary_http_errors_do_not_pause_the_api(monkeypatch):
    seen = _record_requests(monkeypatch, lambda request: (_ for _ in ()).throw(_http_error(request.full_url, 500)))

    for _ in range(2):
        with pytest.raises(urllib.error.HTTPError):
            github_client.api_get_json(API_URL, timeout=3)

    assert len(seen) == 2
    assert github_client.rate_limit_retry_at() == 0.0


def test_a_new_token_lifts_the_pause_set_for_anonymous_requests(monkeypatch):
    now = [1_000_000.0]
    monkeypatch.setattr(github_client.time, "time", lambda: now[0])
    answers = [
        _http_error(API_URL, 403, {"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": str(int(now[0]) + 1800)}),
        _Response(b'{"tag_name": "v2"}'),
    ]

    def respond(_request):
        answer = answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    _record_requests(monkeypatch, respond)
    with pytest.raises(github_client.GitHubRateLimited):
        github_client.api_get_json(API_URL, timeout=3)

    monkeypatch.setenv("XKEEN_UI_GITHUB_TOKEN", "ghp_example")
    data, _meta = github_client.api_get_json(API_URL, timeout=3)

    assert data == {"tag_name": "v2"}


def test_latest_release_tag_comes_from_the_web_redirect_not_the_api(monkeypatch):
    def redirect(request):
        raise _http_error(
            request.full_url,
            302,
            {"Location": "https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.2%2Bfix"},
        )

    seen = _record_requests(monkeypatch, redirect)

    tag = github_client.latest_release_tag("MetaCubeX/mihomo", timeout=3)

    assert tag == "v1.19.2+fix"
    assert [request.full_url for request in seen] == ["https://github.com/MetaCubeX/mihomo/releases/latest"]


def test_latest_release_tag_is_none_for_a_repository_without_releases(monkeypatch):
    _record_requests(
        monkeypatch,
        lambda request: (_ for _ in ()).throw(
            _http_error(request.full_url, 302, {"Location": "https://github.com/a/b/releases"})
        ),
    )

    assert github_client.latest_release_tag("a/b", timeout=3) is None


def test_latest_release_tag_works_while_the_api_is_paused(monkeypatch):
    now = [1_000_000.0]
    monkeypatch.setattr(github_client.time, "time", lambda: now[0])

    def respond(request):
        if "api.github.com" in request.full_url:
            raise _http_error(request.full_url, 403, {"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": str(int(now[0]) + 600)})
        raise _http_error(request.full_url, 302, {"Location": "https://github.com/XTLS/Xray-core/releases/tag/v26.9.1"})

    _record_requests(monkeypatch, respond)
    with pytest.raises(github_client.GitHubRateLimited):
        github_client.api_get_json(API_URL, timeout=3)

    assert github_client.latest_release_tag("XTLS/Xray-core", timeout=3) == "v26.9.1"
