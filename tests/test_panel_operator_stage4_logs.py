from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "xkeen-ui/templates/panel.html"
CSS = ROOT / "xkeen-ui/static/panel-operator.css"
XRAY_LOGS = ROOT / "xkeen-ui/static/js/features/xray_logs.js"
RESTART_LOG = ROOT / "xkeen-ui/static/js/features/restart_log.js"
PLAN = ROOT / "docs/panel-operator-redesign-completion-plan.md"
DOC = ROOT / "docs/panel-operator-stage4-logs.md"
INDEX = ROOT / "docs/README.md"


def test_logs_markup_keeps_runtime_hooks_and_exposes_shared_operator_regions():
    text = TEMPLATE.read_text(encoding="utf-8")
    view = text[text.index('id="view-xray-logs"') : text.index('<!-- Xray log: device names -->')]

    for runtime_id in (
        "xray-log-file",
        "xray-log-level",
        "xray-log-filter",
        "xray-log-mode",
        "xray-log-stats",
        "xray-log-output",
        "xray-log-status",
        "xray-context-modal",
        "xray-context-output",
    ):
        assert f'id="{runtime_id}"' in view

    for fragment in (
        'class="log-filter-row xk-log-filter-bar" role="search"',
        'class="dt-log-controls xray-log-controls xk-log-control-bar"',
        'class="xk-log-counters"',
        'class="status xk-log-state" role="status" aria-live="polite"',
        'class="modal-content xray-context-modal-content"',
        'data-modal-key="xray-log-context"',
        'class="log-block" aria-label="Контекст выбранной строки" tabindex="0"',
    ):
        assert fragment in view
    assert 'style="max-width: 980px;"' not in view
    assert 'style="max-height:60vh; overflow:auto;"' not in view


def test_logs_operator_layer_unifies_filters_counters_details_and_states():
    css = CSS.read_text(encoding="utf-8")
    stage = css[css.index("/* Logs keep their terminal surface dominant") : css.index("/* File manager:")]

    for fragment in (
        ".xk-log-filter-bar",
        ".xk-log-counters",
        ".xk-log-counter-label",
        ".restart-log-details-toggle",
        'aria-expanded="true"',
        ".restart-log-detail-row",
        ".restart-log-empty.is-error",
        '.xk-log-state[data-tone="error"]',
        ".xray-context-modal-content",
        ".xray-context-line.is-focus",
        "background: var(--op-danger-soft) !important;",
        "border-radius: var(--op-control-radius) !important;",
    ):
        assert fragment in stage

    for legacy in ("linear-gradient(", "transform: translateY", "border-radius: 999"):
        assert legacy not in stage

    shared_compact = stage.split(
        "body.panel-page .xk-restart-log-card :is(.restart-log-pill, .restart-log-level, .restart-log-details-toggle) {", 1
    )[1].split("}", 1)[0]
    assert "height: 22px !important;" in shared_compact
    assert "min-height: 22px !important;" in shared_compact
    assert "max-height: 22px !important;" in shared_compact
    assert "padding: 2px 6px;" in shared_compact


def test_logs_runtime_renders_structured_counters_detail_focus_and_error_states():
    xray = XRAY_LOGS.read_text(encoding="utf-8")
    restart = RESTART_LOG.read_text(encoding="utf-8")

    for fragment in (
        'el.dataset.tone = String(model.tone || \'muted\');',
        'class="xk-log-counter" data-kind="lines"',
        'class="xk-log-counter-label">Строки</span>',
        "el.innerHTML = parts.join('');",
        "uiStatus.phase === 'error' || uiStatus.tone === 'error'",
        'class="xray-context-line',
        'data-context-focus="1"',
        "out.dataset.copyText = lines.join('\\n');",
    ):
        assert fragment in xray

    for fragment in (
        "el.dataset.state = loadError ? 'error' : (html ? 'ready' : 'empty');",
        'class="log-line restart-log-empty${loadError ? \' is-error\' : \'\'}"',
        'class="restart-log-empty-title"',
        'class="restart-log-empty-detail"',
        "button.setAttribute('aria-expanded', expanded ? 'false' : 'true');",
    ):
        assert fragment in restart


def test_logs_closure_is_documented():
    plan = PLAN.read_text(encoding="utf-8")
    doc = DOC.read_text(encoding="utf-8")
    index = INDEX.read_text(encoding="utf-8")

    assert "задача «Logs» закрыта 29 июля 2026 года" in plan
    assert "[x] **Logs:**" in plan
    assert "panel-operator-stage4-logs.md" in plan
    assert "Статус: **задача «Logs» Этапа 4 закрыта 29 июля 2026 года**." in doc
    assert "## State contract" in doc
    assert "## Автоматические проверки" in doc
    assert "panel-operator-stage4-logs.md" in index
