from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "xkeen-ui/templates/panel.html"
CSS = ROOT / "xkeen-ui/static/panel-operator.css"
PLAN = ROOT / "docs/panel-operator-redesign-completion-plan.md"
CONTRACT = ROOT / "docs/panel-operator-stage5-editor-workbench.md"
INDEX = ROOT / "docs/README.md"


def test_stage5_editor_workbench_frame_is_shared_by_json_file_and_snapshot():
    template = TEMPLATE.read_text(encoding="utf-8")
    css = CSS.read_text(encoding="utf-8")

    for modal_id in ("json-editor-modal", "fm-editor-modal", "xray-snapshot-modal"):
        assert f'id="{modal_id}"' in template
        assert 'data-operator-modal-family="editor-workbench"' in template[template.index(f'id="{modal_id}"') - 80:template.index(f'id="{modal_id}"') + 180]
        assert modal_id in css

    for fragment in (
        "Stage 5 — editor/workbench family",
        "grid-template-rows: 50px minmax(0, 1fr) 50px;",
        "height: clamp(520px, 82dvh, 900px);",
        "min-height: 42px;",
        ".xk-editor-workbench-actions",
        ".xk-editor-workbench-action-group",
        "flex: 1 1 auto;",
        "overflow: hidden;",
    ):
        assert fragment in css




def test_stage5_json_statuses_are_labels_not_legacy_pills():
    template = TEMPLATE.read_text(encoding="utf-8")
    css = CSS.read_text(encoding="utf-8")
    json_modal = template[template.index('id="json-editor-modal"'):template.index('<!-- DAT GeoSite/GeoIP')]

    for status_id in ("json-editor-comments-status", "json-editor-schema-status"):
        line = next(line for line in json_modal.splitlines() if f'id="{status_id}"' in line)
        assert "xk-editor-status-label" in line
        assert "xk-comments-badge" not in line
        assert 'role="status"' in line

    toolbar_end = json_modal.index('</div>', json_modal.index('id="json-editor-toolbar"'))
    runtime_meta_start = json_modal.index('id="json-editor-runtime-meta"')
    editor_start = json_modal.index('id="json-editor-textarea"')
    assert runtime_meta_start > editor_start > toolbar_end

    assert 'id="json-editor-runtime-meta" class="xk-editor-runtime-meta"' in json_modal

    for fragment in (
        'body.panel-page #json-editor-modal .xk-editor-runtime-meta {',
        'border-top: 1px solid var(--op-border);',
        "body.panel-page #json-editor-modal .xk-editor-status-label {",
        "border-left: 0 !important;",
        "border-radius: 0 !important;",
        "body.panel-page #json-editor-modal .xk-editor-status-label::before {",
        "content: none !important;",
        ".xk-editor-status-label.xk-comments-on",
        ".xk-editor-status-label.xk-schema-on",
    ):
        assert fragment in css


def test_stage5_monaco_completion_and_parameter_widgets_use_operator_surfaces():
    css = CSS.read_text(encoding="utf-8")

    for fragment in (
        "body.panel-page .monaco-editor .suggest-widget {",
        ".suggest-details,",
        ".suggest-details-container,",
        ".parameter-hints-widget,",
        "background: var(--op-surface-2) !important;",
        "body.panel-page .monaco-editor :is(.suggest-details, .parameter-hints-widget) :is(pre, code) {",
    ):
        assert fragment in css



def test_stage5_all_static_modals_are_bound_to_one_of_the_four_family_frames():
    template = TEMPLATE.read_text(encoding="utf-8")
    css = CSS.read_text(encoding="utf-8")

    expected_counts = {
        "confirm-compact-form": 22,
        "editor-workbench": 7,
        "master-detail": 19,
        "drawer-help": 3,
    }
    modal_pairs = __import__("re").findall(
        r'<div\b[^>]*\bid="([^"]+)"[^>]*\bclass="[^"]*\bmodal\b[^"]*"[^>]*\bdata-operator-modal-family="([^"]+)"',
        template,
    )

    assert len(modal_pairs) == 51
    assert {family for _, family in modal_pairs} == set(expected_counts)
    assert {family: sum(mapped == family for _, mapped in modal_pairs) for family in expected_counts} == expected_counts

    # A family hook is intentionally structural: every existing modal keeps its
    # feature markup and handlers while receiving the same frame, scroll region
    # and narrow-screen geometry.
    for fragment in (
        '.modal[data-operator-modal-family] .modal-content {',
        '.modal[data-operator-modal-family] .modal-body {',
        '.modal[data-operator-modal-family="confirm-compact-form"] .modal-content {',
        '.modal[data-operator-modal-family="editor-workbench"] .modal-content {',
        '.modal[data-operator-modal-family="master-detail"] .modal-content {',
        '.modal[data-operator-modal-family="drawer-help"] .modal-content {',
        'body.panel-page .modal[data-operator-modal-family] {',
        'width: 100vw;',
        'height: 100dvh;',
    ):
        assert fragment in css


def test_stage5_editor_tasks_are_documented_as_closed():
    plan = PLAN.read_text(encoding="utf-8")
    contract = CONTRACT.read_text(encoding="utf-8")
    index = INDEX.read_text(encoding="utf-8")

    for fragment in (
        "### Этап 5. Редакторы и модальные семейства — в работе",
        "[x] создать единый editor modal contract для JSON, file editor и snapshot",
        "[x] заменить comments/schema pills на компактные status labels",
        "[x] применить четыре modal family ко всем 50 окнам в приоритетном порядке из аудита",
        "[x] убрать чисто презентационные inline max-width/gap/margin после переноса в scoped classes;",
        "[x] для пустых/error состояний использовать auto-height вместо искусственно высокого body;",
        "panel-operator-stage5-editor-workbench.md",
    ):
        assert fragment in plan

    for fragment in (
        "Статус: **семь связанных задач Этапа 5 закрыты 2–4 августа 2026 года**.",
        "## 1. Общий editor/workbench contract — закрыто",
        "## 2. Comments/schema status labels — закрыто",
        "## 3. Responsive editor help drawer/workbench — закрыто",
        "## 4. Fullscreen сложных модалов на mobile — закрыто",
        "## 5. Четыре modal family применены ко всем 50 окнам — закрыто",
        "## Сохранённые контракты",
        "## Проверка",
        "Критерий этих семи задач выполнен",
    ):
        assert fragment in contract

    assert "panel-operator-stage5-editor-workbench.md" in index


def test_stage5_editor_help_is_a_responsive_workbench_sidecar():
    css = CSS.read_text(encoding="utf-8")
    toolbar = (ROOT / "xkeen-ui/static/js/ui/editor_toolbar.js").read_text(encoding="utf-8")

    for fragment in (
        "Stage 5 — the dynamic CodeMirror help is a workbench sidecar",
        "--op-editor-help-drawer-width: min(420px, 30vw);",
        "body.panel-page.xk-editor-help-open .modal[data-operator-modal-family=\"editor-workbench\"]:not(.hidden)",
        "body.panel-page.xk-editor-help-open :is(#json-editor-modal, #fm-editor-modal, #xray-snapshot-modal):not(.hidden) .modal-content",
        "height: min(42dvh, 380px);",
        "transform: translateY(100%);",
        "body.panel-page .xkeen-cm-help-drawer {",
        "inset: 0;",
        "height: 100dvh;",
    ):
        assert fragment in css

    for fragment in (
        "drawer.dataset.operatorWorkbenchSidecar = 'editor-help';",
        "drawer.setAttribute('aria-hidden', 'true');",
        "document.body.classList.add('xk-editor-help-open');",
        "document.body.classList.remove('xk-editor-help-open');",
        "drawer._xkeenReturnFocus",
    ):
        assert fragment in toolbar


def test_stage5_modal_geometry_is_scoped_and_empty_or_error_restores_auto_height():
    template = TEMPLATE.read_text(encoding="utf-8")
    css = CSS.read_text(encoding="utf-8")
    plan = PLAN.read_text(encoding="utf-8")
    contract = CONTRACT.read_text(encoding="utf-8")

    assert not __import__("re").search(
        r'style="[^\"]*(?:max-width|gap|margin)', template, flags=__import__("re").I
    )

    for fragment in (
        "presentation geometry belongs to the scoped modal layer",
        ".xk-modal-width-980",
        ".xk-modal-max-width-420",
        ".xk-modal-gap-12",
        ".xk-modal-mb-12",
        ".xk-modal-ml-34",
        "A workbench fills the canvas only when it has working data.",
        '.modal:is(\n  [data-operator-modal-family="editor-workbench"],\n  [data-operator-modal-family="master-detail"]\n):has(:is(',
        ".empty-state:not(.hidden)",
        ".fm-empty:not(.hidden)",
        ".xk-pt-empty:not(.hidden)",
        ".xk-pool-empty:not(.hidden)",
        ".error:not(:empty):not(.hidden)",
        "height: auto;",
        "max-height: min(56dvh, 540px);",
        "max-height: min(38dvh, 320px);",
    ):
        assert fragment in css

    for fragment in (
        "Семь связанных задач закрыты 2–4 августа 2026 года",
        "[x] убрать чисто презентационные inline max-width/gap/margin после переноса в scoped classes;",
        "[x] для пустых/error состояний использовать auto-height вместо искусственно высокого body;",
        "## 6. Presentation geometry и empty/error auto-height — закрыто",
        "Пустые error placeholders, `.hidden`, `[hidden]` и `display:none` не активируют этот режим.",
        "Критерий этих семи задач выполнен",
    ):
        assert fragment in plan or fragment in contract
