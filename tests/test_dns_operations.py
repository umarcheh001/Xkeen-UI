"""Итог операции защиты DNS переживает потерянный ответ.

Перезапуск ядра может оборвать соединение браузера посреди запроса: операция
доходит до конца, а ответ пропадает. Окно шлёт номер операции, маршрут
записывает ответ под ним, статус отдаёт последнюю запись.
"""

from __future__ import annotations

from pathlib import Path

from flask import Blueprint, Flask

from services import dns_operations
from services import dns_over_vless as vless
from services import mihomo_dns as mihomo

OP_ID = "a1b2c3d4e5f60718"


def test_operation_id_is_checked():
    assert dns_operations.normalize_id(OP_ID) == OP_ID
    assert dns_operations.normalize_id("short") == ""
    assert dns_operations.normalize_id("../../etc/passwd") == ""
    assert dns_operations.normalize_id(None) == ""
    assert dns_operations.normalize_id("x" * 65) == ""


def test_only_the_latest_answer_per_feature_is_kept(tmp_path: Path):
    state = str(tmp_path)
    dns_operations.record(state, "dns-over-vless", "first-operation", action="enable", status_code=200, body={"ok": True})
    dns_operations.record(state, "dns-over-vless", OP_ID, action="disable", status_code=409, body={"ok": False, "error": "нет"})
    dns_operations.record(state, "mihomo-dns", "other-operation", action="enable", status_code=200, body={"ok": True})

    entry = dns_operations.last(state, "dns-over-vless")
    assert entry["id"] == OP_ID
    assert entry["action"] == "disable"
    assert entry["status_code"] == 409
    assert entry["body"] == {"ok": False, "error": "нет"}
    assert dns_operations.last(state, "mihomo-dns")["id"] == "other-operation"


def test_a_request_without_an_id_leaves_nothing(tmp_path: Path):
    dns_operations.record(str(tmp_path), "dns-over-vless", "", action="enable", status_code=200, body={})
    assert dns_operations.last(str(tmp_path), "dns-over-vless") is None
    assert not (tmp_path / dns_operations.FILENAME).exists()


def _vless_app(tmp_path: Path, monkeypatch, fake_apply):
    from routes.routing import dns_over_vless as routes

    state = tmp_path / "state"
    state.mkdir()
    monkeypatch.setattr(routes, "apply_action", fake_apply)
    monkeypatch.setattr(routes, "get_status", lambda **_kwargs: {"ok": True, "enabled": True})
    monkeypatch.setattr(routes, "conflicting_protection", lambda **_kwargs: "")
    app = Flask(__name__)
    bp = Blueprint("dns_test", __name__)
    routes.register_dns_over_vless_routes(
        bp,
        xray_configs_dir=str(tmp_path),
        routing_file=str(tmp_path / "05_routing.json"),
        ui_state_dir=str(state),
        restart_xkeen=lambda **_kwargs: True,
    )
    app.register_blueprint(bp)
    return app.test_client()


def test_vless_status_returns_the_answer_the_request_lost(tmp_path: Path, monkeypatch):
    client = _vless_app(
        tmp_path, monkeypatch, lambda action, **_kwargs: {"ok": True, "action": action, "enabled": True}
    )

    sent = client.post("/api/routing/dns-over-vless", json={"action": "enable", "operation_id": OP_ID})
    status = client.get("/api/routing/dns-over-vless").get_json()

    assert sent.status_code == 200
    assert status["last_operation"]["id"] == OP_ID
    assert status["last_operation"]["status_code"] == 200
    assert status["last_operation"]["body"] == sent.get_json()


def test_vless_refusal_is_recorded_with_its_rollback(tmp_path: Path, monkeypatch):
    def refuse(action, **_kwargs):
        error = vless.DnsOverVlessError("Xray не запустился.", code="restart_failed")
        error.rollback = {"restored": True, "active_core": "xray"}
        raise error

    client = _vless_app(tmp_path, monkeypatch, refuse)
    sent = client.post("/api/routing/dns-over-vless", json={"action": "enable", "operation_id": OP_ID})
    entry = client.get("/api/routing/dns-over-vless").get_json()["last_operation"]

    assert sent.status_code == 409
    assert entry["status_code"] == 409
    assert entry["body"]["code"] == "restart_failed"
    assert entry["body"]["rolled_back"] is True


def test_vless_failed_status_still_carries_the_answer(tmp_path: Path, monkeypatch):
    from routes.routing import dns_over_vless as routes

    client = _vless_app(tmp_path, monkeypatch, lambda action, **_kwargs: {"ok": True})
    client.post("/api/routing/dns-over-vless", json={"action": "disable", "operation_id": OP_ID})

    def broken(**_kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(routes, "get_status", broken)
    response = client.get("/api/routing/dns-over-vless")

    assert response.status_code == 500
    assert response.get_json()["last_operation"]["id"] == OP_ID


def _mihomo_app(tmp_path: Path, monkeypatch, fake_apply):
    import routes.mihomo as mihomo_routes
    from routes.mihomo import create_mihomo_blueprint

    state = tmp_path / "state"
    state.mkdir()
    config = tmp_path / "config.yaml"
    config.write_text("mixed-port: 7890\n", encoding="utf-8")
    monkeypatch.setattr(mihomo_routes, "apply_mihomo_dns_action", fake_apply)
    monkeypatch.setattr(mihomo_routes, "get_mihomo_dns_status", lambda **_kwargs: {"ok": True, "enabled": False})
    monkeypatch.setattr(mihomo_routes, "_dns_conflicting_protection", lambda **_kwargs: "")
    app = Flask("mihomo-dns-ops")
    app.register_blueprint(create_mihomo_blueprint(
        MIHOMO_CONFIG_FILE=str(config),
        MIHOMO_TEMPLATES_DIR=str(tmp_path / "templates"),
        MIHOMO_DEFAULT_TEMPLATE=str(tmp_path / "templates" / "default.yaml"),
        restart_xkeen=lambda **_kwargs: True,
        ui_state_dir=str(state),
    ))
    return app.test_client()


def test_mihomo_status_returns_the_answer_the_request_lost(tmp_path: Path, monkeypatch):
    client = _mihomo_app(
        tmp_path, monkeypatch, lambda action, **_kwargs: {"ok": True, "enabled": True, "probe": {"ok": True}}
    )

    sent = client.post("/api/mihomo/dns", json={"confirmed": True, "action": "enable", "operation_id": OP_ID})
    entry = client.get("/api/mihomo/dns").get_json()["last_operation"]

    assert sent.status_code == 200
    assert entry["id"] == OP_ID
    assert entry["action"] == "enable"
    assert entry["body"] == sent.get_json()


def test_mihomo_refusal_is_recorded(tmp_path: Path, monkeypatch):
    def refuse(action, **_kwargs):
        raise mihomo.MihomoDnsError("Mihomo не запустился.", code="restart_failed", rolled_back=True)

    client = _mihomo_app(tmp_path, monkeypatch, refuse)
    client.post("/api/mihomo/dns", json={"confirmed": True, "action": "disable", "operation_id": OP_ID})
    entry = client.get("/api/mihomo/dns").get_json()["last_operation"]

    assert entry["status_code"] == 409
    assert entry["body"]["error"] == "Mihomo не запустился."
    assert entry["body"]["rolled_back"] is True


def test_both_windows_send_an_operation_id_and_recover_from_status():
    root = Path(__file__).resolve().parents[1] / "xkeen-ui" / "static" / "js" / "features"
    helper = (root / "dns_operation_recovery.js").read_text(encoding="utf-8")
    for script in (root / "mihomo_dns.js", root / "routing_cards" / "rules" / "dns_over_vless.js"):
        text = script.read_text(encoding="utf-8")
        assert "dns_operation_recovery.js" in text
        assert "payload.operation_id = newDnsOperationId()" in text
        assert "awaitDnsOperation(" in text
    assert "last_operation" in helper
