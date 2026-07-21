from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TERMINAL_HTML = (
    ROOT
    / "android-companion"
    / "app"
    / "src"
    / "main"
    / "assets"
    / "terminal"
    / "terminal.html"
)
TERMINAL_XTERM = TERMINAL_HTML.with_name("xterm.js")


def _terminal_asset() -> str:
    return TERMINAL_HTML.read_text(encoding="utf-8")


def test_terminal_surface_is_anchored_to_the_webview_viewport():
    html = _terminal_asset()

    assert "position: fixed; inset: 5px 3px 3px 5px;" in html
    assert "width: auto; height: auto; min-width: 40px; min-height: 40px;" in html
    assert "width: 100%; height: 100%; min-height: 0;" in html
    assert "min-height: 100vh" not in html
    assert "terminalHost.style.position = 'fixed';" in html
    assert "terminalHost.style.position = 'absolute';" not in html
    assert "html, body, #terminal" not in html


def test_terminal_surface_recovers_from_zero_height_without_waiting_forever():
    html = _terminal_asset()

    assert "function recoverHostGeometry()" in html
    assert "!hostHasSize() && !recoverHostGeometry()" in html
    assert "Date.now() - surfaceWaitStartedAt >= 4000" in html
    assert "Не удалось подготовить область терминала" in html


def test_terminal_connection_failure_releases_the_reconnect_guard():
    html = _terminal_asset()

    assert "connectionRequestFailed: message =>" in html
    assert "reconnectRequested = false;" in html


def test_terminal_uses_readable_stable_mobile_typography():
    html = _terminal_asset()

    assert "const TERMINAL_FONT_SIZE = 14;" in html
    assert "const TERMINAL_LINE_HEIGHT = 1.18;" in html
    assert 'fontFamily: "monospace",' in html
    assert "fontSize: TERMINAL_FONT_SIZE," in html
    assert "lineHeight: TERMINAL_LINE_HEIGHT," in html
    assert "-webkit-text-size-adjust: none;" in html
    assert "text-size-adjust: none;" in html
    assert "font-size: 16px !important;" in html
    assert "min-width: 1px !important; min-height: 1px !important;" in html
    assert "z-index: 0 !important; opacity: 0.01 !important;" in html
    assert "position: fixed !important;" not in html
    assert "left: 50% !important;" not in html
    assert "\n      width: 1px !important;" not in html
    assert "terminal.options.fontSize" not in html
    assert "terminal.options.lineHeight" not in html


def test_terminal_debounces_and_deduplicates_pty_resize() -> None:
    html = _terminal_asset()

    assert "const RESIZE_SETTLE_DELAY_MS = 96;" in html
    assert "function proposedDimensions()" in html
    assert "fitAddon.proposeDimensions();" in html
    assert "function scheduleSurfaceFit(" in html
    assert "else scheduleSurfaceFit(true, RESIZE_SETTLE_DELAY_MS);" in html
    assert "try { fitAddon.fit(); }" in html
    assert "activeBuffer.baseY - activeBuffer.viewportY" in html
    assert "terminal.buffer.active.baseY - distanceFromBottom" in html
    assert "terminal.scrollToBottom();" in html
    assert "function refreshVisibleRows()" in html
    assert "requestAnimationFrame(refreshVisibleRows);" in html
    assert "size.cols === lastPublishedColumns" in html
    assert html.count("type: 'resize'") == 1
    assert "terminal.onResize" not in html
    assert "pendingResizeFocus" not in html
    assert html.count("terminal.refresh(") == 1


def test_terminal_supports_native_vertical_touch_scrolling() -> None:
    html = _terminal_asset()

    assert "touch-action: pan-y;" in html
    assert "-webkit-overflow-scrolling: touch;" in html
    assert "addEventListener('touchstart'" not in html
    assert "addEventListener('touchmove'" not in html
    assert "addEventListener('touchend'" not in html
    assert "event.preventDefault();" not in html
    assert "event.stopPropagation();" not in html
    assert "terminal.scrollLines(lines);" not in html


def test_terminal_configures_android_ime_without_autocorrecting_commands() -> None:
    html = _terminal_asset()

    assert "function configureInputMethod()" in html
    assert "textarea.setAttribute('autocapitalize', 'none');" in html
    assert "textarea.setAttribute('autocomplete', 'off');" in html
    assert "textarea.setAttribute('autocorrect', 'off');" in html
    assert "textarea.setAttribute('spellcheck', 'false');" in html
    assert "Promise.resolve(document.fonts ? document.fonts.ready : undefined)" in html


def test_bundled_xterm_contains_android_ime_composition_fix() -> None:
    xterm = TERMINAL_XTERM.read_text(encoding="utf-8")

    old_fragment = "substring(e.start,e.end):this._textarea.value.substring(e.start)"
    fixed_fragment = (
        "substring(e.start,this._compositionPosition.start):"
        "this._textarea.value.substring(e.start)"
    )
    assert old_fragment not in xterm
    assert fixed_fragment in xterm
