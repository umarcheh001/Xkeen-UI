from pathlib import Path
import shutil
import re

import pytest

def test_terminal_debug_module_exists_and_exports_expected_helpers():
    path = Path('xkeen-ui/static/js/features/terminal_debug.js')
    text = path.read_text(encoding='utf-8')

    assert 'export function appendTerminalDebug' in text
    assert 'export function markTerminalDebugState' in text
    assert 'export function startTerminalDebugRun' in text
    assert 'export function finishTerminalDebugRun' in text


def test_update_notifier_postjson_sends_csrf_header():
    path = Path('xkeen-ui/static/js/features/update_notifier.js')
    text = path.read_text(encoding='utf-8')

    assert "meta[name=\"csrf-token\"]" in text
    assert "headers['X-CSRF-Token'] = csrf" in text


def test_codemirror6_source_bridge_is_opt_in_and_does_not_inject_importmap_dynamically():
    path = Path('xkeen-ui/static/js/pages/codemirror6.shared.js')
    text = path.read_text(encoding='utf-8')

    assert 'data-xkeen-cm6-importmap="1"' in text
    assert "document.createElement(\'script\')" not in text
    assert "script.type = 'importmap'" not in text
    assert "backend: 'cm6-unavailable'" in text
    assert "ensureSkippedRuntime('importmap-missing')" in text


def test_codemirror6_importmap_template_exists_and_maps_required_packages():
    path = Path('xkeen-ui/templates/_codemirror6_importmap.html')
    text = path.read_text(encoding='utf-8')

    assert 'type="importmap"' in text
    assert 'data-xkeen-cm6-importmap="1"' in text
    assert "vendor/npm/@codemirror/state/dist/index.js" in text
    assert "vendor/npm/@codemirror/view/dist/index.js" in text
    assert "vendor/npm/codemirror/dist/index.js" in text
    assert "vendor/npm/jsonc-parser/lib/esm/main.js" in text
    assert "vendor/npm/style-mod/src/style-mod.js" in text
    assert "vendor/npm/w3c-keyname/index.js" in text


def test_runtime_vendor_assets_exist_after_frontend_build():
    required = [
        Path('xkeen-ui/static/vendor/npm/@codemirror/state/dist/index.js'),
        Path('xkeen-ui/static/vendor/npm/@codemirror/view/dist/index.js'),
        Path('xkeen-ui/static/vendor/npm/codemirror/dist/index.js'),
        Path('xkeen-ui/static/vendor/npm/jsonc-parser/lib/esm/main.js'),
        Path('xkeen-ui/static/vendor/npm/style-mod/src/style-mod.js'),
        Path('xkeen-ui/static/vendor/npm/w3c-keyname/index.js'),
        Path('xkeen-ui/static/vendor/prettier/standalone.js'),
        Path('xkeen-ui/static/vendor/prettier/plugins/babel.js'),
        Path('xkeen-ui/static/vendor/prettier/plugins/estree.js'),
        Path('xkeen-ui/static/vendor/prettier/plugins/yaml.js'),
    ]

    if shutil.which('npm') is None and not any(path.exists() for path in required):
        pytest.skip('npm/vendor assets are not available in this environment')

    missing = [str(path) for path in required if not path.is_file()]
    assert not missing, f"frontend runtime vendor assets are missing after build:\n" + "\n".join(missing)


def test_runtime_vendor_esm_imports_are_browser_safe():
    vendor_root = Path('xkeen-ui/static/vendor/npm')
    pattern_specs = [
        re.compile(r"""\bfrom\s*["'](\.{1,2}/[^"'?#]+(?:[?#][^"']*)?)["']"""),
        re.compile(r"""^\s*import\s*["'](\.{1,2}/[^"'?#]+(?:[?#][^"']*)?)["']""", re.MULTILINE),
        re.compile(r"""\bimport\s*\(\s*["'](\.{1,2}/[^"'?#]+(?:[?#][^"']*)?)["']\s*\)"""),
    ]
    known_extensions = ('.js', '.mjs', '.cjs', '.json', '.node')

    if shutil.which('npm') is None and not vendor_root.exists():
        pytest.skip('npm/vendor assets are not available in this environment')

    offenders = []
    for path in vendor_root.rglob('*'):
        if not path.is_file() or path.suffix not in {'.js', '.mjs'}:
            continue
        text = path.read_text(encoding='utf-8')
        for pattern in pattern_specs:
            for match in pattern.finditer(text):
                specifier = match.group(1).strip()
                base_specifier = re.split(r'[?#]', specifier, maxsplit=1)[0]
                if base_specifier.endswith(known_extensions):
                    continue
                offenders.append(f"{path.as_posix()} :: {specifier}")

    assert not offenders, (
        'frontend runtime vendor contains browser-unsafe relative ESM imports without file extensions:\n'
        + '\n'.join(offenders[:20])
    )

def test_source_mode_templates_include_codemirror6_importmap_before_entry_module():
    templates = [
        'xkeen-ui/templates/panel.html',
        'xkeen-ui/templates/devtools.html',
        'xkeen-ui/templates/xkeen.html',
        'xkeen-ui/templates/backups.html',
        'xkeen-ui/templates/mihomo_generator.html',
    ]

    for rel in templates:
        text = Path(rel).read_text(encoding='utf-8')
        include_marker = "{% include '_codemirror6_importmap.html' %}"
        module_marker = 'frontend_page_entry_url('

        assert include_marker in text, rel
        assert module_marker in text, rel
        assert text.index(include_marker) < text.index(module_marker), rel

def test_terminal_lazy_entry_uses_import_first_vendor_adapter_without_dom_script_injection():
    entry_text = Path('xkeen-ui/static/js/pages/terminal.lazy.entry.js').read_text(encoding='utf-8')
    adapter_text = Path('xkeen-ui/static/js/terminal/vendors/xterm_import_adapter.js').read_text(encoding='utf-8')

    assert "from '../terminal/vendors/xterm_import_adapter.js';" in entry_text
    assert 'await ensureXtermVendorReady();' in entry_text
    assert "document.createElement('script')" not in entry_text
    assert 'appendChild(script)' not in entry_text
    assert 'document.head.appendChild(script)' not in entry_text
    assert 'querySelector(\'script[data-xk-term-src="' not in entry_text

    assert 'export async function ensureXtermVendorReady()' in adapter_text
    assert 'await import(/* @vite-ignore */ url);' in adapter_text
    assert "appendTerminalDebug('lazy:vendor:amd-shield'" in adapter_text
    assert 'restoreAmdGlobals(scope, amdStash)' in adapter_text
    assert "document.createElement('script')" not in adapter_text
    assert 'appendChild(script)' not in adapter_text


def test_routing_fragment_refresh_uses_runtime_http_api_instead_of_undefined_core_http_global():
    path = Path('xkeen-ui/static/js/features/routing.js')
    text = path.read_text(encoding='utf-8')

    assert 'const coreHttp = getXkeenCoreHttpApi();' in text
    assert 'CORE_HTTP.fetchJSON' not in text


def test_routing_fragment_switch_uses_commit_helper_and_rolls_back_after_load_failure():
    text = Path('xkeen-ui/static/js/features/routing.js').read_text(encoding='utf-8')

    assert 'async function loadCommittedFragmentSelection(next, opts)' in text
    assert 'return _activeFragment || getSelectedFragmentFromUI() || restoreRememberedFragment() || null;' in text
    assert 'const ok = await load();' in text
    assert 'if (ok) return true;' in text
    assert 'if (prevValue) restoreFragmentSelection(selectEl, prevValue, prevDir, prevItems);' in text
    assert "commit: async () => loadCommittedFragmentSelection(next, {" in text
    assert 'applyActiveFragment(next, dir);' not in text


def test_routing_refresh_button_is_wired_in_wireui_instead_of_refresh_success_path():
    text = Path('xkeen-ui/static/js/features/routing.js').read_text(encoding='utf-8')

    assert 'const refreshBtn = $(IDS.fragmentRefresh);' in text
    assert "await refreshFragmentsList({ notify: true, prevSelection: prev, syncActive: false });" in text
    assert "const next = getSelectedFragmentFromUI() || getActiveFragment();" in text
    assert "if (btn && !btn.dataset.xkWired)" not in text


def test_routing_comments_ux_listener_is_guarded_after_init_flag():
    text = Path('xkeen-ui/static/js/features/routing.js').read_text(encoding='utf-8')

    assert 'let _commentsUxWired = false;' in text
    assert 'if (_inited) return;' in text
    assert "document.addEventListener('xkeen:routing-comments-ux', (ev) => {" in text
    assert '_commentsUxWired = true;' in text
    assert text.index('if (_inited) return;') < text.index("document.addEventListener('xkeen:routing-comments-ux', (ev) => {")


def test_mihomo_template_load_button_uses_dirty_guard_while_select_path_skips_duplicate_prompt():
    text = Path('xkeen-ui/static/js/features/mihomo_panel.js').read_text(encoding='utf-8')

    assert 'async function confirmDiscardDirtyEditorChanges(opts)' in text
    assert "MP.loadSelectedTemplateToEditor = async function loadSelectedTemplateToEditor(opts) {" in text
    assert "const confirmDirty = !Object.prototype.hasOwnProperty.call(options, 'confirmDirty') || !!options.confirmDirty;" in text
    assert "if (confirmDirty && !(await confirmDiscardDirtyEditorChanges({" in text
    assert "const loaded = await MP.loadSelectedTemplateToEditor({ confirmDirty: false });" in text


def test_mihomo_server_side_config_swaps_resync_editor_after_activate_and_restore():
    text = Path('xkeen-ui/static/js/features/mihomo_panel.js').read_text(encoding='utf-8')

    assert "async function loadLiveConfigIntoEditor()" in text
    assert text.count("const syncResult = await loadLiveConfigIntoEditor();") >= 2
    assert "const res = await fetch('/api/mihomo/profiles/' + encodeURIComponent(name) + '/activate', { method: 'POST' });" in text
    assert "const res = await fetch('/api/mihomo/backups/' + encodeURIComponent(filename) + '/restore', { method: 'POST' });" in text
    assert "config.yaml уже изменён на сервере, но редактор не удалось обновить." in text
    assert "Восстановление из бэкапа заменит текущее содержимое редактора." in text


def test_routing_dat_card_keeps_visible_current_file_labels_in_sync_with_selected_names():
    ids_text = Path('xkeen-ui/static/js/features/routing_cards/ids.js').read_text(encoding='utf-8')
    panel_text = Path('xkeen-ui/templates/panel.html').read_text(encoding='utf-8')
    card_text = Path('xkeen-ui/static/js/features/routing_cards/dat/card.js').read_text(encoding='utf-8')

    assert "datGeositeCurrentFile: 'routing-dat-geosite-current-file'" in ids_text
    assert "datGeoipCurrentFile: 'routing-dat-geoip-current-file'" in ids_text
    assert 'id="routing-dat-geosite-current-file"' in panel_text
    assert 'id="routing-dat-geoip-current-file"' in panel_text
    assert 'function syncDatCurrentFileLabels(prefs)' in card_text
    assert 'syncDatCurrentFileLabels(prefs);' in card_text
    assert "if (source === 'dir' || source === 'name') refreshLater();" in card_text


def test_routing_dat_actions_read_current_dom_selection_before_falling_back_to_saved_prefs():
    text = Path('xkeen-ui/static/js/features/routing_cards/dat/api.js').read_text(encoding='utf-8')

    assert 'function readKindPrefs(kind)' in text
    assert "const dirId = (k === 'geosite') ? IDS.datGeositeDir : IDS.datGeoipDir;" in text
    assert "const nameId = (k === 'geosite') ? IDS.datGeositeName : IDS.datGeoipName;" in text
    assert "const urlId = (k === 'geosite') ? IDS.datGeositeUrl : IDS.datGeoipUrl;" in text
    assert text.count('const p = readKindPrefs(k);') >= 3


def test_routing_dat_prefs_backfill_blank_values_with_defaults():
    text = Path('xkeen-ui/static/js/features/routing_cards/dat/prefs.js').read_text(encoding='utf-8')

    assert 'function mergeKindDefaults(kind, value)' in text
    assert "if (!String(merged.url || '').trim()) merged.url = DEFAULTS[k].url;" in text
    assert "if (!String(merged.dir || '').trim()) merged.dir = DEFAULTS[k].dir;" in text
    assert "if (!String(merged.name || '').trim()) merged.name = DEFAULTS[k].name;" in text


def test_panel_shell_dat_fallback_rehydrates_current_card_before_deferring_and_dispatches_input_change():
    text = Path('xkeen-ui/static/js/pages/panel_shell.shared.js').read_text(encoding='utf-8')
    card_text = Path('xkeen-ui/static/js/features/routing_cards/dat/card.js').read_text(encoding='utf-8')

    assert 'function hasModernRoutingDatFeature()' in text
    assert 'function isCurrentRoutingDatCardWired()' in text
    assert 'function ensureModernRoutingDatCardReady()' in text
    assert "if (ensureModernRoutingDatCardReady()) return;" in text
    assert "return !!(datBody && datBody.dataset && datBody.dataset.xkDatCardWired === '1');" in text
    assert "if (datBody.dataset) datBody.dataset.xkDatCardWired = '1';" in card_text
    assert "refs.name.dispatchEvent(new Event('input', { bubbles: true }));" in text
    assert "refs.name.dispatchEvent(new Event('change', { bubbles: true }));" in text


def test_xray_logs_height_prefs_keep_local_draft_and_survive_hidden_view_saves():
    text = Path('xkeen-ui/static/js/features/xray_logs.js').read_text(encoding='utf-8')

    assert 'const LOG_WINDOW_MIN_HEIGHT = 420;' in text
    assert 'function _resolveLogWindowHeight(refs, runtimeState)' in text
    assert 'const storedHeight = _normalizeLogWindowHeight(readStoredUiState().height);' in text
    assert 'const height = _resolveLogWindowHeight(refs, runtime);' in text
    assert "try { mergeStoredUiState(collectUiState()); } catch (e) {}" in text
    assert "ui-settings: failed to promote local logs view draft" in text
