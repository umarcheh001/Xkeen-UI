"""Общий срок обновления для разъехавшихся подписок.

Подписки, добавленные в разное время, созревают в разные тики планировщика, и
каждая забирает себе отдельный перезапуск ядра. Окно в
``refresh_due_subscriptions`` удерживает вместе только тех, кто уже рядом:
оно расширяет пачку на пять минут вперёд и не может свести подписки,
разошедшиеся на несколько часов.

Здесь считается, к какому моменту их свести. Модуль чистый — ни файлов, ни
сети: состояния Xray и Mihomo независимы, но правило выбора момента у них
одно, и держать его в двух копиях значит однажды поправить только одну.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List

# Полуширина окна, в пределах которого подписки считаются обновляющимися
# «в одно время». Фиксированные корзины здесь не годятся: пара сроков в двух
# минутах друг от друга, но по разные стороны отметки, попала бы в разные
# группы и развалила большинство.
ALIGN_WINDOW_SECONDS = 15 * 60

# Насколько отложить якорь, оказавшийся в прошлом. Ставить его задним числом
# нельзя: подписки стали бы просроченными в момент записи состояния.
ALIGN_MIN_LEAD_SECONDS = 60


def _timestamp(value: Any) -> float:
    try:
        ts = float(value)
    except (TypeError, ValueError):
        return 0.0
    return ts if ts > 0 else 0.0


def _candidates(subs: Iterable[Any]) -> tuple[List[Dict[str, Any]], int]:
    """Подписки с расписанием, которые вообще можно двигать."""
    picked: List[Dict[str, Any]] = []
    skipped = 0
    for item in subs or []:
        if not isinstance(item, dict):
            skipped += 1
            continue
        due_ts = _timestamp(item.get("next_update_ts"))
        if not bool(item.get("enabled", True)) or due_ts <= 0:
            skipped += 1
            continue
        picked.append(
            {
                "id": str(item.get("id") or ""),
                "tag": str(item.get("tag") or item.get("id") or ""),
                "ts": due_ts,
                "failed": item.get("last_ok") is False,
            }
        )
    return picked, skipped


def _empty_plan(reason: str, *, skipped: int = 0, total: int = 0) -> Dict[str, Any]:
    return {
        "anchor_ts": None,
        "anchor_deferred": False,
        "overdue_count": 0,
        "moves": [],
        "moved": 0,
        "max_shift_sec": 0,
        "total": total,
        "skipped": skipped,
        "reason": reason,
    }


def _anchor_from_voters(voters: List[Dict[str, Any]]) -> float:
    """Медиана самой плотной группы сроков.

    Плотность считается скользящим окном, а не раскладкой по корзинам: для
    каждого срока смотрим, сколько других укладывается в ``±окно`` от него.
    При равной плотности побеждает ранний — иначе расписание уезжало бы
    вперёд на ровном месте. Медиана берётся нижняя, поэтому якорь всегда
    совпадает с чьим-то реальным сроком, а не с усреднённым моментом.
    """
    best_neighbours: List[float] = []
    best_score = -1
    best_center = 0.0
    for voter in voters:
        neighbours = [other["ts"] for other in voters if abs(other["ts"] - voter["ts"]) <= ALIGN_WINDOW_SECONDS]
        score = len(neighbours)
        if score > best_score or (score == best_score and voter["ts"] < best_center):
            best_score = score
            best_center = voter["ts"]
            best_neighbours = neighbours
    ordered = sorted(best_neighbours)
    return ordered[(len(ordered) - 1) // 2]


def plan_alignment(subs: Iterable[Any], *, now_ts: float) -> Dict[str, Any]:
    """Посчитать общий срок и список сдвигов, ничего не записывая."""
    candidates, skipped = _candidates(subs)
    total = len(candidates)

    if total < 2:
        return _empty_plan("nothing_to_align", skipped=skipped, total=total)

    if len({item["ts"] for item in candidates}) == 1:
        plan = _empty_plan("already_aligned", skipped=skipped, total=total)
        plan["anchor_ts"] = candidates[0]["ts"]
        return plan

    # Подписка с ошибкой ждёт короткого повтора, а не своего интервала. Дать
    # ей голос значит позволить одной битой ссылке утащить пачку на свой срок;
    # переезжает она при этом вместе со всеми. Если сломались все, выбирать
    # якорь больше некому — тогда голосуют они.
    voters = [item for item in candidates if not item["failed"]] or candidates

    anchor = _anchor_from_voters(voters)
    anchor_deferred = anchor <= now_ts
    if anchor_deferred:
        anchor = float(now_ts) + ALIGN_MIN_LEAD_SECONDS

    moves: List[Dict[str, Any]] = []
    for item in candidates:
        if item["ts"] == anchor:
            continue
        moves.append(
            {
                "id": item["id"],
                "tag": item["tag"],
                "from_ts": item["ts"],
                "to_ts": anchor,
                "shift_sec": int(anchor - item["ts"]),
            }
        )

    return {
        "anchor_ts": anchor,
        "anchor_deferred": anchor_deferred,
        "overdue_count": sum(1 for item in candidates if item["ts"] <= now_ts),
        "moves": moves,
        "moved": len(moves),
        "max_shift_sec": max((abs(move["shift_sec"]) for move in moves), default=0),
        "total": total,
        "skipped": skipped,
        "reason": "",
    }


__all__ = [
    "ALIGN_MIN_LEAD_SECONDS",
    "ALIGN_WINDOW_SECONDS",
    "plan_alignment",
]
