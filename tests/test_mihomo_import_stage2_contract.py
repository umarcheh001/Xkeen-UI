"""Static guardrails for Stage 2 state/API extraction."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
IMPORT = (ROOT / 'xkeen-ui/static/js/features/mihomo_import.js').read_text()
STATE = (ROOT / 'xkeen-ui/static/js/features/mihomo_import_state.js').read_text()
API = (ROOT / 'xkeen-ui/static/js/features/mihomo_import_api.js').read_text()


def test_import_feature_uses_state_and_transport_adapters():
    assert "from './mihomo_import_state.js';" in IMPORT
    assert "from './mihomo_import_api.js';" in IMPORT
    assert 'const _importState = createMihomoImportState();' in IMPORT
    assert 'const _importApi = createMihomoImportApi' in IMPORT
    assert "fetch('/api/" not in IMPORT
    assert "fetch(\"/api/" not in IMPORT
    assert "return _importApi.postJSON('/api/mihomo/provider/probe'" in IMPORT
    assert "await _importApi.postJSON('/api/mihomo/patch/apply_insert'" in IMPORT


def test_import_feature_invalidates_input_and_mode_changes():
    assert 'function invalidateImportUiResult()' in IMPORT
    assert "inp.addEventListener('input'" in IMPORT
    assert 'invalidateImportUiResult();' in IMPORT
    assert 'const token = beginMihomoImportRequest(_importState, \'parse\');' in IMPORT
    assert 'if (!isCurrentImportRequest(requestToken)) return;' in IMPORT
    assert 'commitMihomoImportResult(_importState, requestToken, result)' in IMPORT
    assert 'isCurrentMihomoImportResult(_importState, _lastResult)' in IMPORT


def test_state_module_has_session_revision_and_result_guards():
    for marker in (
        'sessionId',
        'sourceRevision',
        'activeRequest',
        'beginMihomoImportRequest',
        'isCurrentMihomoImportRequest',
        'commitMihomoImportResult',
        'resetMihomoImportState',
    ):
        assert marker in STATE


def test_api_module_normalizes_transport_errors():
    assert 'createMihomoImportApi' in API
    assert 'postJSON' in API
    assert 'requestJSON' in API
    assert 'error.status' in API
    assert 'error.data' in API
