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


def _terminal_asset() -> str:
    return TERMINAL_HTML.read_text(encoding="utf-8")


def test_terminal_surface_is_anchored_to_the_webview_viewport():
    html = _terminal_asset()

    assert "position: fixed; inset: 5px 3px 3px 5px;" in html
    assert "width: auto; height: auto; min-width: 40px; min-height: 40px;" in html
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
