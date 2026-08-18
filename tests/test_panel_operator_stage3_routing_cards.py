from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PANEL_TEMPLATE = ROOT / "xkeen-ui/templates/panel.html"
OPERATOR_CSS = ROOT / "xkeen-ui/static/panel-operator.css"
INBOUNDS_JS = ROOT / "xkeen-ui/static/js/features/inbounds.js"
OUTBOUNDS_JS = ROOT / "xkeen-ui/static/js/features/outbounds.js"
BACKUPS_JS = ROOT / "xkeen-ui/static/js/features/backups.js"
COLLAPSE_JS = ROOT / "xkeen-ui/static/js/features/routing_cards/collapse.js"
LAZY_BINDINGS_JS = ROOT / "xkeen-ui/static/js/pages/panel.lazy_bindings.runtime.js"
DAT_CARD_JS = ROOT / "xkeen-ui/static/js/features/routing_cards/dat/card.js"
DAT_API_JS = ROOT / "xkeen-ui/static/js/features/routing_cards/dat/api.js"
TOOLTIPS_JS = ROOT / "xkeen-ui/static/js/ui/tooltips_auto.js"
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


def test_inbounds_mode_copy_uses_hybrid_label_and_compact_actions():
    template = PANEL_TEMPLATE.read_text(encoding="utf-8")
    inbounds = INBOUNDS_JS.read_text(encoding="utf-8")
    css = OPERATOR_CSS.read_text(encoding="utf-8")

    assert 'name="inbounds_mode" value="mixed"' in template
    for fragment in (
        '<strong>Hybrid</strong>',
        'UDP через TProxy, TCP через Redirect</small>',
        'TCP+UDP через TProxy</small>',
        'Только TCP \u0447\u0435\u0440\u0435\u0437 Redirect</small>',
        '<span class="xk-action-label">Правка</span>',
        '<span class="xk-action-label">Сохр.</span>',
        '<span class="xk-action-label">Бэкап</span>',
        '<span class="xk-action-label">Восст.</span>',
    ):
        assert fragment in template
    assert "return value === 'mixed' ? 'Hybrid' : value;" in inbounds
    assert ".routing-side-card--inbounds .xk-actions-inline > button:has(.xk-action-label)" in css

    for fragment in (
        'class="actions xk-actions-inline outbounds-actions"',
        '<span class="xk-action-label">Правка</span>',
        '<span class="xk-action-label">Подписки</span>',
        '<span class="xk-action-label">Бэкап</span>',
        '<span class="xk-action-label">Восст.</span>',
    ):
        assert fragment in template
    assert ".routing-side-card--outbounds .outbounds-actions .xk-action-label" in css
    assert "grid-template-columns: repeat(4, minmax(0, 1fr));" in css
    for fragment in (
        ".routing-side-card--outbounds #outbounds-body .outbounds-hints",
        "grid-template-columns: repeat(3, minmax(0, 1fr)) var(--op-control-h);",
        ".routing-side-card--outbounds #outbounds-body .outbounds-help-trigger",
        ".routing-side-card--outbounds .outbounds-tag-trigger",
        ".routing-side-card--outbounds #outbounds-entware-mark-btn.xk-entware-mark-toggle",
    ):
        assert fragment in css
    assert '>Tag</summary>' in template

    assert 'class="routing-scenario-options"' in template
    assert 'class="actions xk-actions-inline routing-scenario-actions"' in template
    assert '<span class="xk-action-label">Применить</span>' in template
    assert ".routing-side-card--scenario #routing-scenario-badge" in css
    assert ".routing-side-card--scenario .routing-scenario-help-popover > .xk-card-help-trigger" in css
    assert "padding: 0 !important;" in css
    assert "border: 1px solid var(--op-border) !important;" in css


def test_backups_card_keeps_full_history_in_the_operator_panel():
    template = PANEL_TEMPLATE.read_text(encoding="utf-8")
    css = OPERATOR_CSS.read_text(encoding="utf-8")
    backups = BACKUPS_JS.read_text(encoding="utf-8")

    for fragment in (
        'Все точки возврата Xray в одном месте.',
        'GUI и RAW:',
        'Автоприменение правок маршрутизации',
        'id="backups-mode-snapshots-btn"',
        'id="backups-mode-history-btn"',
        'id="backups-refresh-btn"',
        '<span class="xk-action-label">Очистить</span>',
    ):
        assert fragment in template
    assert 'href="/backups"' not in template

    for fragment in (
        "import '../ui/operator_icons.js';",
        'function setBackupMode(mode)',
        'table.dataset.mode = nextMode;',
        "operatorIcon('preview')",
        "operatorIcon('restore')",
        "operatorIcon('trash')",
        'function loadHistory()',
    ):
        assert fragment in backups

    for fragment in (
        '.routing-side-card--backups .xk-backups-mode-tabs',
        '.routing-side-card--backups .xk-backups-toolbar',
        '.xk-backups-mode-tab.is-active',
        '#backups-table thead',
        '.xk-card-help-row--corner .xk-card-help-trigger',
        '.routing-side-card--help .xk-card-help-row--corner .xk-card-help-trigger',
        'button.backup-icon-btn',
        '.backup-action-icon',
    ):
        assert fragment in css


def test_stage3_dat_and_outbound_rows_have_explicit_state_semantics():
    template = PANEL_TEMPLATE.read_text(encoding="utf-8")
    dat_card = DAT_CARD_JS.read_text(encoding="utf-8")
    dat_api = DAT_API_JS.read_text(encoding="utf-8")
    inbounds = INBOUNDS_JS.read_text(encoding="utf-8")
    outbounds = OUTBOUNDS_JS.read_text(encoding="utf-8")
    styles = OPERATOR_CSS.read_text(encoding="utf-8")

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
    ):
        assert outbounds.count(fragment) == 2
    # The main Xray card now uses the latency value itself as the probe action,
    # while the subscription editor keeps an actions slot for exclusion.
    assert outbounds.count('class="xk-sub-node-actions"') == 1
    assert 'class="xk-xray-node-probe xk-sub-node-latency xk-sub-node-ping' in outbounds
    assert '[data-probe-tone="good"] { color: var(--op-success) !important; }' in styles
    assert '[data-probe-tone="warning"] { color: var(--op-warning) !important; }' in styles
    assert '[data-probe-tone="bad"] { color: var(--op-danger) !important; }' in styles
    assert '[data-probe-tone="stale"] {' in styles
    assert "if (xrayDelayEntryIsStale(entry)) return 'is-stale';" in outbounds
    assert 'const XRAY_DELAY_FRESHNESS_TTL_MS = 5 * 60 * 1000;' in outbounds
    assert 'scheduleXrayDelayFreshnessRender();' in outbounds
    assert "tone === 'idle' ? 'bolt'" in outbounds
    assert 'data-xray-delay-history="1"' in outbounds
    assert 'className = \'xk-xray-delay-history-popover\'' in outbounds
    assert '.xk-xray-delay-history-row' in styles
    assert 'Задержка не измерена. Нажмите, чтобы проверить.' in outbounds
    assert 'История:\\n' not in outbounds
    assert "const protocolSummary = [protocol, transport, security]" in outbounds
    assert 'class="xk-sub-node-meta xk-sub-node-protocol" aria-label="Технические параметры">' in outbounds
    assert 'class="xk-sub-node-endpoint-cell" aria-label="Endpoint">' in outbounds
    assert 'data-tooltip="${protocolSummary}"' not in outbounds
    assert 'data-tooltip="${connectionSummaryHtml}"' not in outbounds
    assert 'deprecatedTransportNote ? `data-tooltip=' not in outbounds
    assert "return info ? (stripLeadingFlagTokens(raw) || raw) : raw;" in outbounds


def test_dat_file_picker_uses_its_listbox_contract_without_an_overlapping_tooltip():
    template = PANEL_TEMPLATE.read_text(encoding="utf-8")
    combo = (ROOT / "xkeen-ui/static/js/features/routing_cards/dat/combo.js").read_text(encoding="utf-8")
    tooltips = TOOLTIPS_JS.read_text(encoding="utf-8")

    for kind in ("geosite", "geoip"):
        assert f'id="routing-dat-{kind}-found" class="routing-dat-found" role="listbox"' in template
        assert f'id="routing-dat-{kind}-browse"' in template
        assert f'aria-controls="routing-dat-{kind}-found"' in template
    assert 'data-tooltip="Найденные DAT в папке.' not in template
    assert "trigger.setAttribute('aria-expanded', open ? 'true' : 'false')" in combo
    assert "host.getAttribute('aria-haspopup') === 'listbox'" in tooltips
    assert "el.getAttribute('aria-haspopup') === 'listbox'" in tooltips
    assert '.routing-dat-item.is-dat-picker-open > .routing-dat-found' in OPERATOR_CSS.read_text(encoding="utf-8")


def test_stage3_css_is_flat_dense_and_kept_inside_canonical_sections():
    css = OPERATOR_CSS.read_text(encoding="utf-8")
    workspaces = css[css.index("* 5. WORKSPACES") : css.index("* 6. MODALS")]
    responsive = css[css.index("* 8. RESPONSIVE") :]

    for fragment in (
        '.routing-side-card > .commands-header:is(:hover, :focus-visible, [aria-expanded="true"])',
        '.routing-side-card > [id$="-body"]',
        "background: var(--op-surface-2);",
        ".routing-dat-toolbar",
        ".routing-dat-fields-row",
        ".routing-dat-help-popover",
        "position: static !important;",
        "z-index: 60;",
        ".routing-dat-item.is-dat-picker-open > .routing-dat-found",
        ".routing-dat-actions-inline",
        "grid-template-columns: repeat(4, minmax(0, 1fr));",
        ':is(.routing-dat-meta, #routing-dat-status)',
        ".routing-side-card--backups #backups-table",
        ".xk-sub-node-health-cell",
        ".routing-side-card--outbounds .xk-outbounds-node-list",
        "grid-template-columns: repeat(auto-fill, minmax(232px, 1fr));",
        "grid-template-columns: minmax(0, 1fr) auto;",
        "grid-template-rows: auto auto;",
    ):
        assert fragment in workspaces

    assert "border-radius: 0 !important;" in workspaces
    assert "background: transparent !important;" in workspaces
    assert ".routing-side-card--outbounds .xk-outbounds-node-list" in responsive
    assert "grid-template-columns: minmax(0, 1fr);" in responsive
    assert ".routing-side-card--outbounds .xk-outbounds-node-item" in responsive
    assert "body.panel-page .routing-dat-fields-row" in responsive
    assert "body.panel-page .routing-dat-actions-inline" in responsive
    assert "final fixes" not in responsive.lower()


def test_stage3_closure_is_reflected_in_documentation():
    template = PANEL_TEMPLATE.read_text(encoding="utf-8")
    plan = PLAN_DOC.read_text(encoding="utf-8")
    contract = CONTRACT_DOC.read_text(encoding="utf-8")
    index = DOCS_INDEX.read_text(encoding="utf-8")

    assert "filename='panel-operator.css', v='20260817c'" in template
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
