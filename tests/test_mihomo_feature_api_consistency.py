from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _read(rel_path: str) -> str:
    return (ROOT / rel_path).read_text(encoding="utf-8")


def test_panel_mihomo_bundle_uses_canonical_feature_urls():
    src = _read("xkeen-ui/static/js/pages/panel.mihomo.bundle.js")

    assert "../features/mihomo_panel.js?v=" not in src
    assert "../features/mihomo_yaml_patch.js?v=" not in src
    assert "import '../features/mihomo_panel.js';" in src
    assert "import '../features/compat/mihomo_panel.js';" in src
    assert "import '../features/mihomo_yaml_patch.js';" in src


def test_mihomo_legacy_global_publish_is_handled_only_by_compat_modules():
    expectations = {
        "xkeen-ui/static/js/features/compat/mihomo_panel.js": "XKeen.features.mihomoPanel = legacyMihomoPanelApi;",
        "xkeen-ui/static/js/features/compat/mihomo_import.js": "XKeen.features.mihomoImport = legacyMihomoImportApi;",
        "xkeen-ui/static/js/features/compat/mihomo_proxy_tools.js": "XKeen.features.mihomoProxyTools = legacyMihomoProxyToolsApi;",
        "xkeen-ui/static/js/features/compat/mihomo_hwid_sub.js": "XKeen.features.mihomoHwidSub = legacyMihomoHwidSubApi;",
    }

    for rel_path, marker in expectations.items():
        src = _read(rel_path)
        assert marker in src, f"expected legacy global API marker in {rel_path}"

    forbidden = {
        "xkeen-ui/static/js/features/mihomo_panel.js": [
            "XKeen.features = XKeen.features || {};",
            "XKeen.features.mihomoPanel = MP;",
            "window.XKeen.features.mihomoPanel",
        ],
        "xkeen-ui/static/js/features/mihomo_import.js": [
            "XKeen.features = XKeen.features || {};",
            "XKeen.features.mihomoImport = MI;",
            "window.XKeen.features.mihomoImport",
        ],
        "xkeen-ui/static/js/features/mihomo_proxy_tools.js": [
            "XKeen.features = XKeen.features || {};",
            "XKeen.features.mihomoProxyTools = PT;",
            "window.XKeen.features.mihomoProxyTools",
        ],
        "xkeen-ui/static/js/features/mihomo_hwid_sub.js": [
            "XKeen.features = XKeen.features || {};",
            "XKeen.features.mihomoHwidSub = HW;",
            "window.XKeen.features.mihomoHwidSub",
        ],
    }

    for rel_path, markers in forbidden.items():
        src = _read(rel_path)
        for marker in markers:
            assert marker not in src, f"canonical Mihomo module should not self-publish global API in {rel_path}: {marker}"


def test_panel_lazy_bindings_load_mihomo_compat_bridges_for_legacy_consumers():
    src = _read("xkeen-ui/static/js/pages/panel.lazy_bindings.runtime.js")

    required_fragments = [
        "mihomoImport: {",
        "load: () => import('../features/mihomo_import.js').then(",
        "import('../features/compat/mihomo_import.js')",
        "import('../features/mihomo_proxy_tools.js'))",
        "import('../features/compat/mihomo_proxy_tools.js').then(() => mod)",
        "mihomoHwidSub: {",
        "load: () => import('../features/mihomo_hwid_sub.js').then(",
        "import('../features/compat/mihomo_hwid_sub.js').then(() => mod)",
    ]

    for fragment in required_fragments:
        assert fragment in src, f"missing Mihomo compat panel-lazy fragment: {fragment}"


def test_mihomo_menu_feature_flows_keep_editor_patch_integrations_and_single_save_config():
    panel_src = _read("xkeen-ui/static/js/features/mihomo_panel.js")
    assert panel_src.count("MP.saveConfig = async function saveConfig() {") == 1

    expectations = {
        "xkeen-ui/static/js/features/mihomo_import.js": [
            "txt = await applyInsertProxy(txt, o, groups);",
            "setEditorText(txt);",
            "refreshEditor();",
            "const api = getMihomoPanelApi();",
        ],
        "xkeen-ui/static/js/features/mihomo_proxy_tools.js": [
            "const mi = getMihomoImportApi();",
            "const data = await apiPost('/api/mihomo/patch/rename_proxy', {",
            "const data = await apiPost('/api/mihomo/patch/replace_proxy', {",
            "setEditorText(patched);",
            "refreshEditor();",
        ],
        "xkeen-ui/static/js/features/mihomo_hwid_sub.js": [
            "const patch = getMihomoYamlPatchApi();",
            "const next = patch.insertIntoSection(existing, 'proxy-providers', snippet, { avoidDuplicates: true });",
            "setEditorText(next);",
            "refreshEditor();",
            "const r = await postJSONAllowError('/api/mihomo/hwid/apply', {",
        ],
    }

    for rel_path, markers in expectations.items():
        src = _read(rel_path)
        for marker in markers:
            assert marker in src, f"expected '{marker}' in {rel_path}"


def test_mihomo_runtime_helper_exposes_shared_window_xkeen_adapters():
    src = _read("xkeen-ui/static/js/features/mihomo_runtime.js")

    required_fragments = [
        "export function getMihomoUiApi()",
        "export function getMihomoModalApi()",
        "export function syncMihomoModalBodyScrollLock()",
        "export function getMihomoEditorEngineApi()",
        "export function getMihomoEditorActionsApi()",
        "export function getMihomoFormattersApi()",
        "export function getMihomoCoreHttpApi()",
        "export function getMihomoCommandJobApi()",
        "export async function confirmMihomoAction(opts, fallbackText)",
        "export function getSharedMihomoEditor()",
        "export function setSharedMihomoEditor(editor)",
        "export function clearSharedMihomoEditor(editor)",
        "export function refreshSharedMihomoEditor()",
    ]

    for fragment in required_fragments:
        assert fragment in src, f"missing Mihomo runtime helper fragment: {fragment}"


def test_mihomo_track2_modules_use_runtime_helper_instead_of_raw_window_xkeen_globals():
    expectations = {
        "xkeen-ui/static/js/features/mihomo_panel.js": [
            "window.XKeen && XKeen.util && XKeen.util.commandJob",
            "window.XKeen && XKeen.ui && typeof XKeen.ui.confirm === 'function'",
            "XKeen.state.mihomoEditor",
            "XKeen.ui.formatters.formatYaml",
            "XKeen.ui.editorEngine",
            "XKeen.ui.editorActions",
        ],
        "xkeen-ui/static/js/features/mihomo_import.js": [
            "window.XKeen = window.XKeen || {};",
            "XKeen.ui.editorEngine",
            "XKeen.state.mihomoEditor",
            "XKeen.ui.modal.syncBodyScrollLock",
            "(window.XKeen && XKeen.core && XKeen.core.http) ? XKeen.core.http : null",
        ],
        "xkeen-ui/static/js/features/mihomo_proxy_tools.js": [
            "window.XKeen = window.XKeen || {};",
            "XKeen.state.mihomoEditor",
            "(window.XKeen && XKeen.core && XKeen.core.http) ? XKeen.core.http : null",
        ],
        "xkeen-ui/static/js/features/mihomo_hwid_sub.js": [
            "window.XKeen = window.XKeen || {};",
            "XKeen.util.commandJob",
            "XKeen.ui.modal.syncBodyScrollLock",
            "XKeen.core.http",
            "XKeen.state.mihomoEditor",
        ],
        "xkeen-ui/static/js/features/mihomo_generator.js": [
            "window.XKeen = window.XKeen || {};",
            "XKeen.ui.editorEngine",
            "XKeen.ui.editorActions",
            "XKeen.util.commandJob",
        ],
    }

    for rel_path, markers in expectations.items():
        src = _read(rel_path)
        assert "from './mihomo_runtime.js'" in src, f"expected runtime helper import in {rel_path}"
        for marker in markers:
            assert marker not in src, f"Track 2 Mihomo module should not use raw window.XKeen.* in {rel_path}: {marker}"
