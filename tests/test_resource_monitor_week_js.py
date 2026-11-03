"""Окно диагностики, вкладка «7 дней»: подсказки ячеек, подписи дней и итог недели (03.11.2026).

Неделя собрана руками: история ведётся с субботы 31.10 01:56 (как на 10.1 после очистки),
до неё ячейки пустые.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
MODULE = "./xkeen-ui/static/js/features/resource_monitor/chart_data.js"

STEP = 1800
COUNT = 336
# Tue 03.11.2026 20:00 MSK: the newest column ends here.
END = 1793725200 + 3600
START = END - COUNT * STEP
SINCE = 1793400960  # Sat 31.10.2026 01:56 MSK


def run_js(body: str, data) -> object:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not available in this environment")
    script = f"""
    import * as chart from '{MODULE}';
    const data = {json.dumps(data, ensure_ascii=False)};
    const out = (() => {{ {body} }})();
    console.log(JSON.stringify(out));
    """
    env = dict(os.environ, TZ="Europe/Moscow")
    result = subprocess.run(
        [node, "--input-type=module", "-e", script],
        cwd=ROOT,
        check=True,
        capture_output=True,
        encoding="utf-8",
        env=env,
    )
    return json.loads(result.stdout)


def week(zones: dict[str, dict[int, int]] | None = None, peaks: set[int] | None = None) -> dict:
    """A week of history: every metric at zone 0 since SINCE, unless ``zones`` says otherwise."""
    zones = zones or {}
    peaks = peaks or set()
    first = (SINCE - START) // STEP + 1

    def metric(name: str) -> dict:
        zone = [None if i < first else zones.get(name, {}).get(i, 0) for i in range(COUNT)]
        peak = [None if z is None else (2 if (name == "cpu" and i in peaks) else z) for i, z in enumerate(zone)]
        avg = [None if z is None else 10 for z in zone]
        return {"avg": avg, "max": avg, "zone": zone, "peak_zone": peak}

    return {
        "step_s": STEP,
        "start": START,
        "history_since": SINCE,
        "metrics": {name: metric(name) for name in ("cpu", "memory", "queue", "link_down:ISP")},
        "links": [{"id": "ISP", "label": "МТС"}],
        "top": [],
    }


def column_of(ts: int) -> int:
    return (ts - START) // STEP


CELL = """
const model = chart.grid7Model(data.history, data.metric || 'all', null);
return data.cells.map(([row, column]) => chart.grid7CellText(model, data.history, row, column));
"""


def test_a_cell_in_the_norm_says_so_without_a_worst_metric():
    # Monday 02.11 10:00 is row 1 (yesterday), column 20.
    out = run_js(CELL, {"history": week(), "cells": [[1, 20]]})
    assert out == ["Всё в норме"]


def test_a_loaded_cell_names_every_metric_of_its_zone():
    at = column_of(1793602800)  # Mon 02.11 10:00 MSK
    hist = week({"cpu": {at: 1}, "link_down:ISP": {at: 1}, "memory": {at + 1: 2}})
    out = run_js(CELL, {"history": hist, "cells": [[1, 20], [1, 21]]})
    assert out == ["Высокая нагрузка: процессор, канал", "Перегрузка: память"]


def test_a_single_metric_keeps_the_name_of_its_zone():
    out = run_js(CELL, {"history": week(), "metric": "cpu", "cells": [[1, 20]]})
    assert out == ["норма"]


def test_an_empty_cell_before_the_history_tells_when_it_began():
    # Saturday 31.10 (row 3): 00:00 is before the history, later cells are inside it.
    hist = week()
    gap = column_of(1793602800)
    hist["metrics"] = {name: {**m, "zone": [None if i == gap else z for i, z in enumerate(m["zone"])]} for name, m in hist["metrics"].items()}
    out = run_js(CELL, {"history": hist, "cells": [[3, 0], [1, 20]]})
    assert out == ["История ведётся с 31.10 01:56", "нет данных"]


def test_days_before_the_history_are_named_without_a_suffix():
    out = run_js("return chart.grid7Model(data.history, 'all', null).rows.map((r) => r.label);", {"history": week()})
    assert out[:4] == ["Сегодня", "Вчера", "вс, 01.11", "сб, 31.10"]
    # Before the history: just the day, the cells and their hint tell the rest.
    assert out[4:] == ["пт, 30.10", "чт, 29.10", "ср, 28.10"]


def test_a_day_without_data_inside_the_history_keeps_its_suffix():
    hist = week()
    lo, hi = column_of(1793480400), column_of(1793480400 + 86400)  # Sun 01.11 00:00 .. 24:00 MSK
    hist["metrics"] = {name: {**m, "zone": [None if lo <= i < hi else z for i, z in enumerate(m["zone"])]} for name, m in hist["metrics"].items()}
    out = run_js("return chart.grid7Model(data.history, 'all', null).rows.map((r) => r.label);", {"history": hist})
    assert out[2] == "вс, 01.11 · нет данных"


SUMMARY = """
const model = chart.grid7Model(data.history, 'all', null);
return chart.grid7Summary(model, data.history);
"""


def test_a_week_in_the_norm_has_no_heaviest_hour_and_counts_its_short_peaks():
    peaks = {column_of(1793602800), column_of(1793602800 + 3 * STEP), column_of(1793602800 + 30 * STEP)}
    out = run_js(SUMMARY, {"history": week(peaks=peaks)})
    assert out["heavy"] is None
    assert out["peaks"] == 3


def test_the_heaviest_hour_is_the_one_with_the_worst_zone():
    at = column_of(1793602800)
    out = run_js(SUMMARY, {"history": week({"cpu": {at: 1}}, peaks={at + 5})})
    assert out["heavy"] == "пн, 02.11, 10:00–10:30"


def test_the_start_of_the_history_names_its_day_when_it_is_not_today():
    body = ("const today = { ...data.history, history_since: data.today };"
            "return [chart.historySinceText(data.history, data.now), chart.historySinceText(today, data.now)];")
    out = run_js(body, {"history": {"start": START, "step_s": STEP, "history_since": SINCE}, "today": 1793687760, "now": END})
    assert out == ["история с 31.10 01:56", "история с 09:36"]
