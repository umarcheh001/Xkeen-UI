"""Bounded, process-local cache with single-flight loading.

The Mihomo facade is intentionally process-local: controller credentials and
targets never leave the backend and no cache entry is persisted to flash.
This module provides the small common contract used by the read-only facade
snapshots and the DNS diagnostic adapter:

* bounded LRU entries;
* TTL based freshness (``None`` means "until the key changes");
* one upstream loader for equal keys;
* hit/miss/waiter/eviction/invalidation counters;
* secret-free target/config fingerprints.

Callers must cache normalized DTOs or other redacted values, never raw
controller payloads.  The cache defensively copies values on the boundary so
one request cannot mutate a value observed by another request.
"""

from __future__ import annotations

import copy
import hashlib
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping


MIHOMO_CLASH_CACHE_SCHEMA_VERSION = 1
DEFAULT_CACHE_MAX_ENTRIES = 128


@dataclass(frozen=True)
class MihomoCacheKey:
    """Stable cache identity for one redacted Mihomo snapshot."""

    namespace: str
    target_fingerprint: str
    schema_version: int = MIHOMO_CLASH_CACHE_SCHEMA_VERSION
    config_fingerprint: str = ""
    variant: str = ""

    def as_tuple(self) -> tuple[str, str, int, str, str]:
        return (
            self.namespace,
            self.target_fingerprint,
            int(self.schema_version),
            self.config_fingerprint,
            self.variant,
        )


@dataclass(frozen=True)
class MihomoCacheLookup:
    value: Any
    hit: bool
    waited: bool


@dataclass
class _CacheEntry:
    value: Any
    expires_at: float | None
    generation: tuple[int, int]


class _Flight:
    def __init__(self, generation: tuple[int, int]):
        self.event = threading.Event()
        self.generation = generation
        self.value: Any = None
        self.error: BaseException | None = None


def _copy(value: Any) -> Any:
    """Copy cached values without imposing a serialization dependency."""

    try:
        return copy.deepcopy(value)
    except Exception:
        # DTOs should always be copyable.  Returning the original object is a
        # last-resort compatibility fallback for simple immutable fixtures.
        return value


class MihomoClashCache:
    """Thread-safe bounded LRU cache with per-key single-flight loading."""

    def __init__(
        self,
        *,
        max_entries: int = DEFAULT_CACHE_MAX_ENTRIES,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.max_entries = max(1, int(max_entries))
        self._clock = clock
        self._lock = threading.RLock()
        self._entries: OrderedDict[tuple[Any, ...], _CacheEntry] = OrderedDict()
        self._inflight: dict[tuple[Any, ...], _Flight] = {}
        self._global_generation = 0
        self._namespace_generations: dict[str, int] = {}
        self._hits = 0
        self._misses = 0
        self._waiters = 0
        self._evictions = 0
        self._invalidations = 0

    @staticmethod
    def _key_tuple(key: MihomoCacheKey | tuple[Any, ...] | str) -> tuple[Any, ...]:
        if isinstance(key, MihomoCacheKey):
            return key.as_tuple()
        if isinstance(key, tuple):
            return key
        return (str(key),)

    def fetch(
        self,
        key: MihomoCacheKey | tuple[Any, ...] | str,
        loader: Callable[[], Any],
        *,
        ttl_seconds: float | None,
    ) -> MihomoCacheLookup:
        """Return a fresh value, coalescing concurrent loads for ``key``."""

        cache_key = self._key_tuple(key)
        ttl = None if ttl_seconds is None else max(0.0, float(ttl_seconds))
        waited = False

        while True:
            with self._lock:
                now = float(self._clock())
                entry = self._entries.get(cache_key)
                if entry is not None and (
                    entry.expires_at is None or entry.expires_at > now
                ):
                    self._entries.move_to_end(cache_key)
                    self._hits += 1
                    return MihomoCacheLookup(_copy(entry.value), True, waited)
                if entry is not None:
                    self._entries.pop(cache_key, None)

                flight = self._inflight.get(cache_key)
                if flight is None:
                    self._misses += 1
                    namespace = str(cache_key[0]) if cache_key else ""
                    flight = _Flight(
                        (
                            self._global_generation,
                            self._namespace_generations.get(namespace, 0),
                        )
                    )
                    self._inflight[cache_key] = flight
                    producer = True
                else:
                    self._waiters += 1
                    producer = False

            if producer:
                break

            waited = True
            flight.event.wait()
            if flight.error is not None:
                raise flight.error
            # Prefer the entry if the producer was allowed to cache it.  If an
            # invalidation raced with the load, return the producer's value
            # once rather than starting an unbounded retry loop.
            if flight.value is not None:
                return MihomoCacheLookup(_copy(flight.value), True, True)
            return MihomoCacheLookup(None, True, True)

        try:
            value = loader()
        except BaseException as exc:
            with self._lock:
                current = self._inflight.pop(cache_key, None)
                if current is not None:
                    current.error = exc
                    current.event.set()
            raise

        with self._lock:
            current = self._inflight.pop(cache_key, None)
            # An invalidation during the upstream call means the result is
            # already stale.  Waiters still receive it once, but it is not
            # inserted into the cache.
            namespace = str(cache_key[0]) if cache_key else ""
            current_generation = (
                self._global_generation,
                self._namespace_generations.get(namespace, 0),
            )
            if current is not None and current.generation == current_generation:
                expires_at = None if ttl is None else float(self._clock()) + ttl
                self._entries[cache_key] = _CacheEntry(
                    value=_copy(value),
                    expires_at=expires_at,
                    generation=current_generation,
                )
                self._entries.move_to_end(cache_key)
                while len(self._entries) > self.max_entries:
                    self._entries.popitem(last=False)
                    self._evictions += 1
            if current is not None:
                current.value = _copy(value)
                current.event.set()
        return MihomoCacheLookup(value, False, False)

    def get_or_set(
        self,
        key: MihomoCacheKey | tuple[Any, ...] | str,
        loader: Callable[[], Any],
        *,
        ttl_seconds: float | None,
    ) -> Any:
        """Compatibility convenience returning only the cached value."""

        return self.fetch(key, loader, ttl_seconds=ttl_seconds).value

    def invalidate(
        self,
        *,
        namespaces: set[str] | frozenset[str] | tuple[str, ...] | None = None,
        target_fingerprint: str | None = None,
    ) -> int:
        """Invalidate matching entries immediately.

        The generation bump also prevents an in-flight pre-mutation result
        from being inserted after the mutation completes.
        """

        allowed = {str(item) for item in namespaces} if namespaces is not None else None
        target = str(target_fingerprint) if target_fingerprint else None
        with self._lock:
            if allowed is None and target is None:
                self._global_generation += 1
            else:
                all_keys = [*self._entries.keys(), *self._inflight.keys()]
                namespaces_to_bump = allowed or {
                    str(key[0]) for key in all_keys if key
                }
                for namespace in namespaces_to_bump:
                    self._namespace_generations[namespace] = (
                        self._namespace_generations.get(namespace, 0) + 1
                    )
            removed = 0
            for raw_key in list(self._entries):
                namespace = str(raw_key[0]) if raw_key else ""
                fingerprint = str(raw_key[1]) if len(raw_key) > 1 else ""
                if allowed is not None and namespace not in allowed:
                    continue
                if target is not None and fingerprint != target:
                    continue
                self._entries.pop(raw_key, None)
                removed += 1
            self._invalidations += removed or 1
            return removed

    def clear(self) -> int:
        return self.invalidate()

    def stats(self) -> dict[str, int]:
        with self._lock:
            return {
                "schema_version": MIHOMO_CLASH_CACHE_SCHEMA_VERSION,
                "entries": len(self._entries),
                "max_entries": self.max_entries,
                "inflight": len(self._inflight),
                "hits": self._hits,
                "misses": self._misses,
                "waiters": self._waiters,
                "evictions": self._evictions,
                "invalidations": self._invalidations,
            }


def target_fingerprint(target: Any) -> str:
    """Return a secret-free SHA-256 fingerprint for a discovered target."""

    socket_path = getattr(target, "socket_path", None)
    parts = (
        str(getattr(target, "transport", "")),
        str(getattr(target, "port", "") or ""),
        str(getattr(target, "loopback_host", "") or ""),
        str(Path(socket_path).resolve()) if socket_path else "",
        # A credential change must not reuse data fetched with the old
        # credential.  The secret is only an input to the digest.
        str(getattr(target, "secret", "") or ""),
    )
    return hashlib.sha256("|".join(parts).encode("utf-8", "replace")).hexdigest()[:32]


def config_fingerprint(path: str | Path) -> str:
    """Hash the active YAML file without retaining its content."""

    candidate = Path(path).expanduser()
    digest = hashlib.sha256()
    try:
        stat = candidate.stat()
        digest.update(str(int(stat.st_mtime_ns)).encode("ascii"))
        digest.update(b":")
        digest.update(str(int(stat.st_size)).encode("ascii"))
        with candidate.open("rb") as handle:
            while True:
                chunk = handle.read(64 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
    except (OSError, ValueError):
        digest.update(b"missing")
    return digest.hexdigest()[:32]


def build_cache_key(
    namespace: str,
    *,
    target: Any = None,
    target_fingerprint_value: str | None = None,
    config_path: str | Path | None = None,
    config_fingerprint_value: str | None = None,
    variant: str = "",
) -> MihomoCacheKey:
    """Build a key containing the required target/schema/config dimensions."""

    fingerprint = target_fingerprint_value
    if fingerprint is None:
        fingerprint = target_fingerprint(target) if target is not None else "none"
    config_hash = config_fingerprint_value
    if config_hash is None and config_path is not None:
        config_hash = config_fingerprint(config_path)
    return MihomoCacheKey(
        namespace=str(namespace or "default")[:64],
        target_fingerprint=str(fingerprint or "none")[:128],
        config_fingerprint=str(config_hash or "")[:128],
        variant=str(variant or "")[:256],
    )


_SHARED_CACHE = MihomoClashCache()


def get_shared_mihomo_clash_cache() -> MihomoClashCache:
    return _SHARED_CACHE


def invalidate_shared_mihomo_cache(
    *,
    namespaces: set[str] | frozenset[str] | tuple[str, ...] | None = None,
    target_fingerprint: str | None = None,
) -> int:
    return _SHARED_CACHE.invalidate(
        namespaces=namespaces,
        target_fingerprint=target_fingerprint,
    )


__all__ = [
    "DEFAULT_CACHE_MAX_ENTRIES",
    "MIHOMO_CLASH_CACHE_SCHEMA_VERSION",
    "MihomoCacheKey",
    "MihomoCacheLookup",
    "MihomoClashCache",
    "build_cache_key",
    "config_fingerprint",
    "get_shared_mihomo_clash_cache",
    "invalidate_shared_mihomo_cache",
    "target_fingerprint",
]
