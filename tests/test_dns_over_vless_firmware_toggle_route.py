"""Решение о резолвере прошивки доезжает от окна до сервиса."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Dict

from flask import Blueprint, Flask

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "xkeen-ui"))

from routes.routing.dns_over_vless import register_dns_over_vless_routes  # noqa: E402


def _client(tmp_path: Path):
    state_dir = tmp_path / "state"
    state_dir.mkdir(exist_ok=True)
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
    return app.test_client()


def _capture(monkeypatch) -> Dict[str, Any]:
    seen: Dict[str, Any] = {}

    def fake_apply(action: str, **kwargs: Any) -> Dict[str, Any]:
        seen.update(kwargs)
        seen["action"] = action
        return {"ok": True}

    monkeypatch.setattr("routes.routing.dns_over_vless.apply_action", fake_apply)
    return seen


def test_the_refusal_reaches_the_service(tmp_path: Path, monkeypatch):
    """Снятая галочка — осознанный отказ, и он не должен потеряться в API."""
    client = _client(tmp_path)
    seen = _capture(monkeypatch)

    response = client.post(
        "/api/routing/dns-over-vless",
        json={"action": "enable", "target": "balancer_main", "use_firmware_resolver": False},
    )

    assert response.status_code == 200
    assert seen["use_firmware_resolver"] is False


def test_an_omitted_key_keeps_what_the_install_already_chose(tmp_path: Path, monkeypatch):
    """Ключа нет — решение принимает сервис, а не маршрут."""
    client = _client(tmp_path)
    seen = _capture(monkeypatch)

    response = client.post(
        "/api/routing/dns-over-vless",
        json={"action": "enable", "target": "balancer_main"},
    )

    assert response.status_code == 200
    assert seen["use_firmware_resolver"] is None
