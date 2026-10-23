from __future__ import annotations

import re

from pathlib import Path

from scripts.panel_template_source import compose_panel_template


ROOT = Path(__file__).resolve().parents[1]


def _read(rel_path: str) -> str:
    if rel_path == "xkeen-ui/templates/panel.html":
        return compose_panel_template(ROOT)
    if rel_path == "xkeen-ui/static/js/features/restart_log.js":
        # Source labels live in their own module, shared with DevTools -> Logs.
        return "\n".join(
            (ROOT / name).read_text(encoding="utf-8")
            for name in (rel_path, "xkeen-ui/static/js/features/restart_log_sources.js")
        )
    return (ROOT / rel_path).read_text(encoding="utf-8")


def test_restart_log_formats_subscription_refresh_entries_and_polls_for_updates():
    restart_log_src = _read("xkeen-ui/static/js/features/restart_log.js")
    journal_src = _read("xkeen-ui/templates/panel/journal_card.html")
    operator_css = _read("xkeen-ui/static/panel-operator.css")

    assert "const RESTART_LOG_POLL_MS = 15000;" in restart_log_src
    assert "'xray-subscription-refresh': {" in restart_log_src
    assert "'core-switch': {" in restart_log_src
    assert "'xray-preflight': {" in restart_log_src
    assert "'xray-logs-enable': {" in restart_log_src
    assert "label: 'Логи Xray'" in restart_log_src
    assert "parseRestartMeta" in restart_log_src
    assert "normalizeRestartLogChrome" in restart_log_src
    assert "fetchPreflightPayload" in restart_log_src
    assert "/api/operation-diagnostics/" in restart_log_src
    assert "data-xk-restart-log-filter" in restart_log_src
    assert "data-xk-restart-log-search" in restart_log_src
    assert "data-xk-restart-log-token" in restart_log_src
    assert "data-xk-restart-log-bottom" in restart_log_src
    assert "data-xk-restart-log-action=\"fullscreen\"" in journal_src
    assert "data-xk-restart-log-group-toggle" in restart_log_src
    render_all_src = restart_log_src.split("function renderAll()", 1)[1].split("function ensurePolling()", 1)[0]
    assert "bindLogInteractions();" in render_all_src
    assert "syncFilterCounts(groupJournalEntries(allEntries));" in render_all_src
    assert "data-xk-restart-log-preflight-ref" in restart_log_src
    assert "rememberXrayPreflightPayload" in restart_log_src
    assert "runtime_status" in restart_log_src
    assert "label: 'Подписка Xray'" in restart_log_src
    assert "showSubscriptionRefreshToast" in restart_log_src
    assert "toastNewSubscription" in restart_log_src
    assert "XRAY_BRACKET_LINE_RE" in restart_log_src
    assert "match[5] || match[6]" in restart_log_src
    assert "function journalOutLineHtml(entry)" in restart_log_src
    for selector in (".xk-jr-head", ".xk-jr-seg-btn.is-on", ".xk-jr-row", ".xk-jr-out", ".xk-jr-more", ".xk-jr-menu-item.is-danger"):
        assert f"body.panel-page {selector}" in operator_css
    assert "body.panel-page .xk-restart-log-card.is-fullscreen .xk-jr-box {" in operator_css

def test_restart_log_folds_command_output_under_its_operation():
    restart_log_src = _read("xkeen-ui/static/js/features/restart_log.js")

    # The panel writes the output of a command right before its result line:
    # that output belongs to the next structured entry, and output with no
    # result after it stays open as a group of its own.
    group_src = restart_log_src.split("function groupJournalEntries(entries)", 1)[1].split("function groupHasError", 1)[0]
    assert "groups.push({ key: entry.key, entry, summary: entry.summary, out: pending, live: false });" in group_src
    assert "pending = [];" in group_src
    assert "live: true" in group_src
    assert "return group.live ? !RL._shutGroups.has(group.key) : RL._openGroups.has(group.key);" in restart_log_src

    bind_src = restart_log_src.split("function bindLogInteractions()", 1)[1].split("RL.reveal = function reveal", 1)[0]
    assert "closest('[data-xk-restart-log-group]')" in bind_src
    assert "toggleRow(el, row);" in bind_src
    assert "event.key !== 'Enter'" in bind_src
    assert "copyJournalGroup(" in bind_src
    assert "node && el.contains(node)" in bind_src

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


def test_restart_log_excludes_mihomo_clash_audit_noise(monkeypatch, tmp_path):
    from services import restart_log
    from services import events as events_module

    captured: list[dict] = []
    monkeypatch.setattr(events_module, "broadcast_event", lambda payload: captured.append(dict(payload)))

    log_file = tmp_path / "restart.log"
    log_file.write_text(
        "[2026-08-12 02:17:23] source=mihomo-clash result=FAIL action=delay\n"
        "[2026-08-12 02:17:24] source=routing result=OK\n",
        encoding="utf-8",
    )

    restart_log.append_restart_log(str(log_file), True, source="mihomo-clash", action="delay")

    assert restart_log.read_restart_log(str(log_file), limit=100) == [
        "[2026-08-12 02:17:24] source=routing result=OK\n"
    ]
    assert captured == []


def test_restart_log_visible_limit_is_applied_after_clash_filter(tmp_path):
    from services import restart_log

    log_file = tmp_path / "restart.log"
    log_file.write_text(
        "[2026-08-12 02:00:00] source=routing result=OK\n"
        + "".join(
            f"[2026-08-12 02:00:{index:02d}] source=mihomo-clash result=OK action=delay\n"
            for index in range(1, 20)
        )
        + "[2026-08-12 02:01:00] source=core-switch result=OK\n",
        encoding="utf-8",
    )

    assert restart_log.read_restart_log(str(log_file), limit=2) == [
        "[2026-08-12 02:00:00] source=routing result=OK\n",
        "[2026-08-12 02:01:00] source=core-switch result=OK\n",
    ]


def test_restart_log_renders_summary_above_block():
    panel_src = _read("xkeen-ui/templates/panel.html")
    restart_log_src = _read("xkeen-ui/static/js/features/restart_log.js")
    operator_css = _read("xkeen-ui/static/panel-operator.css")

    assert panel_src.count('data-xk-restart-log-summary="1"') == 5
    assert "buildRestartLogSummary" in restart_log_src
    assert "renderAllSummary" in restart_log_src
    assert "Последний перезапуск" in restart_log_src
    assert "label: 'Ядро'" in restart_log_src
    assert "label: 'Ошибок'" in restart_log_src
    assert "formatSummaryTimestamp" in restart_log_src
    assert "body.panel-page .xk-jr-sum .k-success b" in operator_css
    assert "body.panel-page .xk-jr-sum .k-error b" in operator_css

def test_restart_log_has_viewer_ux_without_xray_log_source_duplication():
    restart_log_src = _read("xkeen-ui/static/js/features/restart_log.js")
    panel_src = _read("xkeen-ui/templates/panel.html")
    styles_src = _read("xkeen-ui/static/styles.css")

    assert "function entryMatchesSearch(entry)" in restart_log_src
    assert "RL.applyTokenFilter" in restart_log_src
    assert "shouldAutoScrollRestartLog" in restart_log_src
    assert "toggleRestartLogFullscreen" in restart_log_src
    assert "xk-restart-log-card" in panel_src
    assert panel_src.count('{% include "panel/journal_card.html" %}') == 0
    assert panel_src.count('class="xk-jr-box" data-xk-restart-log="1"') == 5
    assert ".log-card.xk-restart-log-card.is-fullscreen {" in styles_src
    assert "z-index: 10100;" in styles_src
    assert "isolation: isolate;" in styles_src
    assert "error.log" not in restart_log_src.split("const RESTART_SOURCE_META", 1)[1].split("const XRAY_TS_LINE_RE", 1)[0]

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
    assert "return active.includes('core');" in restart_log_src


def test_outbounds_subscription_refresh_relies_on_restart_log_for_changed_restarts():
    outbounds_src = _read("xkeen-ui/static/js/features/outbounds.js")
    refresh_marker = "async function subsRefresh("
    subs_refresh_src = outbounds_src.split(refresh_marker, 1)[1].split("async function subsRefreshDue() {", 1)[0]
    # Срез обязан кончаться на самой функции: пока subsRefreshDue была последней
    # в файле, «всё до конца» работало случайно, и первая же соседка ниже ломала
    # проверку «эта функция не тостит успех сама».
    subs_refresh_due_src = re.split(
        r"\n    (?:async )?function ",
        outbounds_src.split("async function subsRefreshDue() {", 1)[1],
        maxsplit=1,
    )[0]

    assert "const fileChanged = !!data.changed;" in outbounds_src
    assert "const observatoryChanged = !!data.observatory_changed;" in outbounds_src
    assert "const routingChanged = !!data.routing_changed;" in outbounds_src
    assert "const changed = !!(fileChanged || observatoryChanged || routingChanged);" in outbounds_src
    assert "data.changed = changed;" in outbounds_src
    assert "Подписка проверена: изменений нет." in outbounds_src
    assert "Подписка Xray обновлена." in outbounds_src
    assert "const restartedCount = results.filter((item) => !!(item && item.restarted)).length;" in outbounds_src
    assert "const failedItems = results.filter((item) => item && item.ok === false);" in subs_refresh_due_src
    assert "Просроченные подписки: успешно" in subs_refresh_due_src
    assert "Просроченные подписки не обновились" in subs_refresh_due_src
    assert "Ошибка обновления просроченных:" in subs_refresh_due_src
    assert "toastXkeen(msg, 'success');" not in subs_refresh_src
    assert "toastXkeen(msg, 'success');" not in subs_refresh_due_src


def test_restart_log_parses_mihomo_logfmt_runtime_lines():
    restart_log_src = _read("xkeen-ui/static/js/features/restart_log.js")

    assert "RUNTIME_LOGFMT_LINE_RE" in restart_log_src
    assert "decodeLogfmtValue" in restart_log_src
    assert "logfmtMatch[3]" in restart_log_src
    assert "logfmtMatch[4] || logfmtMatch[5]" in restart_log_src
