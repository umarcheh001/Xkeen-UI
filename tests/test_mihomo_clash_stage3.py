from __future__ import annotations

import json

import pytest

from services.mihomo_clash_client import (
    MIHOMO_CLASH_ENDPOINTS,
    MihomoClashClient,
    MihomoClashClientError,
)
from services.mihomo_clash_dto import (
    build_mihomo_clash_connections_dto,
    build_mihomo_clash_rules_dto,
)
from services.mihomo_clash_target import MihomoClashDiscovery, MihomoClashTarget
from services.mihomo_clash_ws import handle_mihomo_clash_logs_request


def test_rule_counters_and_future_scalar_extra_fields_are_preserved_bounded():
    dto = build_mihomo_clash_rules_dto(
        {
            "rules": [
                {
                    "type": "DomainSuffix",
                    "payload": "example.test",
                    "proxy": "AUTO",
                    "extra": {
                        "hitCount": 7,
                        "hitAt": "2026-09-10T10:00:00Z",
                        "missCount": 2,
                        "missAt": 1_789_000_000,
                        "futureScalar": "supported",
                        "futureNested": {"secret": "drop"},
                    },
                }
            ]
        }
    )

    rule = dto["rules"][0]
    assert {key: rule[key] for key in ("hitCount", "hitAt", "missCount", "missAt")} == {
        "hitCount": 7,
        "hitAt": "2026-09-10T10:00:00Z",
        "missCount": 2,
        "missAt": 1_789_000_000,
    }
    assert rule["extra"] == {"futureScalar": "supported"}
    assert dto["rule_counters"] == {
        "available": True,
        "fields": ["hitCount", "hitAt", "missCount", "missAt"],
    }


def test_connection_explainability_distinguishes_confirmed_and_partial_chains():
    payload = {
        "connections": [
            {
                "id": "complete",
                "start": "2026-09-10T10:00:00Z",
                "metadata": {"sourceIP": "192.0.2.10", "sniffHost": "example.test"},
                "rule": "DomainSuffix",
                "rulePayload": "example.test",
                "chains": ["AUTO", "node-a"],
            },
            {"id": "partial", "metadata": {"sourceIP": "192.0.2.11"}},
        ]
    }
    dto = build_mihomo_clash_connections_dto(
        payload,
        device_map={"192.0.2.10": {"name": "Laptop", "updated_at": 1_789_000_000}},
    )

    confirmed = dto["connections"][0]["routing_explanation"]
    assert confirmed["confirmed"] is True
    assert [item["kind"] for item in confirmed["chain"]] == [
        "device", "host", "rule", "group", "selected_node",
    ]
    assert [item["source"] for item in confirmed["chain"]] == [
        "keenetic-map", "mihomo", "mihomo", "mihomo", "mihomo",
    ]
    assert all("timestamp" in item for item in confirmed["chain"])

    partial = dto["connections"][1]["routing_explanation"]
    assert partial["confirmed"] is False
    assert partial["status"] == "partial"
    assert set(partial["missing"]) == {"device", "host", "rule", "group", "selected_node"}
    assert all(item.get("reason") for item in partial["chain"] if not item["value"])


def test_log_stream_defaults_to_info_and_rejects_non_allowlisted_levels():
    assert MIHOMO_CLASH_ENDPOINTS["logs_stream"].path == "/logs?level=info&format=structured"
    client = MihomoClashClient(MihomoClashTarget(transport="tcp", loopback_host="127.0.0.1", port=9))
    with pytest.raises(MihomoClashClientError) as captured:
        list(client.iter_json_frames("logs_stream", log_level="trace"))
    assert captured.value.code == "log_level_not_allowed"


class _WebSocket:
    def __init__(self):
        self.messages: list[dict] = []
        self.closed = False

    def send(self, value: str):
        self.messages.append(json.loads(value))

    def close(self):
        self.closed = True


class _LogClient:
    def __init__(self, captured: list[dict]):
        self.captured = captured

    def iter_json_frames(self, operation: str, **kwargs):
        self.captured.append({"operation": operation, **kwargs})
        yield {"level": "info", "message": "bounded"}


def _discovery() -> MihomoClashDiscovery:
    return MihomoClashDiscovery(
        configured=True,
        target=MihomoClashTarget(transport="tcp", loopback_host="127.0.0.1", port=9090),
    )


def test_logs_ws_passes_only_the_selected_upstream_level_and_defaults_to_info():
    captured: list[dict] = []
    ws = _WebSocket()
    handle_mihomo_clash_logs_request(
        {
            "wsgi.websocket": ws,
            "QUERY_STRING": "token=secret",
            "HTTP_ORIGIN": "https://panel.test",
            "HTTP_HOST": "panel.test",
            "REMOTE_ADDR": "192.0.2.10",
        },
        lambda *_args: None,
        fallback_app=lambda *_args: [],
        validate_ws_token=lambda token, scope: token == "secret" and scope == "mihomo-clash-logs",
        ws_debug=lambda *_args, **_kwargs: None,
        mihomo_config_file="/safe/config.yaml",
        mihomo_root="/safe",
        discovery_factory=lambda *_args: _discovery(),
        client_factory=lambda _target: _LogClient(captured),
        device_map_factory=lambda: {},
    )

    assert captured[0]["operation"] == "logs_stream"
    assert captured[0]["log_level"] == "info"
    assert ws.messages[0]["payload"]["message"] == "bounded"
    assert ws.closed is True

    rejected = _WebSocket()
    handle_mihomo_clash_logs_request(
        {
            "wsgi.websocket": rejected,
            "QUERY_STRING": "token=secret&level=trace",
            "HTTP_ORIGIN": "https://panel.test",
            "HTTP_HOST": "panel.test",
            "REMOTE_ADDR": "192.0.2.11",
        },
        lambda *_args: None,
        fallback_app=lambda *_args: [],
        validate_ws_token=lambda *_args, **_kwargs: True,
        ws_debug=lambda *_args, **_kwargs: None,
        mihomo_config_file="/safe/config.yaml",
        mihomo_root="/safe",
    )
    assert rejected.messages[0]["error"]["code"] == "log_level_not_allowed"
    assert rejected.closed is True
