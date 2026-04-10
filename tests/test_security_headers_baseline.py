from __future__ import annotations


def _assert_baseline_headers(resp) -> None:
    assert resp.headers["X-Frame-Options"] == "DENY"
    assert resp.headers["Referrer-Policy"] == "no-referrer"
    assert resp.headers["Permissions-Policy"] == "camera=(), geolocation=(), microphone=(), payment=(), usb=()"
    assert resp.headers["X-Content-Type-Options"] == "nosniff"


def test_app_wide_security_headers_apply_to_api_responses(app_client):
    resp = app_client.get("/api/auth/status")

    assert resp.status_code == 200
    _assert_baseline_headers(resp)


def test_app_wide_security_headers_apply_to_html_redirects(app_client):
    resp = app_client.get("/login")

    assert resp.status_code in {200, 302}
    _assert_baseline_headers(resp)


def test_app_wide_security_headers_apply_to_static_assets(app_client):
    resp = app_client.get("/static/js/features/mihomo_panel.js")

    assert resp.status_code == 200
    _assert_baseline_headers(resp)
