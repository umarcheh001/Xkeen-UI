"""Small helpers for FileOps job registries.

The goal is to keep the selection/pruning logic in one place so the
manager stays readable.
"""

from __future__ import annotations

from typing import Dict, Iterable, List, Tuple


def cleanup_dead_jobs(jobs: Dict[str, object], *, ttl_seconds: int, now: float) -> List[str]:
    """Return job ids that are past TTL.

    Expects each job to have attribute `finished_ts` (float|None).
    """
    dead: List[str] = []
    for jid, j in jobs.items():
        try:
            finished = getattr(j, 'finished_ts', None)
            if finished is None:
                continue
            if (now - float(finished)) > float(ttl_seconds):
                dead.append(jid)
        except Exception:
            continue
    return dead


def oldest_finished_first(jobs: Dict[str, object]) -> List[Tuple[str, float]]:
    items: List[Tuple[str, float]] = []
    for jid, j in jobs.items():
        try:
            ts = float(getattr(j, 'finished_ts', 0) or 0)
        except Exception:
            ts = 0.0
        items.append((jid, ts))
    items.sort(key=lambda t: t[1])
    return items


__all__ = ['cleanup_dead_jobs', 'oldest_finished_first']
