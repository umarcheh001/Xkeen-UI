from __future__ import annotations

import sys

from services.cache_size import cache_value_size
from services.geodat import cache as geodat
from services import mihomo_rule_provider_inspector as inspector


def test_size_estimator_counts_nested_data_and_rejects_unknown_objects():
    value = {"items": ["a" * 100, "b" * 100]}
    assert cache_value_size(value, 10_000) > sys.getsizeof(value)
    assert cache_value_size(value, 1) > 1
    assert cache_value_size(object(), 10_000) > 10_000


def test_geodat_budget_evicts_least_recently_used_entry(monkeypatch):
    geodat.clear_geodat_cache()
    payload = {"items": ["x" * 100]}
    sizes = [cache_value_size(((key,), payload), 10_000) for key in "abc"]
    limit = sum(sorted(sizes, reverse=True)[:2])
    monkeypatch.setattr(geodat, "MAX_GEODAT_CACHE_BYTES", limit)
    try:
        geodat._geodat_cache_set(("a",), payload, 60)
        geodat._geodat_cache_set(("b",), payload, 60)
        assert geodat._geodat_cache_get(("a",), 60) is payload
        geodat._geodat_cache_set(("c",), payload, 60)
        assert geodat._geodat_cache_get(("b",), 60) is None
        assert geodat._geodat_cache_get(("a",), 60) is payload
        assert geodat._GEODAT_CACHE_BYTES <= limit
    finally:
        geodat.clear_geodat_cache()


def test_geodat_expiry_uses_each_entrys_own_ttl(monkeypatch):
    geodat.clear_geodat_cache()
    now = [100.0]
    monkeypatch.setattr(geodat.time, "time", lambda: now[0])
    try:
        geodat._geodat_cache_set(("long",), {"ok": True}, 60)
        geodat._geodat_cache_set(("short",), {"ok": True}, 1)
        now[0] += 2
        geodat._geodat_cache_set(("new",), {"ok": True}, 1)
        assert geodat._geodat_cache_get(("long",), 60) == {"ok": True}
        assert geodat._geodat_cache_get(("short",), 60) is None
        assert len(geodat._GEODAT_CACHE) == 2
    finally:
        geodat.clear_geodat_cache()


def test_geodat_oversize_payload_is_returned_but_not_cached(monkeypatch):
    geodat.clear_geodat_cache()
    monkeypatch.setattr(geodat, "MAX_GEODAT_CACHE_BYTES", 1)
    payload = {"items": ["large"]}
    geodat._geodat_cache_set(("large",), payload, 60)
    assert geodat._geodat_cache_get(("large",), 60) is None
    assert geodat._GEODAT_CACHE_BYTES == 0


def test_rule_provider_budget_preserves_recent_entry(monkeypatch):
    inspector.clear_rule_provider_inspector_cache()
    rules = inspector._CachedRules(("rule" * 50,), 1, False, 200, None)
    per_entry = sys.getsizeof(rules) + cache_value_size((("a",), rules.rules), 10_000)
    monkeypatch.setattr(inspector, "MAX_CACHE_BYTES", per_entry * 2)
    try:
        inspector._cache_put(("a",), rules)
        inspector._cache_put(("b",), rules)
        assert inspector._cache_get(("a",)) is rules
        inspector._cache_put(("c",), rules)
        assert inspector._cache_get(("b",)) is None
        assert inspector._cache_get(("a",)) is rules
        assert inspector._cache_bytes <= inspector.MAX_CACHE_BYTES
        monkeypatch.setattr(inspector, "MAX_CACHE_BYTES", 1)
        inspector._cache_put(("large",), rules)
        assert inspector._cache_get(("large",)) is None
    finally:
        inspector.clear_rule_provider_inspector_cache()


def test_trace_cache_also_has_byte_budget(monkeypatch):
    inspector.clear_rule_provider_inspector_cache()
    monkeypatch.setattr(inspector, "MAX_TRACE_MATCH_CACHE_BYTES", 1)
    inspector._trace_match_cache_put(("domain",), ("match", "reason"))
    assert inspector._trace_match_cache_get(("domain",)) is None
    assert inspector._trace_match_cache_bytes == 0
