from __future__ import annotations

import base64
import json
import threading
from pathlib import Path

import pytest


def _vless(name: str = "Node") -> str:
    return (
        "vless://user@example.com:443"
        "?type=tcp&security=reality&sni=edge.example.com&pbk=pubkey&encryption=none"
        f"#{name}"
    )


def _trojan(name: str = "Node") -> str:
    safe_name = str(name or "").replace(" ", "%20")
    return f"trojan://secret@example.net:443?security=tls&sni=edge.example.com#{safe_name}"


def _vless_transport(name: str, transport: str, *, host: str = "example.com") -> str:
    safe_name = str(name or "").replace(" ", "%20")
    query = [f"type={transport}", "security=tls", "sni=edge.example.com", "encryption=none"]
    if transport == "ws":
        query.extend(["host=cdn.example.com", "path=%2Fws"])
    elif transport == "grpc":
        query.append("serviceName=grpc")
    elif transport == "xhttp":
        query.extend(["host=cdn.example.com", "path=%2Fx"])
    return f"vless://user@{host}:443?{'&'.join(query)}#{safe_name}"


def test_parse_subscription_links_accepts_plain_and_base64_payloads():
    from services.xray_subscriptions import parse_subscription_links

    plain = _vless("Plain") + "\nunknown://skip\n" + _vless("Second")
    assert parse_subscription_links(plain) == [_vless("Plain"), _vless("Second")]

    encoded = base64.b64encode(plain.encode("utf-8")).decode("ascii")
    assert parse_subscription_links(encoded) == [_vless("Plain"), _vless("Second")]


def test_upsert_subscription_validates_regex_filters(tmp_path: Path):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    ui_state_dir.mkdir()

    with pytest.raises(ValueError, match="regex"):
        subs.upsert_subscription(
            str(ui_state_dir),
            {
                "id": "demo",
                "url": "https://example.com/sub",
                "name_filter": "(",
            },
        )


def test_refresh_subscription_writes_generated_fragment_and_observatory(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (_vless("Fast Node"), {"profile-update-interval": "2"}),
    )

    sub = subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "demo",
            "name": "Demo",
            "tag": "demo",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": True,
            "interval_hours": 6,
        },
    )
    assert sub["id"] == "demo"

    restarts = []
    result = subs.refresh_subscription(
        str(ui_state_dir),
        "demo",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **kwargs: restarts.append(kwargs) or True,
        restart=True,
    )

    assert result["ok"] is True
    assert result["count"] == 1
    assert result["changed"] is True
    assert result["observatory_changed"] is True
    assert result["restarted"] is True
    assert restarts and restarts[0]["source"] == "xray-subscription-refresh"

    out_path = xray_dir / "04_outbounds.demo.json"
    generated = json.loads(out_path.read_text(encoding="utf-8"))
    assert list(generated) == ["outbounds"]
    assert len(generated["outbounds"]) == 1
    assert generated["outbounds"][0]["tag"] == "demo--Fast_Node"
    assert generated["outbounds"][0]["protocol"] == "vless"

    observatory = json.loads((xray_dir / "07_observatory.json").read_text(encoding="utf-8"))
    assert observatory["observatory"]["subjectSelector"] == ["demo--Fast_Node"]

    state = subs.load_subscription_state(str(ui_state_dir))
    saved = state["subscriptions"][0]
    assert saved["last_ok"] is True
    assert saved["last_count"] == 1
    assert saved["profile_update_interval_hours"] == 2
    assert saved["interval_hours"] == 2

    restarts.clear()
    second = subs.refresh_subscription(
        str(ui_state_dir),
        "demo",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **kwargs: restarts.append(kwargs) or True,
        restart=True,
    )
    assert second["ok"] is True
    assert second["changed"] is False
    assert second["observatory_changed"] is False
    assert second["restarted"] is False
    assert restarts == []


def test_refresh_subscription_applies_name_and_type_filters_to_links(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (
            "\n".join(
                [
                    _vless("Germany-01"),
                    _trojan("Sweden-02"),
                    _vless("Netherlands-03"),
                ]
            ),
            {},
        ),
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "filtered",
            "tag": "flt",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": False,
            "name_filter": "Germany|Netherlands",
            "type_filter": "vless",
        },
    )

    result = subs.refresh_subscription(
        str(ui_state_dir),
        "filtered",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=False,
    )

    assert result["ok"] is True
    assert result["count"] == 2
    assert result["source_count"] == 3
    assert result["filtered_out_count"] == 1
    assert result["tags"] == ["flt--Germany-01", "flt--Netherlands-03"]

    generated = json.loads((xray_dir / "04_outbounds.filtered.json").read_text(encoding="utf-8"))
    assert [item["tag"] for item in generated["outbounds"]] == ["flt--Germany-01", "flt--Netherlands-03"]

    state = subs.load_subscription_state(str(ui_state_dir))
    saved = state["subscriptions"][0]
    assert saved["name_filter"] == "Germany|Netherlands"
    assert saved["type_filter"] == "vless"
    assert saved["last_source_count"] == 3
    assert saved["last_filtered_out_count"] == 1


def test_build_subscription_outbounds_applies_transport_filter_and_manual_exclusions():
    from services import xray_subscriptions as subs

    links = [
        _vless_transport("Germany WS", "ws"),
        _vless_transport("Sweden GRPC", "grpc"),
        _vless_transport("Netherlands TCP", "tcp"),
    ]

    outbounds, errors, stats = subs.build_subscription_outbounds(
        links,
        tag_prefix="flt",
        transport_filter="ws|grpc",
    )

    assert errors == []
    assert [item["tag"] for item in outbounds] == ["flt--Germany_WS", "flt--Sweden_GRPC"]
    assert stats["source_count"] == 3
    assert stats["filtered_out_count"] == 1
    assert [item["transport"] for item in stats["nodes"]] == ["ws", "grpc", "tcp"]

    grpc_key = next(item["key"] for item in stats["nodes"] if item["transport"] == "grpc")
    outbounds, errors, stats = subs.build_subscription_outbounds(
        links,
        tag_prefix="flt",
        transport_filter="ws|grpc",
        excluded_node_keys=[grpc_key],
    )

    assert errors == []
    assert [item["tag"] for item in outbounds] == ["flt--Germany_WS"]
    assert stats["source_count"] == 3
    assert stats["filtered_out_count"] == 2


def test_refresh_subscription_accepts_xray_json_config_arrays(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)

    subscription_body = json.dumps(
        [
            {
                "remarks": "JSON Node",
                "outbounds": [
                    {
                        "tag": "proxy",
                        "protocol": "vless",
                        "settings": {
                            "vnext": [
                                {
                                    "address": "example.com",
                                    "port": 443,
                                    "users": [{"id": "user", "encryption": "none"}],
                                }
                            ]
                        },
                        "streamSettings": {"network": "tcp", "security": "reality"},
                    },
                    {"tag": "direct", "protocol": "freedom", "settings": {}},
                    {"tag": "block", "protocol": "blackhole", "settings": {}},
                ],
            }
        ]
    )
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (subscription_body, {"content-type": "application/json"}),
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "json-demo",
            "tag": "json",
            "url": "https://example.com/json",
            "enabled": True,
            "ping_enabled": True,
        },
    )

    result = subs.refresh_subscription(
        str(ui_state_dir),
        "json-demo",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=True,
    )

    assert result["ok"] is True
    assert result["source_format"] == "xray-json"
    assert result["count"] == 1
    assert result["source_count"] == 1
    assert result["filtered_out_count"] == 0
    assert result["tags"] == ["json--JSON_Node"]

    generated = json.loads((xray_dir / "04_outbounds.json-demo.json").read_text(encoding="utf-8"))
    assert len(generated["outbounds"]) == 1
    assert generated["outbounds"][0]["protocol"] == "vless"
    assert generated["outbounds"][0]["tag"] == "json--JSON_Node"


def test_refresh_subscription_applies_filters_to_xray_json_payloads(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)

    subscription_body = json.dumps(
        [
            {
                "remarks": "Primary Germany",
                "outbounds": [
                    {
                        "tag": "proxy",
                        "protocol": "vless",
                        "settings": {
                            "vnext": [
                                {
                                    "address": "example.com",
                                    "port": 443,
                                    "users": [{"id": "user", "encryption": "none"}],
                                }
                            ]
                        },
                    }
                ],
            },
            {
                "remarks": "Backup Sweden",
                "outbounds": [
                    {
                        "tag": "proxy",
                        "protocol": "trojan",
                        "settings": {
                            "servers": [{"address": "backup.example.com", "port": 443, "password": "secret"}]
                        },
                    }
                ],
            },
        ]
    )
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (subscription_body, {"content-type": "application/json"}),
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "json-filter",
            "tag": "jsonf",
            "url": "https://example.com/json",
            "enabled": True,
            "ping_enabled": False,
            "name_filter": "Primary",
            "type_filter": "vless",
        },
    )

    result = subs.refresh_subscription(
        str(ui_state_dir),
        "json-filter",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=False,
    )

    assert result["ok"] is True
    assert result["source_format"] == "xray-json"
    assert result["count"] == 1
    assert result["source_count"] == 2
    assert result["filtered_out_count"] == 1
    assert result["tags"] == ["jsonf--Primary_Germany"]


def test_refresh_subscription_persists_last_nodes_with_transport_metadata(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)

    subscription_body = json.dumps(
        [
            {
                "remarks": "WS Germany",
                "outbounds": [
                    {
                        "tag": "proxy",
                        "protocol": "vless",
                        "settings": {
                            "vnext": [
                                {
                                    "address": "ws.example.com",
                                    "port": 443,
                                    "users": [{"id": "user", "encryption": "none"}],
                                }
                            ]
                        },
                        "streamSettings": {
                            "network": "ws",
                            "security": "tls",
                            "wsSettings": {
                                "path": "/ws",
                                "headers": {"Host": "cdn.example.com"},
                            },
                        },
                    }
                ],
            },
            {
                "remarks": "GRPC Sweden",
                "outbounds": [
                    {
                        "tag": "proxy",
                        "protocol": "vless",
                        "settings": {
                            "vnext": [
                                {
                                    "address": "grpc.example.com",
                                    "port": 443,
                                    "users": [{"id": "user", "encryption": "none"}],
                                }
                            ]
                        },
                        "streamSettings": {
                            "network": "grpc",
                            "security": "reality",
                            "grpcSettings": {"serviceName": "grpc-svc"},
                        },
                    }
                ],
            },
        ]
    )
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (subscription_body, {"content-type": "application/json"}),
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "json-transport",
            "tag": "jsont",
            "url": "https://example.com/json",
            "enabled": True,
            "ping_enabled": False,
            "transport_filter": "grpc",
        },
    )

    result = subs.refresh_subscription(
        str(ui_state_dir),
        "json-transport",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=False,
    )

    assert result["ok"] is True
    assert result["source_format"] == "xray-json"
    assert result["count"] == 1
    assert result["source_count"] == 2
    assert result["filtered_out_count"] == 1
    assert result["tags"] == ["jsont--GRPC_Sweden"]
    assert [item["transport"] for item in result["last_nodes"]] == ["ws", "grpc"]
    assert result["last_nodes"][0].get("tag") in ("", None)
    assert result["last_nodes"][1]["tag"] == "jsont--GRPC_Sweden"
    assert result["last_nodes"][0]["detail"] == "path=/ws · host=cdn.example.com"
    assert result["last_nodes"][1]["detail"] == "service=grpc-svc"

    state = subs.load_subscription_state(str(ui_state_dir))
    saved = state["subscriptions"][0]
    assert saved["transport_filter"] == "grpc"
    assert saved["last_filtered_out_count"] == 1
    assert [item["transport"] for item in saved["last_nodes"]] == ["ws", "grpc"]
    assert saved["last_nodes"][1]["tag"] == "jsont--GRPC_Sweden"


def test_probe_subscription_node_latency_updates_state(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (_vless_transport("Ping Node", "ws", host="ping.example.com"), {}),
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "probe-demo",
            "tag": "probed",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": False,
        },
    )

    refresh = subs.refresh_subscription(
        str(ui_state_dir),
        "probe-demo",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=False,
    )

    node = refresh["last_nodes"][0]
    assert node["tag"] == refresh["tags"][0]

    def _fake_probe_outbounds_batch(*, xray_bin, targets, probe_url, timeout_value, concurrency=3):
        assert xray_bin == "/opt/sbin/xray"
        assert probe_url == "https://probe.example.com/generate_204"
        assert float(timeout_value or 0) == pytest.approx(8.0)
        assert int(concurrency or 0) == subs.PROBE_BATCH_CONCURRENCY
        assert len(targets) == 1
        assert targets[0]["key"] == node["key"]
        assert targets[0]["tag"] == node["tag"]
        return {node["key"]: {"delay_ms": 123, "error": ""}}

    monkeypatch.setattr(subs, "_find_xray_binary", lambda: "/opt/sbin/xray")
    monkeypatch.setattr(subs, "_probe_url_for_subscription", lambda _dir: "https://probe.example.com/generate_204")
    monkeypatch.setattr(subs, "_probe_outbounds_batch", _fake_probe_outbounds_batch)

    result = subs.probe_subscription_node_latency(
        str(ui_state_dir),
        "probe-demo",
        node["key"],
        xray_configs_dir=str(xray_dir),
        timeout_s=8,
    )

    assert result["ok"] is True
    assert result["tag"] == node["tag"]
    assert result["delay_ms"] == 123
    assert result["entry"]["delay_ms"] == 123
    assert result["entry"]["status"] == "ok"
    assert result["entry"]["history"][0]["delay_ms"] == 123

    state = subs.load_subscription_state(str(ui_state_dir))
    saved = state["subscriptions"][0]
    assert saved["node_latency"][node["key"]]["delay_ms"] == 123
    assert saved["node_latency"][node["key"]]["history"][0]["status"] == "ok"


def test_probe_subscription_nodes_latency_updates_state_once(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (
            "\n".join(
                [
                    _vless_transport("Ping One", "ws", host="one.example.com"),
                    _vless_transport("Ping Two", "grpc", host="two.example.com"),
                ]
            ),
            {},
        ),
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "probe-bulk",
            "tag": "probebulk",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": False,
        },
    )

    refresh = subs.refresh_subscription(
        str(ui_state_dir),
        "probe-bulk",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=False,
    )

    nodes = list(refresh["last_nodes"])
    assert len(nodes) == 2

    class _FakeProc:
        def poll(self):
            return None

    popen_calls = {"count": 0}
    write_calls = {"count": 0}
    original_write_state = subs._write_state

    def _counting_write_state(*args, **kwargs):
        write_calls["count"] += 1
        return original_write_state(*args, **kwargs)

    def _counting_popen(*args, **kwargs):
        popen_calls["count"] += 1
        return _FakeProc()

    probe_delays = [(123, ""), (456, "")]
    probe_lock = threading.Lock()

    def _fake_probe_via_local_proxy(_port, _probe_url, timeout_value):
        assert _probe_url == "https://probe.example.com/generate_204"
        assert float(timeout_value or 0) == pytest.approx(8.0)
        with probe_lock:
            return probe_delays.pop(0)

    monkeypatch.setattr(subs, "_find_xray_binary", lambda: "/opt/sbin/xray")
    monkeypatch.setattr(subs, "_wait_for_local_ports", lambda _ports, _proc, _timeout: True)
    monkeypatch.setattr(subs, "_terminate_process", lambda _proc, timeout_s=1.5: ("", ""))
    monkeypatch.setattr(subs, "_probe_url_for_subscription", lambda _dir: "https://probe.example.com/generate_204")
    monkeypatch.setattr(subs.subprocess, "Popen", _counting_popen)
    monkeypatch.setattr(subs, "_probe_via_local_proxy", _fake_probe_via_local_proxy)
    monkeypatch.setattr(subs, "_write_state", _counting_write_state)

    result = subs.probe_subscription_nodes_latency(
        str(ui_state_dir),
        "probe-bulk",
        [nodes[0]["key"], nodes[1]["key"]],
        xray_configs_dir=str(xray_dir),
        timeout_s=8,
    )

    assert result["ok"] is True
    assert result["ok_count"] == 2
    assert result["failed_count"] == 0
    assert result["updated"] == 2
    assert len(result["results"]) == 2
    assert result["results"][0]["entry"]["status"] == "ok"
    assert result["results"][1]["entry"]["status"] == "ok"
    assert write_calls["count"] == 1
    assert popen_calls["count"] == 1

    state = subs.load_subscription_state(str(ui_state_dir))
    saved = state["subscriptions"][0]
    assert saved["node_latency"][nodes[0]["key"]]["delay_ms"] == 123
    assert saved["node_latency"][nodes[1]["key"]]["delay_ms"] == 456


def test_probe_subscription_nodes_latency_retries_process_start(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (_vless_transport("Retry Node", "ws", host="retry.example.com"), {}),
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "probe-retry",
            "tag": "proberetry",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": False,
        },
    )

    refresh = subs.refresh_subscription(
        str(ui_state_dir),
        "probe-retry",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=False,
    )

    node = refresh["last_nodes"][0]

    class _FakeProc:
        def poll(self):
            return None

    popen_calls = {"count": 0}
    wait_calls = {"count": 0}

    def _counting_popen(*args, **kwargs):
        popen_calls["count"] += 1
        return _FakeProc()

    def _fake_wait_for_local_ports(_ports, _proc, _timeout):
        wait_calls["count"] += 1
        return wait_calls["count"] >= 2

    monkeypatch.setattr(subs, "_find_xray_binary", lambda: "/opt/sbin/xray")
    monkeypatch.setattr(subs, "_wait_for_local_ports", _fake_wait_for_local_ports)
    monkeypatch.setattr(subs, "_terminate_process", lambda _proc, timeout_s=1.5: ("", "bind failed"))
    monkeypatch.setattr(subs, "_probe_url_for_subscription", lambda _dir: "https://probe.example.com/generate_204")
    monkeypatch.setattr(subs.subprocess, "Popen", _counting_popen)
    monkeypatch.setattr(subs, "_probe_via_local_proxy", lambda _port, _probe_url, timeout_value: (321, ""))

    result = subs.probe_subscription_nodes_latency(
        str(ui_state_dir),
        "probe-retry",
        [node["key"]],
        xray_configs_dir=str(xray_dir),
        timeout_s=8,
    )

    assert result["ok"] is True
    assert result["ok_count"] == 1
    assert result["failed_count"] == 0
    assert popen_calls["count"] >= 2
    assert wait_calls["count"] >= 2
