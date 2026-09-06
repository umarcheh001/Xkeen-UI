"""Точечное применение выбора устройств через API, без передёргивания защиты."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict

import pytest
from flask import Blueprint, Flask

from routes.routing.dns_over_vless import register_dns_over_vless_routes
from services import dns_over_vless as dns


def _client(tmp_path: Path, macs: list[str], **extra: Any):
    state_dir = tmp_path / "state"
    state_dir.mkdir(exist_ok=True)
    (state_dir / "dns_over_vless.json").write_text(
        json.dumps({"enabled": True, "capture_clients": True, "capture_macs": macs, **extra}, ensure_ascii=False),
        encoding="utf-8",
    )
    app = Flask(__name__)
    app.config["TESTING"] = True
    bp = Blueprint("routing_test", __name__)
    register_dns_over_vless_routes(
        bp,
        xray_configs_dir=str(tmp_path / "configs"),
        routing_file=str(tmp_path / "05_routing.json"),
        ui_state_dir=str(state_dir),
        restart_xkeen=lambda **_kw: True,
    )
    app.register_blueprint(bp)
    return app.test_client(), state_dir


def test_the_choice_is_applied_without_restarting_the_protection(tmp_path: Path, monkeypatch):
    client, state_dir = _client(tmp_path, ["10:f6:0a:a5:e7:9a"])
    asked: list[list[str]] = []
    monkeypatch.setattr(
        dns.dns_client_capture, "ensure", lambda macs: asked.append(list(macs)) or {"ok": True, "changed": True}
    )
    # Включение защиты -- дорогая операция с перезапуском ядра; выбор
    # устройств её задевать не должен, иначе имена уходят провайдеру.
    def refuse(*_a: Any, **_kw: Any) -> Dict[str, Any]:
        raise AssertionError("apply_action не должен вызываться для выбора устройств")

    monkeypatch.setattr("routes.routing.dns_over_vless.apply_action", refuse)

    response = client.post(
        "/api/routing/dns-over-vless",
        json={
            "action": "capture",
            "capture_clients": True,
            "capture_macs": ["10:f6:0a:a5:e7:9a", "3c:38:24:5f:86:c4"],
        },
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    assert payload["added"] == ["3c:38:24:5f:86:c4"]
    assert asked == [["10:f6:0a:a5:e7:9a", "3c:38:24:5f:86:c4"]]
    saved = json.loads((state_dir / "dns_over_vless.json").read_text(encoding="utf-8"))
    assert saved["capture_macs"] == ["10:f6:0a:a5:e7:9a", "3c:38:24:5f:86:c4"]


def test_a_refused_firewall_answers_with_an_error_and_keeps_the_choice(tmp_path: Path, monkeypatch):
    client, state_dir = _client(tmp_path, ["10:f6:0a:a5:e7:9a"])

    def refuse(macs):
        raise dns.dns_client_capture.CaptureError("iptables не отвечает")

    monkeypatch.setattr(dns.dns_client_capture, "ensure", refuse)

    response = client.post(
        "/api/routing/dns-over-vless",
        json={"action": "capture", "capture_clients": True, "capture_macs": ["3c:38:24:5f:86:c4"]},
    )

    assert response.status_code == 409
    payload = response.get_json()
    assert payload["ok"] is False
    assert payload["code"] == "capture_failed"
    saved = json.loads((state_dir / "dns_over_vless.json").read_text(encoding="utf-8"))
    assert saved["capture_macs"] == ["10:f6:0a:a5:e7:9a"]
