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

    for fragment in (
        "body.panel-page #json-editor-modal .xk-editor-status-label {",
        "border-left: 2px solid var(--op-border) !important;",
        "border-radius: 0 !important;",
        "body.panel-page #json-editor-modal .xk-editor-status-label::before {",
        "content: none !important;",
        ".xk-editor-status-label.xk-comments-on",
        ".xk-editor-status-label.xk-schema-on",
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
        "panel-operator-stage5-editor-workbench.md",
    ):
        assert fragment in plan

    for fragment in (
        "Статус: **четыре связанные задачи Этапа 5 закрыты 2 и 3 августа 2026 года**.",
        "## 1. Общий editor/workbench contract — закрыто",
        "## 2. Comments/schema status labels — закрыто",
        "## 3. Responsive editor help drawer/workbench — закрыто",
        "## 4. Fullscreen сложных модалов на mobile — закрыто",
        "## Сохранённые контракты",
        "## Проверка",
        "Критерий этих четырёх задач выполнен",
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
