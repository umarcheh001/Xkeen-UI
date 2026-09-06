from __future__ import annotations

from pathlib import Path


def test_tooltips_do_not_convert_form_field_aria_labels_into_portal_tooltips():
    text = Path('xkeen-ui/static/js/ui/tooltips_auto.js').read_text(encoding='utf-8')

    assert "hostTag === 'INPUT' || hostTag === 'TEXTAREA' || hostTag === 'SELECT'" in text
    assert ".xterm, .xterm-helpers, .xterm-helper-textarea" in text
    assert 'function ensurePortalRefs() {' in text
    assert "document.documentElement.contains(portal)" in text
    assert 'if (!ensurePortalRefs()) return;' in text


def test_portal_tooltips_require_pointer_hover_instead_of_keyboard_focus():
    text = Path('xkeen-ui/static/js/ui/tooltips_auto.js').read_text(encoding='utf-8')
    styles = Path('xkeen-ui/static/styles.css').read_text(encoding='utf-8')

    assert "'pointermove'" in text
    assert "e.pointerType !== 'mouse'" in text
    assert "'focusin'" not in text
    assert 'button[data-tooltip]:focus-visible::after' not in styles
    assert '[data-tooltip]:not(button):not(input):not(textarea):not(select):focus-visible::after' not in styles


def test_lite_terminal_skips_xterm_boot_and_keeps_pre_output_visible():
    text = Path('xkeen-ui/static/js/terminal/modules/terminal_controller.js').read_text(encoding='utf-8')

    assert "reason: 'lite-mode'" in text
    assert 'showLiteOutput(c, true)' in text
    assert "xterm-helper-textarea" in text


def test_lite_terminal_output_controller_appends_to_pre_instead_of_hidden_xterm():
    text = Path('xkeen-ui/static/js/terminal/core/output_controller.js').read_text(encoding='utf-8')

    assert 'function appendToPre(ctx, text)' in text
    assert 'function resolveOutputTarget(ctx, source, term)' in text
    assert "if (source === 'lite') return 'pre';" in text
    assert "if (source === 'pty' && term) return 'term';" in text
    assert "if (source === 'pty') return 'none';" in text
    assert "const target = resolveOutputTarget(ctx, source, term);" in text
    assert "if (target === 'term')" in text
    assert "else if (target === 'pre')" in text
    assert 'appendToPre(ctx, out)' in text


def test_lite_runner_never_writes_output_into_a_hidden_xterm():
    text = Path('xkeen-ui/static/js/terminal/lite_runner.js').read_text(encoding='utf-8')

    assert 'function xtermHostIsVisible() {' in text
    assert "const host = byId('terminal-xterm');" in text
    assert "host.classList.contains('hidden')" in text
    assert "host.style.display === 'none'" in text
    assert 'if (!xtermHostIsVisible()) return false;' in text


def test_lite_pre_output_keeps_echo_exit_code_and_never_overwrites_command_output():
    text = Path('xkeen-ui/static/js/terminal/lite_runner.js').read_text(encoding='utf-8')

    assert 'function appendPre(outputEl, text) {' in text
    assert r"appendPre(outputEl, '$ ' + cmdText + '\n');" in text
    assert r"appendPre(outputEl, '\n[exit_code=' + exitCode + ']\n');" in text
    assert r"appendPre(outputEl, '\n[Ошибка] ' + msg + '\n');" in text
    # Errors are appended, not assigned over the output collected so far.
    assert "outputEl.textContent = 'Ошибка: ' + msg;" not in text


def test_lite_runner_treats_non_zero_exit_code_as_a_finished_job():
    text = Path('xkeen-ui/static/js/terminal/lite_runner.js').read_text(encoding='utf-8')

    assert 'const finishedWithExitCode = !!(data' in text
    assert "&& data.status === 'finished'" in text
    assert "&& typeof data.exit_code === 'number');" in text
    assert 'if (!finishedWithExitCode && (!res.ok || !data || !data.ok)) {' in text


def test_lite_runner_does_not_reprint_streamed_output_as_final_payload():
    text = Path('xkeen-ui/static/js/terminal/lite_runner.js').read_text(encoding='utf-8')

    assert 'let streamedAny = false;' in text
    assert 'streamedAny = true;' in text
    assert 'if (text && !streamedAny) onChunk(text);' in text
