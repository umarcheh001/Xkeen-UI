from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "xkeen-ui/templates/panel.html"
CSS = ROOT / "xkeen-ui/static/panel-operator.css"
SCRIPT = ROOT / "xkeen-ui/static/js/features/commands_list.js"
PLAN = ROOT / "docs/panel-operator-redesign-completion-plan.md"
DOC = ROOT / "docs/panel-operator-stage4-commands.md"
INDEX = ROOT / "docs/README.md"


def test_commands_rows_keep_runtime_hooks_and_expose_string_action_model():
    text = TEMPLATE.read_text(encoding="utf-8")
    view = text[text.index('id="view-commands"') : text.index('<!-- Restart log -->')]
    # The catalog is rendered by a Jinja loop; the template therefore keeps
    # one canonical row source plus the seven explicit panel utility rows.
    assert view.count('class="command-item"') == 8
    assert view.count('data-action="run"') == 8
    assert view.count('data-command="') == 8
    assert view.count('class="command-item-prefix"') == 8
    assert view.count('class="command-item-desc"') == 8
    assert view.count('class="command-item-action">Выполнить</span>') == 8


def test_commands_operator_layer_is_a_compact_multi_column_row_flow():
    css = CSS.read_text(encoding="utf-8")
    stage = css[css.index("/* Commands: compact multi-column data rows") : css.index("/* Logs are terminal-like")]
    for fragment in (
        "column-count: 3;",
        "display: block;",
        "grid-template-columns: minmax(112px, 0.4fr) minmax(0, 1fr) auto;",
        "display: none !important;",
        "border-bottom: 1px solid var(--op-border) !important;",
        ".command-item-action",
        "var(--op-data-muted)",
    ):
        assert fragment in stage
    assert "column-count: 1;" in CSS.read_text(encoding="utf-8")
    for legacy in ("border-radius: 999", "linear-gradient(", "transform: translate"):
        assert legacy not in stage


def test_commands_runtime_uses_data_command_and_restores_busy_state():
    script = SCRIPT.read_text(encoding="utf-8")
    for fragment in (
        "el.getAttribute('data-command')",
        "const action = el.getAttribute('data-action') || 'run';",
        "el.setAttribute('aria-busy', 'true');",
        "el.classList.add('loading');",
        "finally {",
        "el.removeAttribute('aria-busy');",
    ):
        assert fragment in script


def test_commands_closure_is_documented():
    plan = PLAN.read_text(encoding="utf-8")
    doc = DOC.read_text(encoding="utf-8")
    index = INDEX.read_text(encoding="utf-8")
    assert "задача «Commands» закрыта 29 июля 2026 года" in plan
    assert "[x] **Commands:**" in plan
    assert "panel-operator-stage4-commands.md" in plan
    assert "Статус: **задача «Commands» Этапа 4 закрыта 29 июля 2026 года**." in doc
    assert "## Action contract" in doc
    assert "## Автоматические проверки" in doc
    assert "panel-operator-stage4-commands.md" in index
