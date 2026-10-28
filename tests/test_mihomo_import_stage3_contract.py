"""Source/disclosure/lifecycle contract; behavior is exercised by Playwright."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JS = (ROOT / 'xkeen-ui/static/js/features/mihomo_import.js').read_text(encoding='utf-8')
TEMPLATE = (ROOT / 'xkeen-ui/templates/panel/modals/mihomo.html').read_text(encoding='utf-8')
CSS = (ROOT / 'xkeen-ui/static/panel-operator.css').read_text(encoding='utf-8')


def test_source_names_controls_and_status_are_accessible():
    assert 'id="mihomo-import-title">Добавить узлы в Mihomo' in TEMPLATE
    assert 'aria-labelledby="mihomo-import-title"' in TEMPLATE
    assert 'data-modal-focus="#mihomo-import-input"' in TEMPLATE
    assert 'role="status" aria-live="polite" aria-atomic="true"' in TEMPLATE
    assert 'id="mihomo-import-preview-toggle"' in TEMPLATE
    assert 'id="mihomo-import-managed-disclosure"' in TEMPLATE
    assert '<span class="xk-action-label">Распознать</span>' in TEMPLATE


def test_source_result_and_preview_share_one_bounded_shell():
    assert 'function setSourceLayout(hasResult)' in JS
    assert "const layout = _reviewOpen ? 'review' : (expanded ? 'preview' : (hasResult ? 'result' : 'source'));" in JS
    assert 'refreshGeometry?.(modal)' in JS
    assert "modal.dataset.modalRemember = '1';" in JS
    assert "modal.dataset.modalKey = expanded ? 'mihomo-import-preview-v2' : 'mihomo-import-source-v3';" in JS
    assert 'delete modal.dataset.modalNodrag;' in JS
    assert 'data-modal-position-only="1"' in TEMPLATE
    assert 'grid-template-rows: 50px minmax(0, 1fr) auto;' in CSS
    assert 'max-height: calc(100dvh - 16px)' in CSS
    assert 'height: var(--op-touch-target) !important;' in CSS


def test_runtime_has_no_eager_open_and_guards_async_preview_creation():
    opening = JS[JS.index('function showModal(show)'):JS.index('function wireButton')]
    assert 'scheduleEngineSync' not in opening
    assert 'disposePreviewMonaco' in opening
    assert 'disposeCodeMirrorEditor' in opening
    assert 'modalOpen() && _previewOpen && generation === _previewGeneration' in JS
    assert 'if (!current()) return;' in JS
    assert 'manager.open(modal' in opening
    assert 'manager.close(modal)' in opening


def test_transport_preserves_structured_errors_for_not_xray_fallback():
    api = (ROOT / 'xkeen-ui/static/js/features/mihomo_import_api.js').read_text(encoding='utf-8')
    assert 'error.data = data;' in api
    assert "code === 'not_xray_json'" in JS


def test_modal_manager_refresh_geometry_is_additive_not_a_new_manager():
    modal = (ROOT / 'xkeen-ui/static/js/ui/modal.js').read_text(encoding='utf-8')
    block = modal[modal.index('Modal.refreshGeometry ='):modal.index('Modal.bindState =')]
    assert 'resetContentPosition(content)' in block
    assert 'loadState(modalEl)' in block
    assert 'ensureResizer(modalEl)' in block
    assert 'ensureContentInViewport(modalEl)' in block
    assert "modalEl.dataset.modalPositionOnly === '1'" in modal
