from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PANEL = ROOT / "xkeen-ui/templates/panel.html"
GENERATOR = ROOT / "xkeen-ui/templates/mihomo_generator.html"
CSS = ROOT / "xkeen-ui/static/panel-operator.css"
MIHOMO_JS = ROOT / "xkeen-ui/static/js/features/mihomo_panel.js"
SUBSCRIPTIONS_JS = ROOT / "xkeen-ui/static/js/features/outbounds.js"
PLAN = ROOT / "docs/panel-operator-redesign-completion-plan.md"
DOC = ROOT / "docs/panel-operator-stage4-mihomo-forms.md"
INDEX = ROOT / "docs/README.md"


def test_mihomo_generator_reuses_late_scoped_operator_layer():
    template = GENERATOR.read_text(encoding="utf-8")
    panel_template = PANEL.read_text(encoding="utf-8")
    assert '<body class="panel-page mihomo-generator-page">' in template
    assert "filename='panel-operator.css', v='20260811h'" in template
    assert "filename='panel-operator.css', v='20260816a'" in panel_template
    assert template.index("filename='panel-operator.css'") > template.index("</style>")
    for fragment in ('class="generator-field-card xk-op-field"', 'class="xk-op-field-label" for="profileSelect"', 'class="generator-action-row xk-op-action-row"', 'class="hint xk-card-desc xk-op-field-hint"'):
        assert fragment in template


def test_profiles_markup_and_runtime_expose_form_table_validation_contract():
    panel = PANEL.read_text(encoding="utf-8")
    runtime = MIHOMO_JS.read_text(encoding="utf-8")
    for fragment in ('aria-label="Профили Mihomo"', 'aria-label="Бэкапы Mihomo"', 'id="mihomo-profile-create-form"', 'class="xk-mihomo-profile-field"', 'aria-describedby="mihomo-new-profile-name-hint mihomo-new-profile-name-error"', 'id="mihomo-new-profile-name-error"', 'role="alert" hidden', 'Без расширения <code>.yaml</code>.'):
        assert fragment in panel
    for fragment in ("profileCreateForm.addEventListener('submit'", "nameInput.setAttribute('aria-invalid'", "profileNameInput.addEventListener('input'", "nameError.hidden = !!name"):
        assert fragment in runtime


def test_subscription_form_aligns_labels_hints_validation_units_and_disclosure():
    runtime = SUBSCRIPTIONS_JS.read_text(encoding="utf-8")
    for fragment in ('class="xk-sub-advanced xk-sub-wide"', '<summary>', 'class="xk-sub-advanced-heading"', 'Дополнительные настройки</span>', 'class="xk-sub-advanced-grid"', 'id="outbounds-subscriptions-interval-unit" class="xk-op-unit">ч</span>', 'required aria-required="true" aria-describedby="outbounds-subscriptions-url-note"', 'aria-describedby="outbounds-subscriptions-name-filter-note"', 'aria-describedby="outbounds-subscriptions-type-filter-note"', 'aria-describedby="outbounds-subscriptions-transport-filter-note"', 'class="xk-sub-field-hint">Regex; пусто — все имена.', "el.setAttribute('aria-invalid', invalid ? 'true' : 'false')", "setAttribute('role', invalid ? 'alert' : 'status')"):
        assert fragment in runtime


def test_operator_layer_flattens_mihomo_tables_forms_and_actions():
    css = CSS.read_text(encoding="utf-8")
    stage = css[css.index("/* Stage 4 Mihomo profiles/generator"):css.index("/* ==========================================================================\n * 6. MODALS")]
    for fragment in (".xk-mihomo-vault-table", ".xk-mihomo-profile-create", ".xk-mihomo-mini-btn", ".mihomo-generator-page .subscription-row", ".mihomo-generator-page .proxy-card", ".xk-sub-advanced-grid", ".xk-sub-interval-inline", "border-radius: var(--op-control-radius) !important;", "background-image: none !important;"):
        assert fragment in stage
    assert "linear-gradient(" not in stage
    assert "translateY(" not in stage


def test_profile_actions_and_create_row_keep_the_compact_layout_aligned():
    css = CSS.read_text(encoding="utf-8")
    assert '.xk-mihomo-vault-table--profiles .xk-mihomo-row-actions {' in css
    assert 'grid-template-columns: repeat(3, var(--op-control-compact-h));' in css
    assert '.xk-mihomo-mini-btn[data-action="activate"] {' in css
    assert 'border-radius: 0 !important;' in css
    assert '.xk-mihomo-profile-control-row {' in css
    assert 'margin: 0 !important;' in css
    assert 'body.panel-page .xk-mihomo-profile-input {' in css
    assert 'body.panel-page .xk-mihomo-backups-clean-input {' in css
    assert 'margin: 0 !important;' in css


def test_profiles_and_backups_use_icon_only_actions_without_decorative_heading_icon():
    panel = PANEL.read_text(encoding="utf-8")
    runtime = MIHOMO_JS.read_text(encoding="utf-8")
    heading = panel.split('id="mihomo-profiles-link"', 1)[1].split('</div>', 1)[0]

    assert '<h3>Профили и бэкапы Mihomo</h3>' in heading
    assert "op_icon('archive')" not in heading
    assert 'id="mihomo-refresh-profiles-btn" class="btn-secondary btn-icon' in panel
    assert 'aria-label="Обновить профили"' in panel
    assert 'id="mihomo-refresh-backups-btn" class="btn-secondary btn-icon' in panel
    assert 'aria-label="Обновить бэкапы"' in panel
    assert 'id="mihomo-save-profile-btn"' in panel
    assert 'class="btn-secondary btn-icon xk-mihomo-profile-save-btn"' in panel
    assert "buildMihomoMiniButton('activate', activateLabel, {" in runtime
    assert "tone: isActive ? 'ok' : 'primary',\n              iconOnly: true," in runtime


def test_visual_correction_removes_blue_glass_and_fixed_modal_canvases():
    css = CSS.read_text(encoding="utf-8")
    for fragment in (
        "body.panel-page.mihomo-generator-page .generator-layout",
        "height: calc(100dvh - 104px) !important;",
        "body.panel-page.mihomo-generator-page .xk-gen-lead",
        "background-image: none !important;",
        "body.panel-page #mihomo-import-modal .modal-content",
        "grid-template-rows: 50px minmax(0, 1fr) 50px;",
        "body.panel-page #mihomo-import-modal .xk-mi-preview-wrap",
        "body.panel-page.mihomo-generator-page #bulkImportModal .modal-content",
        "height: auto !important;",
        "body.panel-page .xk-mihomo-vault-grid",
        "grid-template-columns: minmax(0, 1fr) !important;",
        "body.panel-page .xk-op-field-error[hidden]",
    ):
        assert fragment in css

    template = GENERATOR.read_text(encoding="utf-8")
    assert "filename='panel-operator.css', v='20260811h'" in template


def test_mihomo_forms_closure_is_documented():
    plan = PLAN.read_text(encoding="utf-8")
    doc = DOC.read_text(encoding="utf-8")
    index = INDEX.read_text(encoding="utf-8")
    assert "Этап 4 закрыт 29 июля 2026 года" in plan
    assert "[x] **Mihomo profiles/generator:**" in plan
    assert "[x] **Формы подписок:**" in plan
    assert "panel-operator-stage4-mihomo-forms.md" in plan
    assert "задачи «Mihomo profiles/generator» и «Формы подписок» Этапа 4 закрыты" in doc
    assert "## Progressive disclosure" in doc
    assert "Bulk Import имеет auto-height" in doc
    assert "Визуальная доводка Mihomo" in plan
    assert "panel-operator-stage4-mihomo-forms.md" in index


def test_mihomo_generator_validation_result_uses_flat_operator_diagnostic_contract():
    template = (ROOT / "xkeen-ui" / "templates" / "mihomo_generator.html").read_text(encoding="utf-8")
    css = (ROOT / "xkeen-ui" / "static" / "panel-operator.css").read_text(encoding="utf-8")

    modal = template[template.index('id="mihomoResultModal"'):template.index('id="bulkImportModal"')]
    assert 'data-operator-modal-family="master-detail"' in modal

    for fragment in (
        "/* The generator's validation result is an operational diagnostic",
        "#mihomoResultModal .modal-content {",
        "#mihomoResultModal .mihomo-result-grid {",
        "#mihomoResultModal .mihomo-result-state-badge {",
        "#mihomoResultModal .mihomo-result-terminal {",
        "background: var(--op-surface) !important;",
        "background: var(--op-editor) !important;",
        "border-radius: var(--op-control-radius) !important;",
    ):
        assert fragment in css

    operator_block = css[css.index("/* The generator's validation result is an operational diagnostic") : css.index("/* Xray proxy pool")]
    for legacy in ("linear-gradient", "radial-gradient", "999px", "#60a5fa"):
        assert legacy not in operator_block


def test_routing_mihomo_validation_uses_the_same_flat_operator_diagnostic_contract():
    template = PANEL.read_text(encoding="utf-8")
    css = CSS.read_text(encoding="utf-8")

    modal = template[template.index('id="mihomo-validation-modal"'):template.index('id="ssh-modal"')]
    assert 'data-operator-modal-family="master-detail"' in modal

    for fragment in (
        "/* Routing Mihomo uses the same diagnostic grammar as the generator.",
        "#mihomo-validation-modal .modal-content {",
        "#mihomo-validation-modal .xk-mihomo-validation-grid {",
        "#mihomo-validation-modal .xk-mihomo-validation-state-badge {",
        "#mihomo-validation-modal .xk-mihomo-validation-terminal {",
        "Routing Mihomo opens the same validation diagnostic from the editor menu.",
        "height: 100dvh !important;",
    ):
        assert fragment in css

    routing_block = css[
        css.index("/* Routing Mihomo uses the same diagnostic grammar as the generator.")
        : css.index("/* Xray proxy pool")
    ]
    for legacy in ("linear-gradient", "radial-gradient", "999px", "#60a5fa"):
        assert legacy not in routing_block


def test_generator_validation_log_uses_a_readable_neutral_diagnostic_canvas():
    css = CSS.read_text(encoding="utf-8")

    for fragment in (
        "body.panel-page.mihomo-generator-page .validation-log-panel {",
        "min-height: 146px;",
        "flex: 0 0 clamp(146px, 18dvh, 190px);",
        "body.panel-page.mihomo-generator-page .validation-log {",
        "min-height: 0 !important;",
        "max-height: none !important;",
        "background: var(--op-editor) !important;",
        "color: var(--op-data-muted) !important;",
    ):
        assert fragment in css
