from __future__ import annotations

from pathlib import Path


def test_tooltips_do_not_convert_form_field_aria_labels_into_portal_tooltips():
    text = Path('xkeen-ui/static/js/ui/tooltips_auto.js').read_text(encoding='utf-8')

    assert "hostTag === 'INPUT' || hostTag === 'TEXTAREA' || hostTag === 'SELECT'" in text
    assert ".xterm, .xterm-helpers, .xterm-helper-textarea" in text


def test_lite_terminal_skips_xterm_boot_and_keeps_pre_output_visible():
    text = Path('xkeen-ui/static/js/terminal/modules/terminal_controller.js').read_text(encoding='utf-8')

    assert "reason: 'lite-mode'" in text
    assert 'showLiteOutput(c, true)' in text
    assert "xterm-helper-textarea" in text


def test_lite_terminal_output_controller_appends_to_pre_instead_of_hidden_xterm():
    text = Path('xkeen-ui/static/js/terminal/core/output_controller.js').read_text(encoding='utf-8')

    assert 'function appendToPre(ctx, text)' in text
    assert "if (mode === 'pty' && term)" in text
    assert 'appendToPre(ctx, out)' in text
