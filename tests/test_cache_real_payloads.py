"""Настоящие ответы, которые панель кэширует, должны помещаться в кэш (04.11.2026).

Оценщик объёма `cache_value_size` не умеет мерить объекты не из встроенных
типов и считает их больше любого лимита: такое значение отдаётся, но молча не
кэшируется. Пока в кэши Mihomo и DAT кладутся только словари, списки, строки и
числа, всё в порядке; этот тест ловит день, когда в ответ попадёт dataclass,
datetime или Path, и кэш тихо перестанет работать.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "xkeen-ui"
FIXTURES = ROOT / "tests" / "fixtures" / "mihomo_clash"

if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from services.cache_size import cache_value_size  # noqa: E402
from services.geodat import cache as geodat  # noqa: E402
from services.mihomo_clash_cache import DEFAULT_CACHE_MAX_BYTES, MihomoClashCache  # noqa: E402
from services.mihomo_clash_dto import (  # noqa: E402
    build_mihomo_clash_providers_dto,
    build_mihomo_clash_proxy_groups_dto,
    build_mihomo_clash_rules_dto,
)


def fixture(name: str):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def _mihomo_payloads() -> dict[str, dict]:
    return {
        "groups": build_mihomo_clash_proxy_groups_dto(fixture("proxies.json"), fixture("providers-proxies.json")),
        "rules": build_mihomo_clash_rules_dto(fixture("rules.json")),
        "providers": build_mihomo_clash_providers_dto(fixture("providers-proxies.json"), fixture("providers-rules.json")),
    }


def test_mihomo_dtos_are_measured_not_rejected():
    for name, dto in _mihomo_payloads().items():
        dto["telemetry"] = {"elapsed_ms": 12.5, "size_bytes": 4096}
        size = cache_value_size(dto, DEFAULT_CACHE_MAX_BYTES)
        assert 0 < size <= DEFAULT_CACHE_MAX_BYTES, name


def test_mihomo_dtos_are_kept_by_the_shared_cache():
    cache = MihomoClashCache()
    for name, dto in _mihomo_payloads().items():
        cache.get_or_set(name, lambda dto=dto: dto, ttl_seconds=60)
    stats = cache.stats()
    assert stats["entries"] == 3
    assert stats["skipped_oversize"] == 0


def test_a_geodat_answer_is_kept_by_its_cache():
    geodat.clear_geodat_cache()
    try:
        key = ("tags", "geosite", "/opt/etc/xray/dat/geosite.dat", 1048576, 1793725200)
        payload = {
            "ok": True,
            "kind": "geosite",
            "path": "/opt/etc/xray/dat/geosite.dat",
            "meta": {"size": 1048576, "mtime": 1793725200},
            "tags": [{"tag": "google", "count": 12}, {"tag": "youtube", "count": 4}],
        }
        geodat._geodat_cache_set(key, payload, 60)
        assert geodat._geodat_cache_get(key, 60) is payload
    finally:
        geodat.clear_geodat_cache()
