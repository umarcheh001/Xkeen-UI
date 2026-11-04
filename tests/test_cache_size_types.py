"""Оценщик объёма кэшей: подклассы встроенных типов и громкий отказ (04.11.2026).

`cache_value_size` сверял тип строго, и `OrderedDict`, `defaultdict` или
namedtuple считались «неизвестными» — больше любого лимита: значение отдавалось,
но молча не кэшировалось. Теперь подклассы встроенных типов меряются как сами
типы, а значение, которое померить нельзя (datetime, Path, dataclass), по-прежнему
не кэшируется, но один раз на тип пишет об этом в журнал панели.
"""

from __future__ import annotations

import collections
import dataclasses
import datetime
import enum
import pathlib
import sys
from pathlib import Path

import pytest

APP_DIR = Path(__file__).resolve().parents[1] / "xkeen-ui"
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

import core.logging as core_logging  # noqa: E402
from services.cache_size import cache_value_size  # noqa: E402
from services.mihomo_clash_cache import MihomoClashCache  # noqa: E402

LIMIT = 1024 * 1024


class Mode(str, enum.Enum):
    AUTO = "auto"


class Plain(enum.Enum):
    ONE = 1


@dataclasses.dataclass
class Group:
    name: str


Point = collections.namedtuple("Point", "x y")


@pytest.fixture()
def logged(monkeypatch):
    calls: list[tuple] = []
    monkeypatch.setattr(core_logging, "core_log_once", lambda level, key, msg, **extra: calls.append((level, key, msg, extra)))
    return calls


@pytest.mark.parametrize(
    "value",
    [
        collections.OrderedDict(name="proxy", items=["a" * 50]),
        collections.defaultdict(list, {"a": ["b" * 50]}),
        {"point": Point(1, "x" * 50)},
        {"mode": Mode.AUTO},
    ],
    ids=["OrderedDict", "defaultdict", "namedtuple", "str-enum"],
)
def test_subclasses_of_builtin_types_are_measured(value, logged):
    size = cache_value_size(value, LIMIT)
    assert 0 < size <= LIMIT
    # the nested text is counted, not only the outer object
    assert size > 50
    assert logged == []


@pytest.mark.parametrize(
    "value, name",
    [
        ({"updated_at": datetime.datetime(2026, 11, 4)}, "datetime.datetime"),
        ({"path": pathlib.PurePosixPath("/opt/etc/xray/dat/geosite.dat")}, "pathlib.PurePosixPath"),
        ({"group": Group("auto")}, f"{__name__}.Group"),
        ({"mode": Plain.ONE}, f"{__name__}.Plain"),
    ],
    ids=["datetime", "Path", "dataclass", "enum"],
)
def test_an_unmeasurable_value_is_refused_and_reported(value, name, logged):
    assert cache_value_size(value, LIMIT) > LIMIT
    assert len(logged) == 1
    level, key, msg, extra = logged[0]
    assert level == "warning"
    assert msg == "cache.unmeasurable_value"
    assert extra["type"] == name
    # once per type: the key carries the type, the helper keeps it from repeating
    assert name in key


def test_the_shared_cache_keeps_an_ordered_dict(logged):
    cache = MihomoClashCache()
    value = collections.OrderedDict(name="proxy")
    cache.get_or_set("k", lambda: value, ttl_seconds=60)
    assert cache.fetch("k", lambda: pytest.fail("not cached"), ttl_seconds=60).hit
    assert cache.stats()["skipped_oversize"] == 0
