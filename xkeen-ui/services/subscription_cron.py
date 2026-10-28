"""Calendar schedules in the router's local timezone (standard five-field cron)."""

from __future__ import annotations

import time
from datetime import datetime, timedelta
from functools import lru_cache


def _field(text: str, low: int, high: int) -> frozenset[int]:
    values = set()
    for part in text.split(","):
        base, sep, step_text = part.partition("/")
        if sep and (
            not step_text.isascii() or not step_text.isdigit() or int(step_text) <= 0
        ):
            raise ValueError("Шаг cron должен быть положительным целым числом.")
        step = int(step_text) if sep else 1
        if base == "*":
            start, end = low, high
        elif "-" in base:
            start_text, end_text = base.split("-", 1)
            if (
                not start_text.isascii()
                or not end_text.isascii()
                or not start_text.isdigit()
                or not end_text.isdigit()
            ):
                raise ValueError("Некорректный диапазон cron.")
            start, end = int(start_text), int(end_text)
        else:
            if not base.isascii() or not base.isdigit():
                raise ValueError(
                    "Cron поддерживает числа, *, списки, диапазоны и шаги."
                )
            start = int(base)
            end = high if sep else start
        if not low <= start <= end <= high:
            raise ValueError(f"Поле cron должно быть в диапазоне {low}–{high}.")
        values.update(range(start, end + 1, step))
    return frozenset(values)


@lru_cache(maxsize=128)
def parse_cron(expression: str):
    fields = str(expression or "").split()
    if len(fields) != 5:
        raise ValueError(
            "Cron: укажите пять полей — минута час день месяц день-недели."
        )
    ranges = ((0, 59), (0, 23), (1, 31), (1, 12), (0, 7))
    parsed = tuple(_field(field, *bounds) for field, bounds in zip(fields, ranges))
    return fields, parsed


def next_cron(expression: str, after: float) -> float:
    fields, (minutes, hours, days, months, weekdays) = parse_cron(expression)
    start = datetime.fromtimestamp(after).date()
    # Eight years includes leap days even when the next century is not a leap year.
    for offset in range(366 * 8 + 1):
        current = start + timedelta(days=offset)
        if current.month not in months:
            continue
        dom = current.day in days
        weekday = (current.weekday() + 1) % 7
        dow = weekday in weekdays or (weekday == 0 and 7 in weekdays)
        # Vixie cron: restricted day-of-month and day-of-week are alternatives.
        matches = (
            (dom or dow)
            if fields[2] != "*" and fields[4] != "*"
            else (dom and dow)
        )
        if not matches:
            continue
        candidates = []
        for hour in sorted(hours):
            for minute in sorted(minutes):
                expected = (current.year, current.month, current.day, hour, minute)
                for dst in (-1, 0, 1):
                    stamp = time.mktime((*expected, 0, 0, 0, dst))
                    # Reject nonexistent wall times and retain both occurrences at DST fall-back.
                    if stamp > after and time.localtime(stamp)[:5] == expected:
                        candidates.append(stamp)
        if candidates:
            return min(candidates)
    raise ValueError("Cron не имеет запуска в ближайшие восемь лет.")


def next_update(sub: dict, now: float) -> float | None:
    if not sub.get("enabled", True):
        return None
    if sub.get("schedule_mode") == "cron":
        return next_cron(str(sub.get("cron_expression") or ""), now)
    return now + int(sub.get("interval_hours") or 24) * 3600


def router_timezone() -> str:
    return " / ".join(dict.fromkeys(time.tzname))
