"""Расчёт общего срока обновления для разъехавшихся подписок.

Подписки, добавленные в разное время, созревают в разные тики планировщика,
и каждая забирает себе отдельный перезапуск ядра. Пятиминутное окно в
refresh_due_subscriptions удерживает вместе только тех, кто уже рядом; свести
разошедшихся на несколько часов оно не может.

Здесь проверяется чистый расчёт: какой момент считать общим и кого к нему
двигать. Ни файлов, ни сети — те же функции обслуживают состояние Xray и
состояние Mihomo, которые между собой независимы.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "xkeen-ui"))

from services.subscription_schedule import (  # noqa: E402
    ALIGN_MIN_LEAD_SECONDS,
    plan_alignment,
)


MIDNIGHT = 1_789_000_000 - (1_789_000_000 % 86400)


def at(hhmm: str) -> float:
    """Момент внутри одних суток: at("03:48")."""
    hours, minutes = hhmm.split(":")
    return float(MIDNIGHT + int(hours) * 3600 + int(minutes) * 60)


def sub(sub_id: str, when: str | None, *, enabled: bool = True, last_ok: bool | None = True) -> dict:
    return {
        "id": sub_id,
        "tag": sub_id,
        "enabled": enabled,
        "next_update_ts": at(when) if when else None,
        "last_ok": last_ok,
    }


def moved_ids(plan: dict) -> set[str]:
    return {str(move["id"]) for move in plan["moves"]}


def test_anchor_is_median_of_the_densest_group():
    """Большинство — те, кто уже держится рядом; остальных тянем к ним."""
    subs = [
        sub("sub-main", "03:41"),
        sub("sub-eu", "03:48"),
        sub("sub-reserve", "03:52"),
        sub("sub-mobile", "09:15"),
    ]

    plan = plan_alignment(subs, now_ts=at("02:00"))

    assert plan["anchor_ts"] == at("03:48")
    assert plan["total"] == 4
    assert plan["moved"] == 3
    assert moved_ids(plan) == {"sub-main", "sub-reserve", "sub-mobile"}
    assert plan["max_shift_sec"] == 5 * 3600 + 27 * 60
    assert plan["reason"] == ""


def test_group_survives_the_half_hour_boundary():
    """Две подписки в двух минутах друг от друга — одна группа.

    Раскладка по получасовым корзинам разорвала бы эту пару по разные стороны
    отметки 03:30 и отдала бы победу более поздней паре.
    """
    subs = [
        sub("sub-a", "03:29"),
        sub("sub-b", "03:31"),
        sub("sub-c", "10:00"),
        sub("sub-d", "10:05"),
    ]

    plan = plan_alignment(subs, now_ts=at("02:00"))

    assert plan["anchor_ts"] == at("03:29")


def test_equally_dense_groups_resolve_to_the_earlier_one():
    """При ничьей берём раннюю группу: расписание не уезжает вперёд."""
    subs = [
        sub("sub-a", "01:00"),
        sub("sub-b", "01:05"),
        sub("sub-c", "05:00"),
        sub("sub-d", "05:05"),
    ]

    plan = plan_alignment(subs, now_ts=at("00:30"))

    assert plan["anchor_ts"] == at("01:00")


def test_failed_subscription_does_not_choose_the_anchor_but_moves_with_everyone():
    """Одна битая ссылка не должна утаскивать пачку на свой срок повтора."""
    subs = [
        sub("sub-main", "02:00"),
        sub("sub-eu", "02:05"),
        sub("sub-x", "08:00", last_ok=False),
        sub("sub-y", "08:02", last_ok=False),
        sub("sub-z", "08:04", last_ok=False),
    ]

    plan = plan_alignment(subs, now_ts=at("01:00"))

    assert plan["anchor_ts"] == at("02:00")
    assert plan["total"] == 5
    assert moved_ids(plan) == {"sub-eu", "sub-x", "sub-y", "sub-z"}


def test_when_every_subscription_failed_they_choose_the_anchor_themselves():
    """Иначе выравнивание отказало бы там, где оно нужнее всего."""
    subs = [
        sub("sub-x", "08:00", last_ok=False),
        sub("sub-y", "08:02", last_ok=False),
        sub("sub-z", "08:04", last_ok=False),
    ]

    plan = plan_alignment(subs, now_ts=at("01:00"))

    assert plan["anchor_ts"] == at("08:02")


def test_overdue_anchor_is_deferred_instead_of_landing_in_the_past():
    """Якорь в прошлом сделал бы всех просроченными задним числом."""
    now = at("05:00")
    subs = [
        sub("sub-main", "03:41"),
        sub("sub-eu", "03:48"),
        sub("sub-reserve", "03:52"),
    ]

    plan = plan_alignment(subs, now_ts=now)

    assert plan["anchor_ts"] == now + ALIGN_MIN_LEAD_SECONDS
    assert plan["anchor_deferred"] is True
    assert plan["overdue_count"] == 3
    assert plan["moved"] == 3


def test_disabled_and_unscheduled_subscriptions_stay_out():
    """Выключенная подписка и черновик без срока не участвуют и не двигаются."""
    subs = [
        sub("sub-main", "03:41"),
        sub("sub-eu", "03:48"),
        sub("sub-off", "09:00", enabled=False),
        sub("sub-draft", None),
    ]

    plan = plan_alignment(subs, now_ts=at("02:00"))

    assert plan["total"] == 2
    assert plan["skipped"] == 2
    assert plan["anchor_ts"] == at("03:41")
    assert moved_ids(plan) == {"sub-eu"}


def test_one_subscription_leaves_nothing_to_align():
    plan = plan_alignment([sub("sub-main", "03:41")], now_ts=at("02:00"))

    assert plan["reason"] == "nothing_to_align"
    assert plan["moves"] == []
    assert plan["anchor_ts"] is None


def test_empty_state_leaves_nothing_to_align():
    plan = plan_alignment([], now_ts=at("02:00"))

    assert plan["reason"] == "nothing_to_align"
    assert plan["moves"] == []


def test_already_aligned_subscriptions_are_not_pushed_forward():
    """Совпавшие сроки — уже результат; просроченность их не двигает."""
    subs = [
        sub("sub-main", "03:48"),
        sub("sub-eu", "03:48"),
        sub("sub-reserve", "03:48"),
    ]

    plan = plan_alignment(subs, now_ts=at("05:00"))

    assert plan["reason"] == "already_aligned"
    assert plan["moves"] == []
    assert plan["anchor_ts"] == at("03:48")
    assert plan["anchor_deferred"] is False


def test_move_carries_both_ends_and_the_shift():
    """Панель показывает, кого и насколько сдвинет, до записи состояния."""
    subs = [
        sub("sub-main", "03:00"),
        sub("sub-eu", "03:10"),
        sub("sub-late", "06:00"),
    ]

    plan = plan_alignment(subs, now_ts=at("02:00"))

    late = next(move for move in plan["moves"] if move["id"] == "sub-late")
    assert late["tag"] == "sub-late"
    assert late["from_ts"] == at("06:00")
    assert late["to_ts"] == at("03:00")
    assert late["shift_sec"] == -3 * 3600
