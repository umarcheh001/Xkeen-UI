from __future__ import annotations

from pathlib import Path

import pytest
from flask import Flask

from routes import xray_configs
from services.xray_inbounds import (
    MIXED_INBOUNDS,
    PortConflictError,
    merge_inbounds_preset,
)


def _transparent(tag: str, port: int | str, network: str, *, listen: str | None = None) -> dict:
    inbound = {
        "tag": tag,
        "port": port,
        "protocol": "dokodemo-door",
        "settings": {"network": network, "followRedirect": True},
    }
    if listen is not None:
        inbound["listen"] = listen
    return inbound


def test_user_tcp_udp_pair_can_share_a_numeric_port():
    current = {
        "inbounds": [
            _transparent("force-proxy-redirect", 1181, "tcp"),
            _transparent("force-proxy-tproxy", 1181, "udp"),
        ]
    }

    result = merge_inbounds_preset(current, MIXED_INBOUNDS, preserve_extras=True)

    tags = {item["tag"] for item in result["inbounds"]}
    assert {"force-proxy-redirect", "force-proxy-tproxy"} <= tags


def test_same_port_and_overlapping_networks_raise_structured_conflict():
    current = {
        "inbounds": [
            _transparent("force-proxy-a", "1181,1191", "tcp,udp"),
            _transparent("force-proxy-b", "1191", "udp"),
        ]
    }

    with pytest.raises(PortConflictError) as raised:
        merge_inbounds_preset(current, MIXED_INBOUNDS, preserve_extras=True)

    exc = raised.value
    assert exc.port == 1191
    assert exc.overlap == {"udp"}
    assert exc.as_dict() == {
        "port": 1191,
        "first": {"tag": "force-proxy-a", "networks": ["tcp", "udp"]},
        "second": {"tag": "force-proxy-b", "networks": ["udp"]},
        "overlap": ["udp"],
    }


def test_distinct_explicit_bind_addresses_can_share_a_socket_port():
    current = {
        "inbounds": [
            _transparent("lan-a", 1181, "tcp", listen="192.0.2.10"),
            _transparent("lan-b", 1181, "tcp", listen="192.0.2.11"),
        ]
    }

    result = merge_inbounds_preset(current, MIXED_INBOUNDS, preserve_extras=True)
    assert len(result["inbounds"]) == 4


def test_inbounds_endpoint_returns_conflict_details(monkeypatch, tmp_path: Path):
    current = {
        "inbounds": [
            _transparent("force-proxy-a", 1191, "tcp"),
            _transparent("force-proxy-b", 1191, "tcp,udp"),
        ]
    }
    app = Flask("xray-inbounds-port-conflict")
    app.register_blueprint(
        xray_configs.create_xray_configs_blueprint(
            restart_xkeen=lambda **_kwargs: True,
            load_json=lambda _path, default=None: current,
            save_json=lambda _path, _data: None,
            strip_json_comments_text=lambda text: text,
            snapshot_xray_config_before_overwrite=lambda _path: None,
        )
    )
    monkeypatch.setattr(
        xray_configs,
        "resolve_xray_fragment_file",
        lambda *_args, **_kwargs: str(tmp_path / "03_inbounds.json"),
    )

    response = app.test_client().post(
        "/api/inbounds",
        json={"mode": "mixed", "restart": False, "preserve_extras": True},
    )

    assert response.status_code == 400
    payload = response.get_json()
    assert payload["code"] == "port_conflict"
    assert "1191/TCP" in payload["error"]
    assert payload["conflict"]["port"] == 1191
    assert payload["conflict"]["overlap"] == ["tcp"]
    assert payload["conflict"]["first"]["tag"] == "force-proxy-a"
    assert payload["conflict"]["second"]["tag"] == "force-proxy-b"

