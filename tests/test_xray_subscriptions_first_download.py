"""Подписки, сохранённые без «Сразу», скачиваются одной пачкой по кнопке."""

from __future__ import annotations

from pathlib import Path

import pytest

from tests.test_xray_subscriptions_pause import Bench


@pytest.fixture
def bench(tmp_path: Path, monkeypatch) -> Bench:
    return Bench(tmp_path, monkeypatch)


def _save_only(bench: Bench, sub_id: str) -> None:
    bench.subs.upsert_subscription(
        str(bench.state), {"id": sub_id, "tag": sub_id, "url": f"https://example.com/{sub_id}"}
    )


def _refresh_due(bench: Bench, restarts: list, **extra):
    return bench.subs.refresh_due_subscriptions(
        str(bench.state),
        xray_configs_dir=str(bench.xray),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **kwargs: restarts.append(kwargs.get("source")) or True,
        **extra,
    )


def test_button_downloads_saved_but_never_downloaded_subscriptions_in_one_batch(bench: Bench):
    _save_only(bench, "alpha")
    _save_only(bench, "beta")
    restarts: list = []

    results = _refresh_due(bench, restarts, include_new=True)

    assert sorted(item["id"] for item in results) == ["alpha", "beta"]
    assert all(item["ok"] for item in results)
    assert restarts == ["xray-subscriptions-batch"]
    assert (bench.xray / "04_outbounds.alpha.json").exists()
    assert (bench.xray / "04_outbounds.beta.json").exists()


def test_scheduler_still_leaves_them_until_their_term(bench: Bench):
    _save_only(bench, "alpha")
    restarts: list = []

    results = _refresh_due(bench, restarts)

    assert results == []
    assert bench.fetched == []
    assert restarts == []


def test_button_does_not_redownload_what_is_already_there_and_not_due(bench: Bench):
    bench.add("alpha")
    _save_only(bench, "beta")
    bench.fetched.clear()
    restarts: list = []

    results = _refresh_due(bench, restarts, include_new=True)

    assert [item["id"] for item in results] == ["beta"]
    assert bench.fetched == ["https://example.com/beta"]
