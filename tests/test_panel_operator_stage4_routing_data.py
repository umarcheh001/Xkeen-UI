from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CSS_PATH = ROOT / "xkeen-ui/static/panel-operator.css"
TEMPLATE_PATH = ROOT / "xkeen-ui/templates/panel.html"
RENDER_PATH = ROOT / "xkeen-ui/static/js/features/routing_cards/rules/render.js"
DND_PATH = ROOT / "xkeen-ui/static/js/features/routing_cards/rules/dnd_pointer.js"
MODEL_PATH = ROOT / "xkeen-ui/static/js/features/routing_cards/rules/model.js"
JSON_MODAL_PATH = ROOT / "xkeen-ui/static/js/features/routing_cards/rules/json_modal.js"
PLAN_PATH = ROOT / "docs/panel-operator-redesign-completion-plan.md"
RULES_DOC_PATH = ROOT / "docs/panel-operator-stage4-routing-rules.md"
BALANCERS_DOC_PATH = ROOT / "docs/panel-operator-stage4-balancers.md"
DOCS_INDEX_PATH = ROOT / "docs/README.md"


def test_stage4_routing_rules_use_one_record_list_and_neutral_editor_flow():
    css = CSS_PATH.read_text(encoding="utf-8")
    start = css.index("/* Stage 4 routing rules:")
    end = css.index("body.panel-page .command-group {", start)
    stage4 = css[start:end]

    for fragment in (
        "body.panel-page .routing-rule-grid {",
        "display: block;",
        "body.panel-page .routing-rule-card {",
        "border-left: 2px solid var(--routing-record-tone) !important;",
        "body.panel-page .routing-rule-main {",
        "grid-template-columns: minmax(220px, 1.15fr) minmax(76px, max-content) minmax(180px, 1fr);",
        "body.panel-page .routing-rule-card.is-disabled {",
        "body.panel-page .routing-rule-card.is-target-block {",
        "body.panel-page .routing-rule-card:is(.is-target-balancer, .is-target-direct) {",
        "body.panel-page .routing-rule-card.is-pointer-ghost {",
        "body.panel-page .routing-rule-card.is-pointer-ghost * {",
        ":is(#routing-rules-body, .routing-rule-card.is-pointer-ghost)",
        "body.panel-page #routing-rules-body .routing-rule-placeholder {",
        ".routing-rule-field[data-field-key]",
        ".routing-chip",
        ".routing-selector-chipfield:focus-within",
        "body.panel-page #routing-rules-body .routing-balancer-form > .routing-rule-field {",
        "grid-template-columns: minmax(112px, 132px) minmax(0, 1fr);",
        ".routing-chip-remove,",
        ".routing-selector-chip-x,",
        ".routing-rule-remove-field",
        "border-radius: 50% !important;",
        "body.panel-page #routing-rules-body .routing-balancer-actions .routing-balancer-del-btn {",
        "body.panel-page #routing-rules-apply-btn {",
        "width: var(--op-control-h) !important;",
        "color: var(--op-data-muted) !important;",
    ):
        assert fragment in stage4

    for legacy_artifact in (
        "#020617",
        "#3b82f6",
        "rgba(37, 99, 235",
        "border-radius: 999",
        "linear-gradient(",
    ):
        assert legacy_artifact not in stage4


def test_stage4_rule_runtime_states_and_actions_are_preserved():
    source = RENDER_PATH.read_text(encoding="utf-8")
    dnd_source = DND_PATH.read_text(encoding="utf-8")

    for fragment in (
        "routing-rule-card routing-rule-record",
        "routing-rule-card routing-rule-record is-disabled",
        "card.dataset.open = isOpen ? '1' : '0';",
        "applyRuleTargetTone(card, sum);",
        "el.dataset.targetKind = String(sum && sum.targetKind ? sum.targetKind : '');",
        "card.draggable = !supportsPointerDnD();",
        "S._openSet.has(rule)",
        "routing-rule-toggle",
        "routing-rule-comment-btn",
        "setIcon(toggleBtn, isOpen ? 'chevron-down' : 'more');",
    ):
        assert fragment in source

    assert "setIcon(upBtn, 'move-up')" not in source
    assert "setIcon(downBtn, 'move-down')" not in source

    for fragment in (
        "listEl.addEventListener('pointerdown', onPointerDown);",
        "listEl.addEventListener('dragstart', onDragStart);",
        "listEl.addEventListener('dragover', onDragOver);",
        "listEl.addEventListener('drop', onDrop);",
    ):
        assert fragment in dnd_source


def test_stage4_balancers_use_summary_disclosure_and_compact_selector():
    source = RENDER_PATH.read_text(encoding="utf-8")
    json_modal = JSON_MODAL_PATH.read_text(encoding="utf-8")

    for fragment in (
        "routing-balancer-card routing-balancer-record",
        "const isOpen = !!(S._balOpenSet && S._balOpenSet.has(b));",
        "toggleBtn.textContent = isOpen ? 'Свернуть' : 'Редактировать';",
        "toggleBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');",
        "toggleBtn.setAttribute('aria-controls', `routing-balancer-editor-${idx}`);",
        "if (isOpen) {",
        "routing-balancer-summary-item",
        "const compactChipLimit = 4;",
        "sel.slice(0, compactChipLimit)",
        "more.textContent = chipsExpanded ? 'Свернуть' : `Ещё ${sel.length - compactChipLimit}`;",
        "routing-balancer-editor-note",
    ):
        assert fragment in source

    assert "if (S._balOpenSet) S._balOpenSet.add(obj);" in json_modal


def test_stage4_routing_section_has_one_primary_apply_action():
    template = TEMPLATE_PATH.read_text(encoding="utf-8")
    model = MODEL_PATH.read_text(encoding="utf-8")
    rules_start = template.index('id="routing-rules-card"')
    rules_end = template.index('<!-- Сворачиваемый блок routing -->', rules_start)
    rules_markup = template[rules_start:rules_end]

    assert "filename='panel-operator.css', v='20260903dns80'" in template
    assert 'id="routing-rules-apply-btn" class="btn-primary btn-icon routing-rules-apply-primary"' in rules_markup
    assert rules_markup.count("btn-primary") == 1
    assert "op_icon('save')" in rules_markup
    assert "btn.classList && btn.classList.contains('btn-icon')" in model
    assert "btn.classList.toggle('is-dirty', dirty);" in model


def test_stage4_routing_data_closure_is_documented():
    plan = PLAN_PATH.read_text(encoding="utf-8")
    rules_doc = RULES_DOC_PATH.read_text(encoding="utf-8")
    balancers_doc = BALANCERS_DOC_PATH.read_text(encoding="utf-8")
    index = DOCS_INDEX_PATH.read_text(encoding="utf-8")

    for fragment in (
        "задачи «Порты», «Routing rules» и «Balancers» закрыты",
        "- [x] **Routing rules:**",
        "- [x] **Balancers:**",
        "panel-operator-stage4-routing-rules.md",
        "panel-operator-stage4-balancers.md",
    ):
        assert fragment in plan

    for doc, status in (
        (rules_doc, "задача «Routing rules» Этапа 4 закрыта"),
        (balancers_doc, "задача «Balancers» Этапа 4 закрыта"),
    ):
        assert status in doc
        assert "## Автоматические проверки" in doc
        assert "panel_operator_stage4_routing_data.spec.mjs" in doc

    assert "panel-operator-stage4-routing-rules.md" in index
    assert "panel-operator-stage4-balancers.md" in index
