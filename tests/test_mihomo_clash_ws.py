from __future__ import annotations

import json

from services.mihomo_clash_client import MihomoClashClientError, MihomoClashJSONResponse
from services.mihomo_clash_target import MihomoClashDiscovery, MihomoClashTarget
from services.mihomo_clash_ws import (
    handle_mihomo_clash_connections_request,
    is_same_origin_websocket,
)


class StubWebSocket:
    def __init__(self, *, fail_after: int | None = None):
        self.messages: list[dict] = []
        self.closed = False
        self.fail_after = fail_after

    def send(self, raw: str):
        if self.fail_after is not None and len(self.messages) >= self.fail_after:
            raise RuntimeError("browser closed")
        self.messages.append(json.loads(raw))

    def close(self):
        self.closed = True


class StubClient:
    def __init__(self, responses=None, error=None):
        self.responses = list(responses or [])
        self.error = error

    def request_json(self, operation: str):
        assert operation == "connections_snapshot"
        if self.error:
            raise self.error
        return MihomoClashJSONResponse(self.responses.pop(0), 200, 1, 100)


def discovery():
    return MihomoClashDiscovery(
        configured=True,
        target=MihomoClashTarget(
            transport="tcp", port=9090, loopback_host="127.0.0.1"
        ),
    )


def environ(ws, **overrides):
    base = {
        "wsgi.websocket": ws,
        "QUERY_STRING": "token=one-time-secret",
        "HTTP_ORIGIN": "https://panel.test",
        "HTTP_HOST": "panel.test",
        "REMOTE_ADDR": "192.0.2.5",
    }
    base.update(overrides)
    return base


def test_same_origin_requires_matching_browser_origin():
    assert is_same_origin_websocket(environ(StubWebSocket())) is True
    assert is_same_origin_websocket(environ(StubWebSocket(), HTTP_ORIGIN="https://evil.test")) is False
    assert is_same_origin_websocket(environ(StubWebSocket(), HTTP_ORIGIN="")) is False


def test_ws_rejects_origin_before_consuming_token():
    ws = StubWebSocket()
    validated = []
    handle_mihomo_clash_connections_request(
        environ(ws, HTTP_ORIGIN="https://evil.test"),
        lambda *_args: None,
        fallback_app=lambda *_args: [],
        validate_ws_token=lambda token, scope: validated.append((token, scope)) or True,
        ws_debug=lambda *_args, **_kwargs: None,
        mihomo_config_file="/safe/config.yaml",
        mihomo_root="/safe",
    )

    assert ws.messages[0]["error"]["code"] == "origin_rejected"
    assert validated == []
    assert ws.closed is True


def test_ws_streams_versioned_bounded_dto_and_stops_when_browser_closes(monkeypatch):
    ws = StubWebSocket(fail_after=1)
    clients = []

    def client_factory(_target):
        client = StubClient(
            [{"downloadTotal": 10, "connections": [{"id": "one", "metadata": {}}]}]
        )
        clients.append(client)
        return client

    monkeypatch.setattr("services.mihomo_clash_ws._cooperative_sleep", lambda _seconds: None)
    handle_mihomo_clash_connections_request(
        environ(ws),
        lambda *_args: None,
        fallback_app=lambda *_args: [],
        validate_ws_token=lambda token, scope: token == "one-time-secret" and scope == "mihomo-clash",
        ws_debug=lambda *_args, **_kwargs: None,
        mihomo_config_file="/safe/config.yaml",
        mihomo_root="/safe",
        discovery_factory=lambda *_args: discovery(),
        client_factory=client_factory,
        device_map_factory=lambda: {},
    )

    message = ws.messages[0]
    assert message["type"] == "mihomo-clash-connections"
    assert message["schema_version"] == 1
    assert message["sequence"] == 1
    assert message["state"] == "live"
    assert message["payload"]["connections"][0]["id"] == "one"
    assert ws.closed is True


def test_ws_maps_upstream_error_without_leaking_exception_text():
    ws = StubWebSocket()
    error = MihomoClashClientError(
        "upstream_unreachable", "secret socket path", retryable=True
    )
    handle_mihomo_clash_connections_request(
        environ(ws),
        lambda *_args: None,
        fallback_app=lambda *_args: [],
        validate_ws_token=lambda _token, scope: scope == "mihomo-clash",
        ws_debug=lambda *_args, **_kwargs: None,
        mihomo_config_file="/safe/config.yaml",
        mihomo_root="/safe",
        discovery_factory=lambda *_args: discovery(),
        client_factory=lambda _target: StubClient(error=error),
        device_map_factory=lambda: {},
    )

    serialized = json.dumps(ws.messages)
    assert ws.messages[-1]["error"] == {
        "code": "upstream_unreachable",
        "retryable": True,
    }
    assert "secret socket" not in serialized
