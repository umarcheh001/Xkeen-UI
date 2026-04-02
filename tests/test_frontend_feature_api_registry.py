from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FEATURES_DIR = ROOT / "xkeen-ui" / "static" / "js" / "features"
INDEX = FEATURES_DIR / "index.js"


def test_feature_api_registry_exists_and_tracks_current_top_level_features():
    assert INDEX.is_file(), "frontend feature API registry should exist"

    text = INDEX.read_text(encoding="utf-8")
    required_fragments = [
        "export const featureApiRegistry = Object.freeze({",
        "backups: backupsApi,",
        "fileManager: fileManagerApi,",
        "mihomoPanel: mihomoPanelApi,",
        "mihomoImport: mihomoImportApi,",
        "mihomoProxyTools: mihomoProxyToolsApi,",
        "mihomoHwidSub: mihomoHwidSubApi,",
        "restartLog: restartLogApi,",
        "routing: routingApi,",
        "serviceStatus: serviceStatusApi,",
        "xrayLogs: xrayLogsApi,",
    ]
    for fragment in required_fragments:
        assert fragment in text, f"missing registry fragment in {INDEX}: {fragment}"


def test_selected_feature_modules_export_named_api_wrappers():
    expectations = {
        "donate.js": [
            "let donateModuleApi = null;",
            "export function getDonateApi()",
            "export const donateApi = Object.freeze({",
        ],
        "branding_prefs.js": [
            "let brandingPrefsModuleApi = null;",
            "export function getBrandingPrefsApi()",
            "export const brandingPrefsApi = Object.freeze({",
        ],
        "devtools.js": [
            "let devtoolsModuleApi = null;",
            "export function getDevtoolsApi()",
            "export const devtoolsApi = Object.freeze({",
        ],
        "layout_prefs.js": [
            "let layoutPrefsModuleApi = null;",
            "export function getLayoutPrefsApi()",
            "export const layoutPrefsApi = Object.freeze({",
        ],
        "typography.js": [
            "let typographyModuleApi = null;",
            "export function getTypographyApi()",
            "export const typographyApi = Object.freeze({",
        ],
        "update_notifier.js": [
            "let updateNotifierModuleApi = null;",
            "export function getUpdateNotifierApi()",
            "export const updateNotifierApi = Object.freeze({",
        ],
        "routing_templates.js": [
            "let routingTemplatesModuleApi = null;",
            "export function getRoutingTemplatesApi()",
            "export const routingTemplatesApi = Object.freeze({",
        ],
        "file_manager.js": [
            "export function getFileManagerApi()",
            "export const fileManagerApi = Object.freeze({",
        ],
        "mihomo_yaml_patch.js": [
            "let mihomoYamlPatchModuleApi = null;",
            "export function getMihomoYamlPatchApi()",
            "export const mihomoYamlPatchApi = Object.freeze({",
        ],
        "mihomo_panel.js": [
            "export function getMihomoPanelApi()",
            "export function initMihomoPanel(...args)",
            "export const mihomoPanelApi = Object.freeze({",
        ],
        "mihomo_import.js": [
            "export function getMihomoImportApi()",
            "export function generateMihomoImportConfig(...args)",
            "export const mihomoImportApi = Object.freeze({",
        ],
        "mihomo_proxy_tools.js": [
            "export function getMihomoProxyToolsApi()",
            "export function initMihomoProxyTools(...args)",
            "export const mihomoProxyToolsApi = Object.freeze({",
        ],
        "mihomo_hwid_sub.js": [
            "export function getMihomoHwidSubApi()",
            "export function initMihomoHwidSub(...args)",
            "export const mihomoHwidSubApi = Object.freeze({",
        ],
        "restart_log.js": [
            "export function getRestartLogApi()",
            "export function appendRestartLog(...args)",
            "export const restartLogApi = Object.freeze({",
        ],
        "xray_logs.js": [
            "let xrayLogsModuleApi = null;",
            "export function getXrayLogsApi()",
            "export const xrayLogsApi = Object.freeze({",
        ],
        "routing_jsonc_preserve.js": [
            "let routingJsoncPreserveModuleApi = null;",
            "export function getRoutingJsoncPreserveApi()",
            "export const routingJsoncPreserveApi = Object.freeze({",
        ],
        "routing_shell.js": [
            "let routingShellModuleApi = null;",
            "export function getRoutingShellApi()",
            "export const routingShellApi = Object.freeze({",
        ],
        "routing_cards_namespace.js": [
            "let routingCardsNamespace = null;",
            "export function getRoutingCardsNamespace()",
            "export const routingCardsNamespaceApi = Object.freeze({",
        ],
    }

    for filename, fragments in expectations.items():
        text = (FEATURES_DIR / filename).read_text(encoding="utf-8")
        for fragment in fragments:
            assert fragment in text, f"missing explicit API fragment in {filename}: {fragment}"


def test_selected_small_feature_modules_no_longer_use_window_xkeen_features_as_canonical_api():
    expectations = {
        "donate.js": [
            "window.XKeen.features ? (window.XKeen.features.donate || null) : null",
            "XK.features.donate = Donate;",
        ],
        "branding_prefs.js": [
            "window.XKeen.features ? (window.XKeen.features.brandingPrefs || null) : null",
            "XK.features.brandingPrefs = Feature;",
        ],
        "devtools.js": [
            "XK.features = XK.features || {};",
            "XK.features.devtools",
            "window.XKeen.features ? (window.XKeen.features.devtools || null) : null",
        ],
        "layout_prefs.js": [
            "window.XKeen.features ? (window.XKeen.features.layoutPrefs || null) : null",
            "XK.features.layoutPrefs = XK.features.layoutPrefs || {};",
        ],
        "typography.js": [
            "window.XKeen.features ? (window.XKeen.features.typography || null) : null",
            "XK.features.typography = XK.features.typography || {};",
        ],
        "update_notifier.js": [
            "window.XKeen.features ? (window.XKeen.features.updateNotifier || null) : null",
            "XK.features.updateNotifier = XK.features.updateNotifier || {}",
        ],
        "routing_templates.js": [
            "window.XKeen.features ? (window.XKeen.features.routingTemplates || null) : null",
            "XK.features.routingTemplates = {",
        ],
        "restart_log.js": [
            "window.XKeen.features ? (window.XKeen.features.restartLog || null) : null",
            "XKeen.features = XKeen.features || {};",
        ],
        "commands_list.js": [
            "window.XKeen.features ? (window.XKeen.features.commandsList || null) : null",
            "XKeen.features = XKeen.features || {};",
        ],
        "cores_status.js": [
            "window.XKeen.features ? (window.XKeen.features.coresStatus || null) : null",
            "XKeen.features = XKeen.features || {};",
        ],
        "service_status.js": [
            "window.XKeen.features ? (window.XKeen.features.serviceStatus || null) : null",
            "XKeen.features = XKeen.features || {};",
        ],
        "mihomo_yaml_patch.js": [
            "GLOBAL_XKEEN.features.mihomoYamlPatch",
            "const api = GLOBAL_XKEEN && GLOBAL_XKEEN.features ? GLOBAL_XKEEN.features.mihomoYamlPatch : null;",
        ],
        "xray_logs.js": [
            "window.XKeen.features ? (window.XKeen.features.xrayLogs || null) : null",
            "XKeen.features = XKeen.features || {};",
        ],
        "routing_jsonc_preserve.js": [
            "window.XKeen.features ? (window.XKeen.features.routingJsoncPreserve || null) : null",
        ],
        "mihomo_panel.js": [
            "XKeen.features = XKeen.features || {};",
            "XKeen.features.mihomoPanel = MP;",
            "window.XKeen.features.mihomoPanel",
        ],
        "mihomo_import.js": [
            "XKeen.features = XKeen.features || {};",
            "XKeen.features.mihomoImport = MI;",
            "window.XKeen.features.mihomoImport",
        ],
        "mihomo_proxy_tools.js": [
            "XKeen.features = XKeen.features || {};",
            "XKeen.features.mihomoProxyTools = PT;",
            "window.XKeen.features.mihomoProxyTools",
        ],
        "mihomo_hwid_sub.js": [
            "XKeen.features = XKeen.features || {};",
            "XKeen.features.mihomoHwidSub = HW;",
            "window.XKeen.features.mihomoHwidSub",
        ],
        "inbounds.js": [
            "XKeen.features = XKeen.features || {};",
            "window.XKeen.features) ? window.XKeen.features.inbounds : null",
        ],
        "outbounds.js": [
            "XKeen.features = XKeen.features || {};",
            "window.XKeen.features) ? window.XKeen.features.outbounds : null",
        ],
        "routing.js": [
            "XKeen.features = XKeen.features || {};",
            "window.XKeen.features ? window.XKeen.features.routing : null",
        ],
        "routing_cards.js": [
            "window.XKeen.features ? window.XKeen.features.routingCards : null",
        ],
        "routing_shell.js": [
            "const shell = XK.features.routingShell = XK.features.routingShell || {};",
            "window.XKeen && window.XKeen.features ? window.XKeen.features.routingShell : null",
        ],
        "routing_cards_namespace.js": [
            "XK.features && XK.features.routingCards",
        ],
        "ui_prefs_io.js": [
            "XK.features = XK.features || {};",
            "XK.features.uiPrefsIO = Feature;",
            "window.XKeen.features ? (window.XKeen.features.uiPrefsIO || null) : null",
            "XK.features.donate",
        ],
        "xkeen_texts.js": [
            "XKeen.features = XKeen.features || {};",
            "window.XKeen.features ? (window.XKeen.features.xkeenTexts || null) : null",
        ],
        "mihomo_generator.js": [
            "XKeen.features = XKeen.features || {};",
            "window.XKeen.features ? (window.XKeen.features.mihomoGenerator || null) : null",
        ],
    }

    for filename, forbidden_fragments in expectations.items():
        text = (FEATURES_DIR / filename).read_text(encoding="utf-8")
        for fragment in forbidden_fragments:
            assert fragment not in text, f"feature module should no longer use global canonical API in {filename}: {fragment}"


def test_file_manager_namespace_module_is_the_canonical_api_root():
    namespace_src = (FEATURES_DIR / "file_manager_namespace.js").read_text(encoding="utf-8")
    module_src = (FEATURES_DIR / "file_manager.js").read_text(encoding="utf-8")

    assert "let fileManagerApiRoot = null;" in namespace_src
    assert "export function getFileManagerApiRoot()" in namespace_src
    assert "return getFileManagerApiRoot();" in namespace_src
    assert "return getFileManagerApiRoot();" in module_src


def test_file_manager_common_module_exposes_runtime_adapter_helpers():
    common_src = (FEATURES_DIR / "file_manager" / "common.js").read_text(encoding="utf-8")

    required_fragments = [
        "C.getUiApi = function getUiApi()",
        "C.getModalApi = function getModalApi()",
        "C.getLayoutApi = function getLayoutApi()",
        "C.getCoreHttp = function getCoreHttp()",
        "C.getEditorEngine = function getEditorEngine()",
        "C.getLazyRuntime = function getLazyRuntime()",
        "C.getTerminal = function getTerminal()",
        "C.syncBodyScrollLock = function syncBodyScrollLock(locked)",
        "C.confirm = async function confirm(opts, fallbackText)",
    ]
    for fragment in required_fragments:
        assert fragment in common_src, f"missing file_manager common runtime helper: {fragment}"


def test_selected_file_manager_modules_use_common_runtime_helpers_instead_of_raw_window_xkeen_globals():
    expectations = {
        "file_manager/api.js": [
            "window.XKeen.core.http",
        ],
        "file_manager/actions.js": [
            "XKeen.ui.confirm",
        ],
        "file_manager.js": [
            "XKeen.ui.layout",
            "window.XKeen && XKeen.ui && XKeen.ui.layout",
        ],
        "file_manager/actions_modals.js": [
            "XKeen.ui.confirm",
        ],
        "file_manager/bookmarks.js": [
            "window.toast",
            "XKeen.ui.toast",
        ],
        "file_manager/chrome.js": [
            "XKeen.ui.modal.syncBodyScrollLock",
        ],
        "file_manager/dragdrop.js": [
            "XKeen.ui.modal.syncBodyScrollLock",
        ],
        "file_manager/editor.js": [
            "XKeen.ui.modal.syncBodyScrollLock",
            "XKeen.ui.editorEngine",
            "window.toast",
            "XKeen.ui.confirm",
        ],
        "file_manager/errors.js": [
            "window.toast",
        ],
        "file_manager/ops.js": [
            "XKeen.ui.confirm",
        ],
        "file_manager/remote.js": [
            "XKeen.ui.confirm",
        ],
        "file_manager/storage.js": [
            "XKeen.ui.confirm",
            "XKeen.ui.toast",
        ],
        "file_manager/terminal.js": [
            "XKeen.runtime.lazy",
            "window.XKeen.terminal",
            "XKeen.ui.toast",
        ],
        "file_manager/transfers.js": [
            "XKeen.ui.confirm",
        ],
    }

    for relative_path, forbidden_fragments in expectations.items():
        text = (FEATURES_DIR / relative_path).read_text(encoding="utf-8")
        for fragment in forbidden_fragments:
            assert fragment not in text, (
                f"file_manager module should use shared common runtime helpers instead of raw globals in {relative_path}: {fragment}"
            )


def test_routing_cards_subtree_uses_canonical_namespace_root():
    namespace_src = (FEATURES_DIR / "routing_cards_namespace.js").read_text(encoding="utf-8")
    facade_src = (FEATURES_DIR / "routing_cards.js").read_text(encoding="utf-8")
    compat_src = (FEATURES_DIR / "compat" / "routing_cards.js").read_text(encoding="utf-8")

    assert "const RC = {};" in namespace_src
    assert "import { getRoutingCardsNamespace } from './routing_cards_namespace.js';" in facade_src
    assert "import { getRoutingCardsNamespace } from '../routing_cards_namespace.js';" in compat_src
    assert "const legacyRoutingCardsApi = routingCardsNamespace;" in compat_src

    for path in sorted((FEATURES_DIR / "routing_cards").rglob("*.js")):
        text = path.read_text(encoding="utf-8")
        assert "XK.features.routingCards = XK.features.routingCards || {}" not in text, (
            f"routing_cards subtree should not use window.XKeen.features.routingCards as canonical root: {path.name}"
        )
        assert "XK.features = XK.features || {};" not in text, (
            f"routing_cards subtree should not create a canonical features root: {path.name}"
        )
        if path.name == "ns.js":
            assert "initRoutingCardsNamespace" in text
        else:
            assert "getRoutingCardsNamespace" in text, (
                f"routing_cards subtree should use canonical namespace helper in {path.name}"
            )


def test_devtools_subtree_uses_canonical_namespace_root():
    namespace_src = (FEATURES_DIR / "devtools_namespace.js").read_text(encoding="utf-8")
    main_src = (FEATURES_DIR / "devtools.js").read_text(encoding="utf-8")
    compat_src = (FEATURES_DIR / "compat" / "devtools.js").read_text(encoding="utf-8")

    assert "let devtoolsNamespace = null;" in namespace_src
    assert "export function getDevtoolsNamespace()" in namespace_src
    assert "export function setDevtoolsNamespaceApi(name, api)" in namespace_src
    assert "import { getDevtoolsNamespace, getDevtoolsSharedApi, setDevtoolsNamespaceApi } from './devtools_namespace.js';" in main_src
    assert "setDevtoolsNamespaceApi('devtools', devtoolsModuleApi);" in main_src
    assert "import { getDevtoolsApi } from '../devtools.js';" in compat_src
    assert "XKeen.features[key] = legacyApi;" in compat_src

    for path in sorted((FEATURES_DIR / "devtools").rglob("*.js")):
        text = path.read_text(encoding="utf-8")
        assert "XK.features = XK.features || {};" not in text, (
            f"devtools subtree should not recreate window.XKeen.features in {path.name}"
        )
        assert "XK.features.devtools" not in text, (
            f"devtools subtree should not use window.XKeen.features.* as canonical API in {path.name}"
        )
        assert "window.XKeen.features" not in text, (
            f"devtools subtree should not read canonical API from window.XKeen.features in {path.name}"
        )


def test_xkeen_runtime_module_exposes_shared_runtime_adapter_helpers():
    runtime_src = (FEATURES_DIR / "xkeen_runtime.js").read_text(encoding="utf-8")

    required_fragments = [
        "export function getXkeenStateApi()",
        "export function getXkeenConfigDirtyApi()",
        "export function getXkeenFormattersApi()",
        "export function getXkeenCm6RuntimeApi()",
        "export function getXkeenJsonEditorApi()",
        "export function getXkeenPanelShellApi()",
        "export function getXkeenCoreHttpApi()",
        "export function getXkeenCoreStorageApi()",
        "export function getXkeenCommandJobApi()",
        "export function getXkeenShowXrayPreflightErrorApi()",
        "export function openXkeenJsonEditor(target, options)",
        "export function ansiToXkeenHtml(text)",
        "export const xkeenRuntimeApi = Object.freeze({",
        "getStateApi: getXkeenStateApi,",
        "getConfigDirtyApi: getXkeenConfigDirtyApi,",
        "getFormattersApi: getXkeenFormattersApi,",
        "getCm6RuntimeApi: getXkeenCm6RuntimeApi,",
        "getJsonEditorApi: getXkeenJsonEditorApi,",
        "getPanelShellApi: getXkeenPanelShellApi,",
        "getCoreHttpApi: getXkeenCoreHttpApi,",
        "getCoreStorageApi: getXkeenCoreStorageApi,",
        "getCommandJobApi: getXkeenCommandJobApi,",
        "getShowXrayPreflightErrorApi: getXkeenShowXrayPreflightErrorApi,",
        "openJsonEditor: openXkeenJsonEditor,",
        "ansiToHtml: ansiToXkeenHtml,",
    ]

    for fragment in required_fragments:
        assert fragment in runtime_src, f"missing shared runtime adapter fragment in xkeen_runtime.js: {fragment}"


def test_selected_runtime_adapter_feature_modules_no_longer_read_raw_window_xkeen_or_window_toast_globals():
    expectations = {
        "commands_list.js": [
            "from './xkeen_runtime.js';",
        ],
        "cores_status.js": [
            "from './xkeen_runtime.js';",
        ],
        "service_status.js": [
            "from './xkeen_runtime.js';",
        ],
        "update_notifier.js": [
            "from './xkeen_runtime.js';",
        ],
        "xray_logs.js": [
            "from './xkeen_runtime.js';",
        ],
        "backups.js": [
            "from './xkeen_runtime.js';",
        ],
        "github.js": [
            "from './xkeen_runtime.js';",
        ],
        "local_io.js": [
            "from './xkeen_runtime.js';",
        ],
        "inbounds.js": [
            "from './xkeen_runtime.js';",
        ],
        "outbounds.js": [
            "from './xkeen_runtime.js';",
        ],
        "restart_log.js": [
            "from './xkeen_runtime.js';",
        ],
        "routing.js": [
            "from './xkeen_runtime.js';",
        ],
        "routing_cards.js": [
            "from './xkeen_runtime.js';",
        ],
        "routing_templates.js": [
            "from './xkeen_runtime.js';",
        ],
        "xkeen_texts.js": [
            "from './xkeen_runtime.js';",
        ],
    }
    forbidden_fragments = [
        "window.XKeen.",
        "XKeen.ui.",
        "XKeen.core.",
        "XKeen.pages.",
        "XKeen.util.",
        "XKeen.runtime.",
        "XKeen.terminal.",
        "XKeen.jsonEditor",
        "XKeen.state.",
        "window.toast(",
        "window.showToast(",
        "window.openTerminal(",
    ]

    for filename, required_fragments in expectations.items():
        text = (FEATURES_DIR / filename).read_text(encoding="utf-8")
        for fragment in required_fragments:
            assert fragment in text, f"missing shared runtime adapter import in {filename}: {fragment}"
        for fragment in forbidden_fragments:
            assert fragment not in text, (
                f"feature module should use xkeen_runtime/shared adapter helpers instead of raw globals in {filename}: {fragment}"
            )


def test_routing_shell_keeps_editor_state_module_local_instead_of_window_xkeen_state():
    shell_src = (FEATURES_DIR / "routing_shell.js").read_text(encoding="utf-8")

    assert "const state = shell.state = shell.state || {};" in shell_src
    assert "XK.state.routingEditor" not in shell_src
    assert "XK.state.routingEditorFacade" not in shell_src
    assert "window.XKeen" not in shell_src
