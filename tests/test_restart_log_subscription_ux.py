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
    assert "label: 'Подписка Xray'" in restart_log_src
    assert "showSubscriptionRefreshToast" in restart_log_src
    assert "toastNewSubscription" in restart_log_src
    assert "restart-log-pill-subscription" in styles_src
    assert ".log-card .log-line-success" in styles_src


def test_outbounds_subscription_refresh_relies_on_restart_log_for_changed_restarts():
    outbounds_src = _read("xkeen-ui/static/js/features/outbounds.js")
    refresh_marker = "async function subsRefresh("
    subs_refresh_src = outbounds_src.split(refresh_marker, 1)[1].split("async function subsRefreshDue() {", 1)[0]
    subs_refresh_due_src = outbounds_src.split("async function subsRefreshDue() {", 1)[1]

    assert "const changed = !!(data.changed || data.observatory_changed);" in outbounds_src
    assert "data.changed = changed;" in outbounds_src
    assert "Подписка проверена: изменений нет." in outbounds_src
    assert "Подписка Xray обновлена." in outbounds_src
    assert "const restartedCount = results.filter((item) => !!(item && item.restarted)).length;" in outbounds_src
    assert "toastXkeen(msg, 'success');" not in subs_refresh_src
    assert "toastXkeen(msg, 'success');" not in subs_refresh_due_src
