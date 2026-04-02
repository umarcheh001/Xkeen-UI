from pathlib import Path


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


def test_static_vendor_tree_contains_runtime_dependencies_for_cm6_source_mode():
    required_files = [
        'xkeen-ui/static/vendor/npm/@codemirror/state/dist/index.js',
        'xkeen-ui/static/vendor/npm/@codemirror/view/dist/index.js',
        'xkeen-ui/static/vendor/npm/@codemirror/language/dist/index.js',
        'xkeen-ui/static/vendor/npm/codemirror/dist/index.js',
        'xkeen-ui/static/vendor/npm/jsonc-parser/lib/esm/main.js',
        'xkeen-ui/static/vendor/npm/style-mod/src/style-mod.js',
        'xkeen-ui/static/vendor/npm/w3c-keyname/index.js',
    ]

    for rel in required_files:
        assert Path(rel).exists(), rel



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
