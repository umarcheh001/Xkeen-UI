from pathlib import Path

from flask import Flask, Response

from routes.ui_assets import apply_response_security_headers


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


def test_routing_comments_help_static_page_allows_same_origin_framing():
    app = Flask(__name__)

    with app.test_request_context("/static/routing-comments-help.html?v=20260415b"):
        resp = apply_response_security_headers(Response(""))

    assert resp.headers["X-Frame-Options"] == "SAMEORIGIN"


def test_regular_static_assets_keep_deny_framing_baseline():
    app = Flask(__name__)

    with app.test_request_context("/static/js/features/routing.js"):
        resp = apply_response_security_headers(Response(""))

    assert resp.headers["X-Frame-Options"] == "DENY"


def test_routing_comments_help_modal_uses_inline_shadow_dom_loader():
    text = Path("xkeen-ui/static/js/features/routing.js").read_text(encoding="utf-8")

    assert "const HELP_PATH = '/static/routing-comments-help.html';" in text
    assert "const HELP_URL = HELP_PATH + '?v=20260415b';" in text
    assert "function showHelpFallback()" in text
    assert "function renderRoutingHelpInline(htmlText)" in text
    assert "function highlightRoutingHelpCodeBlocks(root)" in text
    assert "fetch(HELP_URL, { cache: 'no-store', credentials: 'same-origin' })" in text
    assert "helpHost.style.cssText = 'width:100%;height:100%;min-height:0;flex:1 1 auto;overflow:auto;" in text
    assert "overscroll-behavior:contain" in text
    assert "attachShadow({ mode: 'open' })" in text
    assert "new DOMParser()" in text
    assert "05_routing" in text
    assert "document.createElement('iframe')" not in text
