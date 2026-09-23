"""Чтение одной ветки RCI: адрес, разбор и честное падение.

`fetch_rci_json` ничего не проглатывает намеренно: у каждого вызывающего свой
запасной путь, и решать за него, чем заменить молчание прошивки, эта функция
не должна.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request

import pytest

from services import keenetic_rci as rci


class _Response:
    def __init__(self, payload: bytes) -> None:
        self._payload = payload
        self.status = 200

    def read(self, limit: int = -1) -> bytes:
        return self._payload[:limit] if limit and limit > 0 else self._payload

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture
def served(monkeypatch):
    seen: dict = {}

    def install(payload, *, boom: Exception | None = None):
        def fake_urlopen(request, timeout=None):
            seen["url"] = request.full_url
            seen["timeout"] = timeout
            if boom is not None:
                raise boom
            return _Response(payload)

        monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
        return seen

    return install


def test_relative_path_goes_to_the_local_rci(served) -> None:
    seen = served(json.dumps({"disk": {"disk": "ENTWARE:/"}}).encode())
    assert rci.fetch_rci_json("/rci/opkg") == {"disk": {"disk": "ENTWARE:/"}}
    assert seen["url"] == "http://127.0.0.1:79/rci/opkg"


def test_path_without_leading_slash_still_works(served) -> None:
    seen = served(b"{}")
    rci.fetch_rci_json("rci/opkg")
    assert seen["url"] == "http://127.0.0.1:79/rci/opkg"


def test_absolute_url_is_left_alone(served) -> None:
    seen = served(b"{}")
    rci.fetch_rci_json("http://192.168.1.1:79/rci/opkg")
    assert seen["url"] == "http://192.168.1.1:79/rci/opkg"


def test_timeout_is_passed_through(served) -> None:
    seen = served(b"{}")
    rci.fetch_rci_json("/rci/opkg", timeout=0.25)
    assert seen["timeout"] == 0.25


def test_http_error_is_not_swallowed(served) -> None:
    served(b"", boom=urllib.error.HTTPError("u", 403, "forbidden", None, None))
    with pytest.raises(urllib.error.HTTPError):
        rci.fetch_rci_json("/rci/opkg")


def test_body_that_is_not_json_raises(served) -> None:
    served(b"<html>nope</html>")
    with pytest.raises(json.JSONDecodeError):
        rci.fetch_rci_json("/rci/opkg")
