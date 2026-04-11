from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_devtools_env_renders_error_rows_without_raw_html_injection():
    text = (ROOT / "xkeen-ui" / "static" / "js" / "features" / "devtools" / "env.js").read_text(encoding="utf-8")

    assert "function renderEnvTableMessage(message) {" in text
    assert "td.textContent = String(message || '');" in text
    assert "renderEnvTableMessage('Ошибка: ' + (e && e.message ? e.message : String(e)));" in text
    assert "tbody.innerHTML = '<tr><td colspan=\"4\">Ошибка: ' + (e && e.message ? e.message : String(e)) + '</td></tr>';" not in text


def test_terminal_ui_adapter_defaults_html_setter_to_text_content():
    text = (ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "core" / "ui.js").read_text(encoding="utf-8")

    assert "html: (el, v) => {" in text
    assert "try { el.textContent = String(v == null ? '' : v); } catch (e) {}" in text
    assert "trustedHtml: (el, v) => {" in text
    assert "try { el.innerHTML = String(v == null ? '' : v); } catch (e) {}" in text


def test_frontend_js_has_no_direct_innerhtml_exception_message_sinks():
    js_root = ROOT / "xkeen-ui" / "static" / "js"
    offenders: list[str] = []

    for path in js_root.rglob("*.js"):
        text = path.read_text(encoding="utf-8")
        if re.search(r"innerHTML\s*=.*e\.message", text) or re.search(r"innerHTML\s*=.*String\(e\)", text):
            offenders.append(str(path.relative_to(ROOT)))

    assert offenders == []
