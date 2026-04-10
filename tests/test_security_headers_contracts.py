from pathlib import Path


def test_app_factory_applies_global_security_headers_after_cache_policy():
    app_factory = Path("xkeen-ui/app_factory.py").read_text(encoding="utf-8")

    assert "from routes.ui_assets import (" in app_factory
    assert "apply_response_cache_policy," in app_factory
    assert "apply_response_security_headers," in app_factory
    assert "response = apply_response_cache_policy(response)" in app_factory
    assert "return apply_response_security_headers(response)" in app_factory


def test_ui_assets_exposes_conservative_baseline_security_headers():
    text = Path("xkeen-ui/routes/ui_assets.py").read_text(encoding="utf-8")

    assert '_BASELINE_SECURITY_HEADERS = {' in text
    assert '"X-Frame-Options": "DENY"' in text
    assert '"Referrer-Policy": "no-referrer"' in text
    assert '"Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()"' in text
    assert '"X-Content-Type-Options": "nosniff"' in text
    assert 'def apply_response_security_headers(resp: Response) -> Response:' in text
    assert 'resp.headers.setdefault(key, value)' in text
