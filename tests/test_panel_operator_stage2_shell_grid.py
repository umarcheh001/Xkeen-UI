from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PANEL_TEMPLATE = ROOT / "xkeen-ui/templates/panel.html"
OPERATOR_CSS = ROOT / "xkeen-ui/static/panel-operator.css"
PLAN_DOC = ROOT / "docs/panel-operator-redesign-completion-plan.md"
CONTRACT_DOC = ROOT / "docs/panel-operator-stage2-shell-grid.md"
DOCS_INDEX = ROOT / "docs/README.md"


def test_stage2_header_has_two_zones_without_replacing_runtime_nodes():
    template = PANEL_TEMPLATE.read_text(encoding="utf-8")

    assert template.count('data-xk-shell-zone=') == 2
    assert 'data-xk-shell-zone="identity"' in template
    assert 'data-xk-shell-zone="global-actions"' in template
    assert 'class="top-tabs header-tabs" role="navigation" aria-label="Разделы панели"' in template
    assert "filename='panel-operator.css', v='20260810d'" in template

    identity_start = template.index('class="panel-shell-identity"')
    actions_start = template.index('data-xk-shell-zone="global-actions"')
    identity = template[identity_start:actions_start]
    for runtime_id in (
        "xk-brand-title",
        "xkeen-service-lamp",
        "xkeen-service-text",
        "xkeen-core-text",
        "xray-logs-badge",
    ):
        assert identity.count(f'id="{runtime_id}"') == 1

    for preserved_id in (
        "theme-toggle-btn",
        "ui-settings-open-btn",
        "last-load",
        "xkeen-start-btn",
        "xkeen-stop-btn",
        "xkeen-restart-btn",
        "global-autorestart-xkeen",
    ):
        assert template.count(f'id="{preserved_id}"') == 1


def test_stage2_shell_and_grid_rules_live_in_canonical_sections():
    css = OPERATOR_CSS.read_text(encoding="utf-8")
    shell = css[css.index("* 3. SHELL"):css.index("* 4. PRIMITIVES")]
    workspaces = css[css.index("* 5. WORKSPACES"):css.index("* 6. MODALS")]
    responsive = css[css.index("* 8. RESPONSIVE"):]

    for fragment in (
        ".panel-shell-identity",
        "grid-template-columns: minmax(0, 1fr) auto;",
        "min-height: 50px;",
        "min-height: 36px;",
        ".top-tab-btn:focus-visible",
        "min-height: 38px;",
        "color: currentColor;",
    ):
        assert fragment in shell

    for fragment in (
        "grid-template-columns: minmax(0, 1fr) clamp(380px, 21vw, 500px) !important;",
        'grid-template-areas: "routing-center routing-side" !important;',
        "min-height: 0;",
        'html[data-xk-container="fixed"] body.panel-page .layout-2col.routing-layout',
        'html[data-xk-container="fixed"] body.panel-page .routing-side-grid',
    ):
        assert fragment in workspaces

    assert "@media (max-width: 1180px)" in responsive
    assert '"routing-center"\n      "routing-side" !important;' in responsive
    assert "@media (max-width: 720px)" in responsive
    assert "grid-template-columns: minmax(0, 1fr);" in responsive
    assert "final fixes" not in responsive.lower()


def test_stage2_container_width_respects_layout_preferences():
    css = OPERATOR_CSS.read_text(encoding="utf-8")

    container = css[
        css.index("body.panel-page .container-wide {") :
        css.index("body.panel-page .container-wide::before")
    ]
    assert "max-width: var(--xk-container-max-width, 100%) !important;" in container
    assert "max-width: none !important;" not in container


def test_stage2_command_row_overrides_coloured_legacy_theme_buttons():
    css = OPERATOR_CSS.read_text(encoding="utf-8")
    shell = css[css.index("* 3. SHELL"):css.index("* 4. PRIMITIVES")]

    for fragment in (
        'html:is([data-theme="dark"], [data-theme="light"]) body.panel-page .xkeen-ctrl-btn.xkeen-ctrl-btn-start',
        'html:is([data-theme="dark"], [data-theme="light"]) body.panel-page .xkeen-ctrl-btn.xkeen-ctrl-btn-stop',
        'html:is([data-theme="dark"], [data-theme="light"]) body.panel-page .xkeen-ctrl-btn.xkeen-ctrl-btn-restart',
        'html:is([data-theme="dark"], [data-theme="light"]) body.panel-page .routing-focus-btn.routing-focus-btn-gui',
        'html:is([data-theme="dark"], [data-theme="light"]) body.panel-page .routing-focus-btn.routing-focus-btn-raw',
        "content: none !important;",
        "background: var(--op-surface) !important;",
        "background: transparent !important;",
        "background: var(--op-accent-soft) !important;",
        "box-shadow: none !important;",
    ):
        assert fragment in shell


def test_stage2_closure_is_reflected_in_documentation():
    plan = PLAN_DOC.read_text(encoding="utf-8")
    contract = CONTRACT_DOC.read_text(encoding="utf-8")
    index = DOCS_INDEX.read_text(encoding="utf-8")

    for fragment in (
        "Этапы 0–3 закрыты 28 июля 2026 года; Этап 4 в работе: задачи «Порты», «Routing rules» и «Balancers» закрыты 28 июля 2026 года",
        "### Этап 2. Шапка, навигация и рабочая сетка — закрыт",
        "Критерий завершения: **выполнен**",
        "panel-operator-stage2-shell-grid.md",
    ):
        assert fragment in plan

    for fragment in (
        "Статус: **Этап 2 закрыт 28 июля 2026 года**.",
        "## Шапка и иерархия действий",
        "## Navigation rail",
        "## Рабочая сетка",
        "## Сохранённые контракты",
        "## Автоматические проверки",
        "Критерий завершения выполнен",
    ):
        assert fragment in contract

    assert "panel-operator-stage2-shell-grid.md" in index
