from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _read(rel_path: str) -> str:
    return (ROOT / rel_path).read_text(encoding="utf-8")


def test_restart_log_formats_subscription_refresh_entries_and_polls_for_updates():
    restart_log_src = _read("xkeen-ui/static/js/features/restart_log.js")
    styles_src = _read("xkeen-ui/static/styles.css")

    assert "const RESTART_LOG_POLL_MS = 15000;" in restart_log_src
    assert "'xray-subscription-refresh': {" in restart_log_src
    assert "'core-switch': {" in restart_log_src
    assert "'xray-preflight': {" in restart_log_src
    assert "parseRestartMeta" in restart_log_src
    assert "цель: ${core}" in restart_log_src
    assert "const RESTART_LOG_TITLE = 'Журнал операций Xkeen';" in restart_log_src
    assert "LEGACY_RESTART_LOG_TITLE_RE" in restart_log_src
    assert "normalizeRestartLogChrome" in restart_log_src
    assert "fetchPreflightPayload" in restart_log_src
    assert "/api/operation-diagnostics/" in restart_log_src
    assert "data-xk-restart-log-filter" in restart_log_src
    assert "data-xk-restart-log-search" in restart_log_src
    assert "data-xk-restart-log-token" in restart_log_src
    assert "data-xk-restart-log-bottom" in restart_log_src
    assert "data-xk-restart-log-action=\"fullscreen\"" in restart_log_src
    assert "data-xk-restart-log-detail-toggle" in restart_log_src
    render_all_src = restart_log_src.split("function renderAll()", 1)[1].split("function ensurePolling()", 1)[0]
    assert "bindLogInteractions();" in render_all_src
    assert "data-xk-restart-log-preflight-ref" in restart_log_src
    assert "rememberXrayPreflightPayload" in restart_log_src
    assert "runtime_status" in restart_log_src
    assert "label: 'Подписка Xray'" in restart_log_src
    assert "showSubscriptionRefreshToast" in restart_log_src
    assert "toastNewSubscription" in restart_log_src
    assert "XRAY_BRACKET_LINE_RE" in restart_log_src
    assert "match[5] || match[6]" in restart_log_src
    assert "buildRuntimeLogLineHtml" in restart_log_src
    assert "restart-log-runtime-line" in restart_log_src
    assert "restart-log-service-line" in restart_log_src
    assert "restart-log-pill-subscription" in styles_src
    assert "restart-log-pill-core" in styles_src
    assert "restart-log-details-toggle" in styles_src
    assert "restart-log-pill-preflight" in styles_src
    assert "restart-log-preflight-open" in styles_src
    assert "restart-log-filter-btn" in styles_src
    assert "restart-log-search-input" in styles_src
    assert "restart-log-bottom-btn" in styles_src
    assert "restart-log-level-info" in styles_src
    assert "restart-log-runtime-source" in styles_src
    assert "grid-template-columns: max-content max-content minmax(0, max-content);" in styles_src
    assert "box-sizing: border-box;" in styles_src
    assert "scrollbar-color" in styles_src
    assert ".log-card .log-line-success" in styles_src


def test_restart_log_details_toggle_resolves_panel_inside_clicked_log_container():
    restart_log_src = _read("xkeen-ui/static/js/features/restart_log.js")

    assert "function getRestartLogScopeId(el)" in restart_log_src
    assert "safeDomIdPart(scopeId)" in restart_log_src
    assert "buildStructuredLineHtml(summary, entry, scopeId)" in restart_log_src

    assert "function findRestartLogDetailsForToggle(button, root)" in restart_log_src
    helper_src = restart_log_src.split("function findRestartLogDetailsForToggle(button, root)", 1)[1].split("function normalizeLineForTerminal", 1)[0]
    assert "button.nextElementSibling" in helper_src
    assert "root.querySelectorAll('.restart-log-details')" in helper_src
    assert "root.contains(globalMatch)" in helper_src

    bind_src = restart_log_src.split("function bindLogInteractions()", 1)[1].split("RL.reveal = function reveal", 1)[0]
    assert "findRestartLogDetailsForToggle(button, el)" in bind_src
    assert "document.getElementById(id)" not in bind_src


def test_append_restart_log_broadcasts_appended_event(monkeypatch, tmp_path):
    from services import restart_log
    from services import events as events_module

    captured: list[dict] = []
    monkeypatch.setattr(events_module, "broadcast_event", lambda payload: captured.append(dict(payload)))

    log_file = tmp_path / "restart.log"
    restart_log.append_restart_log(str(log_file), True, source="routing", duration_ms=120)
    restart_log.append_restart_log(str(log_file), False, source="core-switch")

    assert log_file.read_text(encoding="utf-8").count("\n") == 2
    assert len(captured) == 2
    assert captured[0] == {"event": "restart_log_appended", "source": "routing", "ok": True}
    assert captured[1] == {"event": "restart_log_appended", "source": "core-switch", "ok": False}


def test_append_restart_log_swallows_broadcast_failures(monkeypatch, tmp_path):
    from services import restart_log
    from services import events as events_module

    def _boom(_payload):
        raise RuntimeError("ws broken")

    monkeypatch.setattr(events_module, "broadcast_event", _boom)

    log_file = tmp_path / "restart.log"
    restart_log.append_restart_log(str(log_file), True, source="routing")

    assert log_file.read_text(encoding="utf-8").startswith("[")


def test_restart_log_renders_summary_above_block():
    panel_src = _read("xkeen-ui/templates/panel.html")
    restart_log_src = _read("xkeen-ui/static/js/features/restart_log.js")
    styles_src = _read("xkeen-ui/static/styles.css")

    assert panel_src.count('data-xk-restart-log-summary="1"') == 3
    assert "buildRestartLogSummary" in restart_log_src
    assert "renderAllSummary" in restart_log_src
    assert "Последний перезапуск" in restart_log_src
    assert "Активное ядро" in restart_log_src
    assert "Всего ошибок" in restart_log_src
    assert "formatSummaryTimestamp" in restart_log_src
    assert ".restart-log-summary" in styles_src
    assert ".restart-log-summary-part-success" in styles_src
    assert ".restart-log-summary-part-error" in styles_src


def test_restart_log_has_viewer_ux_without_xray_log_source_duplication():
    restart_log_src = _read("xkeen-ui/static/js/features/restart_log.js")
    panel_src = _read("xkeen-ui/templates/panel.html")
    styles_src = _read("xkeen-ui/static/styles.css")

    assert "function entryMatchesSearch(entry)" in restart_log_src
    assert "RL.applyTokenFilter" in restart_log_src
    assert "shouldAutoScrollRestartLog" in restart_log_src
    assert "toggleRestartLogFullscreen" in restart_log_src
    assert "xk-restart-log-card" in panel_src
    assert ".log-card.xk-restart-log-card.is-fullscreen .log-block" in styles_src
    assert ".log-card.xk-restart-log-card.is-fullscreen {" in styles_src
    assert "z-index: 10100;" in styles_src
    assert "isolation: isolate;" in styles_src
    assert "error.log" not in restart_log_src.split("const RESTART_LOG_TITLE", 1)[1].split("const XRAY_TS_LINE_RE", 1)[0]


def test_restart_log_subscribes_to_events_ws_for_instant_refresh():
    restart_log_src = _read("xkeen-ui/static/js/features/restart_log.js")

    assert "RESTART_LOG_WS_EVENTS" in restart_log_src
    assert "'restart_log_appended'" in restart_log_src
    assert "'xkeen_restarted'" in restart_log_src
    assert "'core_changed'" in restart_log_src
    assert "scope: 'events'" in restart_log_src
    assert "/ws/events?token=" in restart_log_src
    assert "ensureRestartLogWs" in restart_log_src
    assert "debouncedRestartLogReload" in restart_log_src
    assert "scheduleRestartLogWsReconnect" in restart_log_src


def test_outbounds_subscription_refresh_relies_on_restart_log_for_changed_restarts():
    outbounds_src = _read("xkeen-ui/static/js/features/outbounds.js")
    refresh_marker = "async function subsRefresh("
    subs_refresh_src = outbounds_src.split(refresh_marker, 1)[1].split("async function subsRefreshDue() {", 1)[0]
    subs_refresh_due_src = outbounds_src.split("async function subsRefreshDue() {", 1)[1]

    assert "const fileChanged = !!data.changed;" in outbounds_src
    assert "const observatoryChanged = !!data.observatory_changed;" in outbounds_src
    assert "const routingChanged = !!data.routing_changed;" in outbounds_src
    assert "const changed = !!(fileChanged || observatoryChanged || routingChanged);" in outbounds_src
    assert "data.changed = changed;" in outbounds_src
    assert "Подписка проверена: изменений нет." in outbounds_src
    assert "Подписка Xray обновлена." in outbounds_src
    assert "const restartedCount = results.filter((item) => !!(item && item.restarted)).length;" in outbounds_src
    assert "const failedItems = results.filter((item) => item && item.ok === false);" in subs_refresh_due_src
    assert "Due-подписки: успешно" in subs_refresh_due_src
    assert "Due-подписки не обновились" in subs_refresh_due_src
    assert "Ошибка due-обновления:" in subs_refresh_due_src
    assert "toastXkeen(msg, 'success');" not in subs_refresh_src
    assert "toastXkeen(msg, 'success');" not in subs_refresh_due_src


def test_restart_log_parses_mihomo_logfmt_runtime_lines():
    restart_log_src = _read("xkeen-ui/static/js/features/restart_log.js")

    assert "RUNTIME_LOGFMT_LINE_RE" in restart_log_src
    assert "decodeLogfmtValue" in restart_log_src
    assert "logfmtMatch[3]" in restart_log_src
    assert "logfmtMatch[4] || logfmtMatch[5]" in restart_log_src
