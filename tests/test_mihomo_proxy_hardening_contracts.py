from pathlib import Path


def test_mihomo_proxy_prefers_direct_origin_and_gates_proxy_fallback():
    text = Path('xkeen-ui/routes/mihomo.py').read_text(encoding='utf-8')

    assert '_MIHOMO_UI_ALLOWED_PORTS_ENV = "XKEEN_MIHOMO_UI_ALLOWED_PORTS"' in text
    assert '_MIHOMO_UI_PUBLIC_SCHEME_ENV = "XKEEN_MIHOMO_UI_PUBLIC_SCHEME"' in text
    assert '_MIHOMO_UI_ALLOW_PROXY_FALLBACK_ENV = "XKEEN_MIHOMO_UI_ALLOW_PROXY_FALLBACK"' in text
    assert 'def _build_mihomo_ui_direct_base(port: int) -> str | None:' in text
    assert 'if not _mihomo_ui_bind_host_is_loopback(bind_host):' in text
    assert 'resp = redirect(direct_url, code=302)' in text
    assert 'if not _mihomo_ui_proxy_fallback_enabled():' in text
    assert 'Same-origin proxy для loopback-only Mihomo UI отключён по умолчанию.' in text


def test_mihomo_proxy_filters_sensitive_request_and_response_headers():
    text = Path('xkeen-ui/routes/mihomo.py').read_text(encoding='utf-8')

    assert "_MIHOMO_UI_SENSITIVE_REQUEST_HEADERS = {" in text
    assert "'cookie'" in text
    assert "'authorization'" in text
    assert "'x-csrf-token'" in text
    assert "if kl in _MIHOMO_UI_SENSITIVE_REQUEST_HEADERS:" in text
    assert "_MIHOMO_UI_BLOCKED_RESPONSE_HEADERS = {" in text
    assert "'set-cookie'" in text
    assert "if kl in _MIHOMO_UI_BLOCKED_RESPONSE_HEADERS:" in text
    assert "r.headers.setdefault('Referrer-Policy', 'no-referrer')" in text
    assert "r.headers.setdefault('X-Content-Type-Options', 'nosniff')" in text
    assert "frame-ancestors 'none'; base-uri 'none'; form-action 'self'" in text


def test_mihomo_panel_opens_proxy_entry_without_referer_leak():
    text = Path('xkeen-ui/static/js/features/mihomo_panel.js').read_text(encoding='utf-8')

    assert "window.open(url, '_blank', 'noopener,noreferrer');" in text
