from __future__ import annotations

from pathlib import Path

from flask import Flask

from routes import service


def _app(monkeypatch, *, status, release=None, calls=None):
    events = calls if calls is not None else []

    def stop(action, *, prefer_init):
        events.append(("control", action, prefer_init))
        return True

    monkeypatch.setattr(service, "control_xkeen_action", stop)
    app = Flask("service-dns-stop")
    app.register_blueprint(
        service.create_service_blueprint(
            restart_xkeen=lambda **_kwargs: True,
            append_restart_log=lambda *_args, **_kwargs: None,
            XRAY_ERROR_LOG="/tmp/xray-error.log",
            dns_stop_status=lambda: dict(status),
            dns_stop_release=release,
        )
    )
    return app


def test_stop_check_reports_active_dns_protection(monkeypatch):
    protection = {"active": True, "owner": "mihomo-dns", "label": "защита DNS Mihomo"}
    app = _app(monkeypatch, status=protection)

    response = app.test_client().get("/api/xkeen/stop-check")

    assert response.status_code == 200
    assert response.get_json()["dns_protection"] == protection


def test_stop_is_blocked_while_dns_protection_is_active(monkeypatch):
    calls = []
    app = _app(
        monkeypatch,
        status={"active": True, "owner": "mihomo-dns", "label": "защита DNS Mihomo"},
        calls=calls,
    )

    response = app.test_client().post("/api/xkeen/stop")

    assert response.status_code == 409
    assert response.get_json()["code"] == "dns_protection_active"
    assert calls == []


def test_confirmed_stop_releases_dns_before_stopping(monkeypatch):
    calls = []

    def release(owner):
        calls.append(("release", owner))
        return {"released": True, "owner": owner}

    app = _app(
        monkeypatch,
        status={"active": True, "owner": "dns-over-vless", "label": "DNS-over-VLESS (Xray)"},
        release=release,
        calls=calls,
    )

    response = app.test_client().post("/api/xkeen/stop", json={"release_dns": True})

    assert response.status_code == 200
    assert response.get_json()["dns_released"] is True
    assert calls == [
        ("release", "dns-over-vless"),
        ("control", "stop", True),
    ]


def test_stop_does_not_run_when_dns_release_fails(monkeypatch):
    calls = []

    def release(_owner):
        raise RuntimeError("release failed")

    app = _app(
        monkeypatch,
        status={"active": True, "owner": "mihomo-dns", "label": "защита DNS Mihomo"},
        release=release,
        calls=calls,
    )

    response = app.test_client().post("/api/xkeen/stop", json={"release_dns": True})

    assert response.status_code == 409
    assert response.get_json()["code"] == "dns_stop_release_failed"
    assert calls == []


def test_service_stop_frontend_uses_dns_preflight_and_confirmation():
    script = Path("xkeen-ui/static/js/features/service_status.js").read_text(encoding="utf-8")

    assert "'/api/xkeen/stop-check'" in script
    assert "Вернуть DNS Keenetic и остановить?" in script
    assert "{ release_dns: true }" in script
    assert "void requestSafeStop();" in script
