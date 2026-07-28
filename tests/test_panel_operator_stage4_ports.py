from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PANEL_TEMPLATE = ROOT / "xkeen-ui/templates/panel.html"
OPERATOR_CSS = ROOT / "xkeen-ui/static/panel-operator.css"
PLAN_DOC = ROOT / "docs/panel-operator-redesign-completion-plan.md"
CONTRACT_DOC = ROOT / "docs/panel-operator-stage4-ports.md"
DOCS_INDEX = ROOT / "docs/README.md"


EDITOR_CONTRACT = (
    ("port-proxying-editor", "port-proxying-save-btn", "port-proxying-status"),
    ("port-exclude-editor", "port-exclude-save-btn", "port-exclude-status"),
    ("ip-exclude-editor", "ip-exclude-save-btn", "ip-exclude-status"),
    ("xkeen-config-editor", "xkeen-config-save-btn", "xkeen-config-status"),
)


def test_stage4_ports_preserve_runtime_hooks_in_compact_footers():
    template = PANEL_TEMPLATE.read_text(encoding="utf-8")
    view = template[template.index('id="view-xkeen"') : template.index('id="view-commands"')]

    assert view.count('class="xkeen-mini-footer"') == 4
    assert view.count('>Сохранить</button>') == 4
    assert view.count('role="status" aria-live="polite"') == 4
    assert view.count('xkeen-mini-editor--port-list') == 2
    assert view.count('xkeen-mini-editor--ip-list') == 1
    assert view.count('xkeen-mini-editor--policy') == 1

    for editor_id, button_id, status_id in EDITOR_CONTRACT:
        assert view.count(f'id="{editor_id}"') == 1
        assert view.count(f'id="{button_id}"') == 1
        assert view.count(f'id="{status_id}"') == 1
        footer_at = view.index('class="xkeen-mini-footer"', view.index(f'id="{editor_id}"'))
        next_card = view.find('class="xkeen-mini-editor ', footer_at)
        footer_slice = view[footer_at : next_card if next_card != -1 else len(view)]
        assert f'id="{button_id}"' in footer_slice
        assert f'id="{status_id}"' in footer_slice


def test_stage4_ports_override_legacy_fixed_geometry_in_workspace_section():
    css = OPERATOR_CSS.read_text(encoding="utf-8")
    workspaces = css[css.index("* 5. WORKSPACES") : css.index("* 6. MODALS")]
    ports = workspaces[
        workspaces.index("/* Ports and exclusions") : workspaces.index("/* Commands:")
    ]

    for fragment in (
        "align-items: start;",
        "height: auto !important;",
        "min-height: 0 !important;",
        "--xk-mini-editor-min: 156px;",
        "--xk-mini-editor-max: 220px;",
        "--xk-mini-editor-min: 168px;",
        "--xk-mini-editor-max: 240px;",
        "--xk-mini-editor-min: 220px;",
        "--xk-mini-editor-max: 320px;",
        ".xkeen-mini-footer",
        "border-top: 1px solid var(--op-border);",
        "flex: 0 0 auto;",
    ):
        assert fragment in ports

    assert "height: clamp(360px, 42vh, 520px)" not in ports
    assert "margin-top: auto" not in ports
    assert "final fixes" not in css[css.index("* 8. RESPONSIVE") :].lower()


def test_stage4_ports_closure_is_reflected_in_documentation():
    template = PANEL_TEMPLATE.read_text(encoding="utf-8")
    plan = PLAN_DOC.read_text(encoding="utf-8")
    contract = CONTRACT_DOC.read_text(encoding="utf-8")
    index = DOCS_INDEX.read_text(encoding="utf-8")

    assert "filename='panel-operator.css', v='20260728l'" in template
    for fragment in (
        "Этап 4 в работе: задачи «Порты», «Routing rules» и «Balancers» закрыты 28 июля 2026 года",
        "### Этап 4. Формы, таблицы и data-heavy экраны — в работе",
        "[x] **Порты:**",
        "panel-operator-stage4-ports.md",
    ):
        assert fragment in plan

    for fragment in (
        "Статус: **задача «Порты» Этапа 4 закрыта 28 июля 2026 года**.",
        "## Геометрия редакторов",
        "## Footer row",
        "## Сохранённые контракты",
        "## Автоматические проверки",
        "Критерий задачи выполнен",
    ):
        assert fragment in contract

    assert "Этап 4 в работе: задачи «Порты», «Routing rules» и «Balancers» закрыты" in index
    assert "panel-operator-stage4-ports.md" in index
