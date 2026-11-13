from pathlib import Path

from tests.support.node_js import NODE_MODULE_COMMAND
from tests.support.panel_render import ROOT
import subprocess


def test_mihomo_entry_is_light_and_rejects_unknown_parts():
    entry = ROOT / 'xkeen-ui/static/js/pages/mihomo.module.entry.js'
    assert entry.is_file(), 'Mihomo needs its own light module entry'
    result = subprocess.run(
        [*NODE_MODULE_COMMAND, '-e', f"""
          import assert from 'node:assert/strict';
          const entry = await import({entry.as_uri()!r});
          assert.deepEqual(Object.keys(entry.MIHOMO_MODULE_PARTS),
            ['bundle', 'import', 'proxy_tools', 'hwid_sub', 'clash', 'generator']);
          await assert.rejects(entry.load('missing'), /unknown part/);
          await assert.rejects(entry.load('constructor'), /unknown part/);
          assert.equal(typeof entry.activate, 'function');
        """], cwd=ROOT, capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr


def test_core_consumers_load_mihomo_through_bridge():
    pages = ROOT / 'xkeen-ui/static/js/pages'
    lazy = (pages / 'panel.lazy_bindings.runtime.js').read_text(encoding='utf-8')
    for part in ('import', 'proxy_tools', 'hwid_sub', 'clash'):
        assert f"loadModulePart('engine.mihomo', '{part}')" in lazy
    assert "import('../features/mihomo" not in lazy
    screen = (pages / 'top_level_mihomo_generator_screen.js').read_text(encoding='utf-8')
    assert "loadModulePart('engine.mihomo', 'generator')" in screen
    standalone = (pages / 'mihomo_generator.entry.js').read_text(encoding='utf-8')
    assert 'mihomo_generator.screen.bootstrap.js' not in standalone


def test_generator_shell_stays_in_core_without_expanding_public_contract():
    pages = ROOT / 'xkeen-ui/static/js/pages'
    shell = pages / 'mihomo_generator.shell.shared.js'
    assert shell.is_file()
    private = (pages / 'mihomo_generator.screen.bootstrap.js').read_text(encoding='utf-8')
    assert 'shell.shared.js' not in private
    assert 'editor.shared.js' not in private
    assert 'standalone_lazy.js' not in private
    for consumer in ('mihomo_generator.entry.js', 'top_level_mihomo_generator_screen.js'):
        assert 'mihomo_generator.shell.shared.js' in (pages / consumer).read_text(encoding='utf-8')


def test_mihomo_styles_are_owned_by_module_and_shared_log_primitives_stay_core():
    static = ROOT / 'xkeen-ui/static'
    css_path = static / 'mihomo.module.css'
    assert css_path.is_file(), 'Mihomo-specific styles need an independent resource'
    css = css_path.read_text(encoding='utf-8')
    shared = '\n'.join((static / name).read_text(encoding='utf-8') for name in ('styles.css', 'panel-operator.css'))
    for selector in ('#mihomo-validation-modal .modal-content', '.xk-mi-body', '#mihomo-clash-logs-list'):
        assert selector in css
        assert selector not in shared
    assert ':is(#view-xray-logs,#mihomo-clash-logs) .xk-xlog-chip' in shared
    entry = (static / 'js/pages/mihomo.module.entry.js').read_text(encoding='utf-8')
    assert 'new URL(' in entry and 'mihomo.module.css' in entry


def test_generator_initial_markup_loads_module_styles_before_first_paint():
    template = (ROOT / 'xkeen-ui/templates/mihomo_generator.html').read_text(encoding='utf-8')
    assert 'data-xk-module-css="engine.mihomo"' in template
    assert "filename='mihomo.module.css'" in template
    assert template.index("filename='mihomo.module.css'") < template.index('</head>')
