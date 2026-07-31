from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PANEL_TEMPLATE = ROOT / "xkeen-ui/templates/panel.html"
OPERATOR_CSS = ROOT / "xkeen-ui/static/panel-operator.css"
INBOUNDS_JS = ROOT / "xkeen-ui/static/js/features/inbounds.js"
OUTBOUNDS_JS = ROOT / "xkeen-ui/static/js/features/outbounds.js"
COLLAPSE_JS = ROOT / "xkeen-ui/static/js/features/routing_cards/collapse.js"
LAZY_BINDINGS_JS = ROOT / "xkeen-ui/static/js/pages/panel.lazy_bindings.runtime.js"
DAT_CARD_JS = ROOT / "xkeen-ui/static/js/features/routing_cards/dat/card.js"
DAT_API_JS = ROOT / "xkeen-ui/static/js/features/routing_cards/dat/api.js"
PLAN_DOC = ROOT / "docs/panel-operator-redesign-completion-plan.md"
CONTRACT_DOC = ROOT / "docs/panel-operator-stage3-routing-cards.md"
DOCS_INDEX = ROOT / "docs/README.md"


ACCORDIONS = (
    ("inbounds-header", "inbounds-body"),
    ("routing-scenario-header", "routing-scenario-body"),
    ("outbounds-header", "outbounds-body"),
    ("routing-dat-header", "routing-dat-body"),
    ("routing-backups-header", "routing-backups-body"),
    ("routing-help-header", "routing-help-body"),
)


def test_stage3_routing_cards_expose_one_accordion_contract():
    template = PANEL_TEMPLATE.read_text(encoding="utf-8")
    collapse = COLLAPSE_JS.read_text(encoding="utf-8")
    lazy_bindings = LAZY_BINDINGS_JS.read_text(encoding="utf-8")
    inbounds = INBOUNDS_JS.read_text(encoding="utf-8")
    outbounds = OUTBOUNDS_JS.read_text(encoding="utf-8")

    for header_id, body_id in ACCORDIONS:
        assert template.count(f'id="{header_id}"') == 1
        assert template.count(f'id="{body_id}"') == 1
        header_at = template.index(f'id="{header_id}"')
        header_tag = template[template.rfind("<", 0, header_at) : template.find(">", header_at) + 1]
        assert 'role="button"' in header_tag
        assert 'tabindex="0"' in header_tag
        assert 'aria-expanded="false"' in header_tag
        assert f'aria-controls="{body_id}"' in header_tag

    assert collapse.count("keyName !== 'Enter' && keyName !== ' '") == 1
    assert "h.setAttribute('aria-expanded', open ? 'true' : 'false')" in collapse
    for source in (inbounds, outbounds):
        assert "key !== 'Enter' && key !== ' '" in source
        assert "setAttribute('aria-expanded', expanded ? 'true' : 'false')" in source
    assert "raw.closest('#inbounds-header')" in lazy_bindings
    assert "raw.closest('#outbounds-header')" in lazy_bindings
    assert lazy_bindings.count("reason: 'keyboard-interaction'") == 2
    assert "if (keyName !== 'Enter' && keyName !== ' ') return;" in lazy_bindings


def test_stage3_dat_and_outbound_rows_have_explicit_state_semantics():
    template = PANEL_TEMPLATE.read_text(encoding="utf-8")
    dat_card = DAT_CARD_JS.read_text(encoding="utf-8")
    dat_api = DAT_API_JS.read_text(encoding="utf-8")
    inbounds = INBOUNDS_JS.read_text(encoding="utf-8")
    outbounds = OUTBOUNDS_JS.read_text(encoding="utf-8")

    assert 'id="routing-dat-status" class="status" role="status" aria-live="polite" data-state="idle"' in template
    assert template.count('role="status" aria-live="polite"') >= 6
    assert "status.dataset.state = nextState" in dat_card
    assert "meta.dataset.state = nextState" in dat_card
    assert "status.dataset.state = nextState" in dat_api
    assert "control.setAttribute('aria-busy', active ? 'true' : 'false')" in dat_api
    assert "control.disabled = true" in dat_api
    assert "installed ? 'ok' : 'warning'" in dat_card
    assert "setInboundsStatus(statusEl" in inbounds
    assert "setOutboundsStatus(statusEl" in outbounds

    for fragment in (
        'class="xk-sub-node-meta xk-sub-node-protocol"',
        'class="xk-sub-node-endpoint-cell"',
        'class="xk-sub-node-health-cell"',
        'class="xk-sub-node-actions"',
    ):
        assert outbounds.count(fragment) == 2
    assert "const protocolSummary = [protocol, transport, security]" in outbounds
    assert "return raw;" in outbounds


def test_stage3_css_is_flat_dense_and_kept_inside_canonical_sections():
    css = OPERATOR_CSS.read_text(encoding="utf-8")
    workspaces = css[css.index("* 5. WORKSPACES") : css.index("* 6. MODALS")]
    responsive = css[css.index("* 8. RESPONSIVE") :]

    for fragment in (
        '.routing-side-card > .commands-header:is(:hover, :focus-visible, [aria-expanded="true"])',
        '.routing-side-card > [id$="-body"]',
        "background: var(--op-surface-2);",
        ".routing-dat-toolbar",
        ':is(.routing-dat-meta, #routing-dat-status)',
        ".routing-side-card--backups #backups-table",
        ".xk-sub-node-health-cell",
        "display: contents;",
        "minmax(90px, 1.25fr)",
        "minmax(72px, 0.85fr)",
        "minmax(88px, 1fr)",
    ):
        assert fragment in workspaces

    assert "border-radius: 0 !important;" in workspaces
    assert "background: transparent !important;" in workspaces
    assert "minmax(56px, 1.2fr)" in responsive
    assert "minmax(52px, 0.8fr)" in responsive
    assert "minmax(60px, 1fr)" in responsive
    assert "final fixes" not in responsive.lower()


def test_stage3_closure_is_reflected_in_documentation():
    template = PANEL_TEMPLATE.read_text(encoding="utf-8")
    plan = PLAN_DOC.read_text(encoding="utf-8")
    contract = CONTRACT_DOC.read_text(encoding="utf-8")
    index = DOCS_INDEX.read_text(encoding="utf-8")

    assert "filename='panel-operator.css', v='20260801a'" in template
    for fragment in (
        "Этапы 0–3 закрыты 28 июля 2026 года; Этап 4 в работе: задачи «Порты», «Routing rules» и «Balancers» закрыты 28 июля 2026 года",
        "### Этап 3. Пересобрать routing cards и operational blocks — закрыт",
        "Критерий завершения: **выполнен**",
        "panel-operator-stage3-routing-cards.md",
    ):
        assert fragment in plan

    for fragment in (
        "Статус: **Этап 3 закрыт 28 июля 2026 года**.",
        "## Accordion contract",
        "## GeoDAT и состояния операций",
        "## Строки proxy-узлов",
        "## Уплощение operational blocks",
        "## Автоматические проверки",
        "Критерий завершения выполнен",
    ):
        assert fragment in contract

    assert "panel-operator-stage3-routing-cards.md" in index
