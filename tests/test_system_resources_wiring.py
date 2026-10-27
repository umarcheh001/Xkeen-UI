"""The history thread is started by the production entry, never by building the app."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_run_server_starts_the_history_for_the_active_module_only():
    text = (ROOT / "xkeen-ui" / "run_server.py").read_text(encoding="utf-8")
    main = text[text.index('if __name__ == "__main__":'):]
    assert "start_resource_history_if_active()" in main
    helper = text[text.index("def start_resource_history_if_active"):text.index('if __name__ == "__main__":')]
    assert '"tool.advanced-diagnostics" not in _ACTIVE_MODULES' in helper
    assert "start_collector(ui_state_dir=UI_STATE_DIR)" in helper
    assert "install_terminate_save()" in helper


def test_building_the_app_does_not_start_the_collector():
    text = (ROOT / "xkeen-ui" / "routes" / "__init__.py").read_text(encoding="utf-8")
    assert "start_collector" not in text and "PYTEST_CURRENT_TEST" not in text


def test_init_script_gives_the_panel_a_few_seconds_before_kill_nine():
    text = (ROOT / "xkeen-ui" / "scripts" / "panel_init.sh").read_text(encoding="utf-8")
    start = text.index("stop_service() {")
    body = text[start : text.index("status_service() {", start)]
    assert body.index('kill "$PID"') < body.index("STOP_WAIT") < body.index('kill -9 "$PID"')
    assert '[ "$STOP_WAIT" -lt 2 ]' in body
