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
