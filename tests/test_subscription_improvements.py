import json
from datetime import datetime
from pathlib import Path

import pytest
from flask import Flask
from routes.xray_subscriptions import create_xray_subscriptions_blueprint
from services import xray_subscriptions as subs
from services.subscription_cron import next_cron
from services.subscription_schedule import plan_alignment


def stamp(text):
    return datetime.fromisoformat(text).timestamp()


@pytest.mark.parametrize(
    ("expression", "now", "expected"),
    [
        ("0 4 * * *", "2026-10-25T04:00:00", "2026-10-26T04:00:00"),
        ("*/15 8-9 * * 1-5", "2026-10-23T09:46:00", "2026-10-26T08:00:00"),
        ("0 0 29 2 *", "2026-10-25T12:00:00", "2028-02-29T00:00:00"),
        ("0 12 * * 7", "2026-10-25T11:59:00", "2026-10-25T12:00:00"),
        ("0 12 * * 0", "2026-10-25T12:00:01", "2026-11-01T12:00:00"),
        ("5,35 4 * * *", "2026-10-25T04:05:00", "2026-10-25T04:35:00"),
        ("0 4 1 * 1", "2026-10-25T12:00:00", "2026-10-26T04:00:00"),
        ("0 0 */2 * 1", "2026-10-28T12:00:00", "2026-10-29T00:00:00"),
    ],
)
def test_cron_calendar(expression, now, expected):
    assert next_cron(expression, stamp(now)) == stamp(expected)


@pytest.mark.parametrize(
    "expression",
    [
        "* * * *",
        "60 * * * *",
        "* 24 * * *",
        "*/0 * * * *",
        "0 4 31 2 *",
        "x * * * *",
        "0 4 * * 8",
        "0 4 * * 5-1",
    ],
)
def test_invalid_or_impossible_cron(expression):
    with pytest.raises(ValueError):
        next_cron(expression, stamp("2026-10-25T12:00:00"))


def test_schedule_edit_recalculates_and_alignment_leaves_cron_alone(
    tmp_path, monkeypatch
):
    now = stamp("2026-10-25T12:00:00")
    monkeypatch.setattr(subs, "_now", lambda: now)
    base = subs.upsert_subscription(
        str(tmp_path), {"id": "a", "url": "https://example.com/sub"}
    )
    assert base["next_update_ts"] == now + 86400
    calendar = subs.upsert_subscription(
        str(tmp_path),
        {
            "id": "a",
            "url": base["url"],
            "schedule_mode": "cron",
            "cron_expression": "0 4 * * *",
        },
    )
    assert calendar["next_update_ts"] == stamp("2026-10-26T04:00:00")
    assert subs.list_subscriptions(str(tmp_path))[0]["cron_expression"] == "0 4 * * *"
    assert (
        plan_alignment([calendar, {"id": "b", "next_update_ts": now + 60}], now_ts=now)[
            "moves"
        ]
        == []
    )
    disabled = subs.upsert_subscription(str(tmp_path), {**calendar, "enabled": False})
    assert disabled["next_update_ts"] is None


def client(tmp_path):
    app = Flask(__name__)
    app.register_blueprint(
        create_xray_subscriptions_blueprint(
            ui_state_dir=str(tmp_path / "state"),
            xray_configs_dir=str(tmp_path / "configs"),
            restart_xkeen=lambda **kw: True,
            snapshot_xray_config_before_overwrite=lambda path: None,
        )
    )
    return app.test_client()


@pytest.mark.parametrize(
    ("pattern", "kept"),
    [
        (r"^(?!.*ws).*$", ["Germany"]),
        (r"(?i)^germany$", ["Germany"]),
        (r"(?P<region>Germany|ws)$", ["Germany", "France ws"]),
        (r"(?<=France )ws", ["France ws"]),
        (r"^(Germany)\1$", []),
    ],
)
def test_preview_uses_python_regex(tmp_path, pattern, kept):
    names = ["Germany", "France ws", "WSS"]
    response = client(tmp_path).post(
        "/api/xray/subscriptions/validate-filters",
        json={
            "name_filter": pattern,
            "nodes": [{"key": name, "name": name} for name in names],
        },
    )
    assert response.status_code == 200
    reasons = response.get_json()["reasons"]
    assert [name for name in names if not reasons[name]] == kept


def test_invalid_regex_preview(tmp_path):
    response = client(tmp_path).post(
        "/api/xray/subscriptions/validate-filters",
        json={"name_filter": "[", "nodes": []},
    )
    assert response.status_code == 400
    assert "regex" in response.get_json()["error"]


@pytest.mark.parametrize("runtime", [False, True])
def test_batch_reuses_download_and_skips_unchanged_restart(tmp_path, monkeypatch, runtime):
    configs = tmp_path / "configs"
    configs.mkdir()
    state = str(tmp_path / "state")
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs, "jsonc_path_for", lambda path: str(tmp_path / (Path(path).name + "c"))
    )
    monkeypatch.setattr(subs, "_confirm_live_config", lambda *args: "")
    body = "\n".join(
        f"vless://user@example.com:443?type=tcp&security=tls&encryption=none#{name}"
        for name in ("Germany", "France")
    )
    calls = []

    def fetch(url, **kwargs):
        calls.append((url, kwargs))
        return body, {}, {}

    monkeypatch.setattr(subs, "fetch_subscription_body_for_xray", fetch)
    for name, pattern in [("a", "Germany"), ("b", "France")]:
        subs.upsert_subscription(
            state,
            {
                "id": name,
                "tag": name,
                "url": "https://example.com/sub",
                "name_filter": pattern,
                "ping_enabled": runtime,
                "routing_auto_rule": runtime,
            },
        )
    restarts = []
    results = subs.refresh_due_subscriptions(
        state,
        xray_configs_dir=str(configs),
        include_new=True,
        restart_xkeen=lambda **kw: restarts.append(kw) or True,
    )
    assert all(item["ok"] for item in results), results
    assert len(calls) == 1
    assert len(restarts) == 1
    assert all(item["count"] == 1 for item in results)
    saved = subs.load_subscription_state(state)
    for item in saved["subscriptions"]:
        item["next_update_ts"] = 1
    subs._write_state(state, saved)
    results = subs.refresh_due_subscriptions(
        state,
        xray_configs_dir=str(configs),
        restart_xkeen=lambda **kw: restarts.append(kw) or True,
    )
    assert all(item["ok"] for item in results), results
    assert len(calls) == 2  # cache ends at the batch boundary
    assert len(restarts) == 1
    assert not any(item["restarted"] for item in results)


def test_temporary_runtime_writes_do_not_require_restart(tmp_path, monkeypatch):
    path = tmp_path / Path(subs.ROUTING_FILE).name
    path.write_text('{"routing": {"rules": []}}', encoding="utf-8")

    def rebuild(*args, **kwargs):
        path.write_text('{"routing": {"rules": [1]}}', encoding="utf-8")
        path.write_text('{\n "routing": {"rules": []}\n}', encoding="utf-8")
        return {"routing_changed": True}

    monkeypatch.setattr(subs, "_rebuild_subscription_runtime_impl", rebuild)
    result = subs._rebuild_subscription_runtime(
        str(tmp_path), xray_configs_dir=str(tmp_path)
    )
    assert not result["routing_changed"]


def test_invalid_runtime_json_changes_are_not_hidden(tmp_path):
    path = tmp_path / Path(subs.ROUTING_FILE).name
    path.write_text('{"routing": [', encoding="utf-8")
    before = subs._runtime_file_state(str(tmp_path))
    path.write_text('{"routing": {', encoding="utf-8")
    assert subs._runtime_file_state(str(tmp_path)) != before


def test_compact_list_omits_only_internal_outbound_baselines(tmp_path, monkeypatch):
    import routes.xray_subscriptions as routes

    item = {
        "id": "a",
        "last_nodes": [{"key": "node"}],
        "last_generated_outbounds": {"large": "private config"},
    }
    monkeypatch.setattr(routes, "list_subscriptions", lambda state: [item])
    monkeypatch.setattr(
        routes, "list_subscription_routing_balancers", lambda configs: []
    )
    monkeypatch.setattr(routes, "get_subscription_routing_meta", lambda configs: {})
    api = client(tmp_path)
    full = api.get("/api/xray/subscriptions").get_json()["subscriptions"][0]
    compact = api.get(
        "/api/xray/subscriptions", headers={"X-Subscriptions-Compact": "1"}
    ).get_json()["subscriptions"][0]
    assert "last_generated_outbounds" in full
    assert "last_generated_outbounds" not in compact
    assert compact["last_nodes"] == full["last_nodes"]


def test_cron_is_not_refreshed_early_by_interval_lookahead(tmp_path, monkeypatch):
    now = stamp("2026-10-25T12:00:00")
    monkeypatch.setattr(subs, "_now", lambda: now)
    for name in ["interval", "cron"]:
        subs.upsert_subscription(
            str(tmp_path),
            {
                "id": name,
                "url": "https://example.com/" + name,
                "schedule_mode": name,
                "cron_expression": "* * * * *",
            },
        )
    state = subs.load_subscription_state(str(tmp_path))
    for item in state["subscriptions"]:
        item["next_update_ts"] = now - 1 if item["id"] == "interval" else now + 60
    subs._write_state(str(tmp_path), state)
    visited = []
    monkeypatch.setattr(
        subs,
        "refresh_subscription",
        lambda state, id, **kw: visited.append(id) or {"ok": True, "changed": False},
    )
    subs.refresh_due_subscriptions(
        str(tmp_path), xray_configs_dir=str(tmp_path), restart=False
    )
    assert visited == ["interval"]


def test_distinct_request_profiles_are_not_deduplicated(tmp_path, monkeypatch):
    configs = tmp_path / "configs"
    configs.mkdir()
    state = str(tmp_path / "state")
    calls = []
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs, "jsonc_path_for", lambda path: str(tmp_path / (Path(path).name + "c"))
    )
    monkeypatch.setattr(subs, "_confirm_live_config", lambda *args: "")

    def fetch(url, **kwargs):
        calls.append(kwargs)
        return (
            "vless://user@example.com:443?type=tcp&security=tls&encryption=none#Node",
            {},
            {},
        )

    monkeypatch.setattr(subs, "fetch_subscription_body_for_xray", fetch)
    for name, profile in [("a", {"mode": "disabled"}), ("b", {"mode": "auto"})]:
        subs.upsert_subscription(
            state,
            {
                "id": name,
                "url": "https://example.com/sub",
                "request_profile": profile,
                "routing_auto_rule": False,
                "ping_enabled": False,
            },
        )
    results = subs.refresh_due_subscriptions(
        state, xray_configs_dir=str(configs), include_new=True, restart=False
    )
    assert all(item["ok"] for item in results), results
    assert len(calls) == 2


def test_failed_batch_download_is_not_retried_for_each_duplicate(tmp_path, monkeypatch):
    state = str(tmp_path / "state")
    calls = []

    def fetch(url, **kwargs):
        calls.append(url)
        raise RuntimeError("provider unavailable")

    monkeypatch.setattr(subs, "fetch_subscription_body_for_xray", fetch)
    for name in ["a", "b"]:
        subs.upsert_subscription(state, {"id": name, "url": "https://example.com/sub"})
    results = subs.refresh_due_subscriptions(
        state, xray_configs_dir=str(tmp_path), include_new=True, restart=False
    )
    assert all(not item["ok"] for item in results)
    assert len(calls) == 1


def test_failed_cron_refresh_respects_error_backoff(tmp_path, monkeypatch):
    now = stamp("2026-10-28T12:00:00")
    monkeypatch.setattr(subs, "_now", lambda: now)

    def fail_fetch(url, **kwargs):
        raise RuntimeError("provider unavailable")

    monkeypatch.setattr(subs, "fetch_subscription_body_for_xray", fail_fetch)
    sub = subs.upsert_subscription(
        str(tmp_path),
        {
            "id": "cron",
            "url": "https://example.com/sub",
            "schedule_mode": "cron",
            "cron_expression": "* * * * *",
        },
    )
    result = subs.refresh_subscription(
        str(tmp_path), sub["id"], xray_configs_dir=str(tmp_path), restart=False
    )
    assert not result["ok"]
    saved = subs.list_subscriptions(str(tmp_path))[0]
    assert saved["next_update_ts"] == now + subs.DEFAULT_ERROR_RETRY_SECONDS


@pytest.mark.skipif(
    not hasattr(__import__("time"), "tzset"),
    reason="POSIX TZ switching is unavailable on Windows",
)
@pytest.mark.parametrize(
    ("now", "expected"),
    [
        ("2026-03-28T12:00:00+01:00", "2026-03-30T02:30:00+02:00"),
        ("2026-10-25T02:30:00+02:00", "2026-10-25T02:30:00+01:00"),
    ],
)
def test_cron_dst_wall_clock(now, expected, monkeypatch):
    import time

    previous = __import__("os").environ.get("TZ")
    monkeypatch.setenv("TZ", "Europe/Berlin")
    time.tzset()
    try:
        assert (
            next_cron("30 2 * * *", datetime.fromisoformat(now).timestamp())
            == datetime.fromisoformat(expected).timestamp()
        )
    finally:
        if previous is None:
            monkeypatch.delenv("TZ")
        else:
            monkeypatch.setenv("TZ", previous)
        time.tzset()
