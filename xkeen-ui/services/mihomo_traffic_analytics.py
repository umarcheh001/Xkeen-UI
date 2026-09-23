"""Bounded local traffic accounting built from Mihomo and Keenetic snapshots.

The collector deliberately keeps two sources separate:

* Mihomo ``/connections`` deltas provide device, rule, route, selected node and
  requested host attribution.
* Keenetic client counters provide the all-traffic envelope.  The positive
  remainder after subtracting Mihomo-observed bytes is labelled
  ``outside_estimated`` because it may also contain LAN/local traffic.

No packet payloads, URLs or controller credentials are persisted.  The store
contains minute aggregates only and is retained for a bounded seven-day
window.
"""

from __future__ import annotations

import os
import sqlite3
import threading
import time
from collections import defaultdict
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any


TRAFFIC_ANALYTICS_SCHEMA_VERSION = 1
DEFAULT_SAMPLE_INTERVAL_SECONDS = 10.0
DEFAULT_CLIENT_INTERVAL_SECONDS = 30.0
DEFAULT_RETENTION_SECONDS = 7 * 24 * 60 * 60
BUCKET_SECONDS = 5 * 60
FLUSH_SECONDS = 60
MAX_CONNECTIONS = 1000
MAX_ROUTE_ROWS_PER_BUCKET = 64
MAX_RESOURCE_ROWS_PER_BUCKET = 32
MAX_RESOURCE_NAME_CHARS = 253


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _text(value: Any, limit: int = 256) -> str:
    if value is None or isinstance(value, (dict, list, tuple, set, bool)):
        return ""
    return str(value).replace("\x00", "").strip()[:limit]


def _counter(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError, OverflowError):
        return 0


def _total_row(
    *,
    bucket: int,
    device_ip: str,
    device_name: str,
    download: int,
    upload: int,
    outside_download: int,
    outside_upload: int,
    samples: int,
    mihomo_download: int,
    mihomo_upload: int,
) -> tuple[Any, ...]:
    return (
        int(bucket),
        str(device_ip),
        str(device_name),
        _counter(download),
        _counter(upload),
        _counter(outside_download),
        _counter(outside_upload),
        _counter(samples),
        _counter(mihomo_download),
        _counter(mihomo_upload),
    )


def _bucket(timestamp: float | int) -> int:
    value = max(0, int(timestamp))
    return value - value % BUCKET_SECONDS


def _device(connection: Mapping[str, Any]) -> tuple[str, str]:
    metadata = _mapping(connection.get("metadata"))
    address = _text(metadata.get("source_ip"), 64)
    name = _text(metadata.get("source_name"), 96)
    return address or "unknown", name or address or "Неизвестное устройство"


def _route(connection: Mapping[str, Any]) -> tuple[str, str]:
    raw_chain = connection.get("chains")
    chain = (
        [_text(item, 256) for item in raw_chain[:32] if _text(item, 256)]
        if isinstance(raw_chain, Sequence) and not isinstance(raw_chain, (str, bytes, bytearray))
        else []
    )
    if not chain:
        return "Не определено", "Не определено"
    node = chain[-1]
    route = chain[0] if len(chain) > 1 else node
    return route, node


def _resource(connection: Mapping[str, Any]) -> str:
    metadata = _mapping(connection.get("metadata"))
    value = (
        _text(metadata.get("sniff_host"), MAX_RESOURCE_NAME_CHARS)
        or _text(metadata.get("host"), MAX_RESOURCE_NAME_CHARS)
        or _text(metadata.get("destination_ip"), 64)
    )
    return value or "Не определено"


class MihomoTrafficAnalyticsCollector:
    """One lightweight sampler and minute-aggregate SQLite store."""

    def __init__(
        self,
        *,
        db_path: str,
        connections_factory: Callable[[], Mapping[str, Any]],
        clients_factory: Callable[[], Mapping[str, Any]],
        sample_interval_seconds: float = DEFAULT_SAMPLE_INTERVAL_SECONDS,
        client_interval_seconds: float = DEFAULT_CLIENT_INTERVAL_SECONDS,
        retention_seconds: int = DEFAULT_RETENTION_SECONDS,
        clock: Callable[[], float] = time.time,
    ):
        self.db_path = str(db_path)
        self.connections_factory = connections_factory
        self.clients_factory = clients_factory
        self.sample_interval_seconds = max(2.0, min(60.0, float(sample_interval_seconds)))
        self.client_interval_seconds = max(
            self.sample_interval_seconds,
            min(300.0, float(client_interval_seconds)),
        )
        self.retention_seconds = max(3600, min(DEFAULT_RETENTION_SECONDS, int(retention_seconds)))
        self.clock = clock
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._started_at = 0
        self._last_sample_at = 0
        self._last_client_at = 0.0
        self._last_flush_at = 0.0
        self._last_prune_at = 0.0
        self._last_error = ""
        self._client_state = "waiting"
        self._connection_error = ""
        self._client_error = ""
        self._connection_samples = 0
        self._connection_errors = 0
        self._client_samples = 0
        self._client_errors = 0
        self._connection_truncated_samples = 0
        self._last_connection_success_at = 0
        self._last_client_success_at = 0
        self._connections_initialized = False
        self._clients_initialized = False
        self._previous_connections: dict[str, tuple[int, int]] = {}
        self._previous_clients: dict[str, tuple[int, int]] = {}
        self._mihomo_since_clients: dict[str, list[int]] = defaultdict(lambda: [0, 0])
        self._pending_routes: dict[tuple[int, str, str, str, str], list[int]] = defaultdict(
            lambda: [0, 0]
        )
        self._pending_resources: dict[
            tuple[int, str, str, str, str], list[int]
        ] = defaultdict(lambda: [0, 0])
        self._pending_totals: dict[tuple[int, str, str], list[int]] = defaultdict(
            lambda: [0, 0, 0, 0, 0, 0, 0]
        )
        self._init_db()

    @property
    def running(self) -> bool:
        with self._lock:
            return bool(self._thread and self._thread.is_alive())

    def start(self) -> None:
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._stop.clear()
            if not self._started_at:
                self._started_at = int(self.clock())
            self._thread = threading.Thread(
                target=self._loop,
                name="mihomo-traffic-analytics",
                daemon=True,
            )
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread and thread is not threading.current_thread():
            thread.join(timeout=2.0)
        self._flush_pending()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=3.0)
        connection.execute("PRAGMA busy_timeout=3000")
        connection.execute("PRAGMA synchronous=NORMAL")
        try:
            connection.execute("PRAGMA journal_mode=WAL")
        except sqlite3.DatabaseError:
            pass
        for suffix in ("", "-wal", "-shm"):
            try:
                os.chmod(f"{self.db_path}{suffix}", 0o600)
            except OSError:
                pass
        return connection

    def _init_db(self) -> None:
        path = Path(self.db_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS traffic_route (
                    bucket INTEGER NOT NULL,
                    device_ip TEXT NOT NULL,
                    device_name TEXT NOT NULL,
                    route TEXT NOT NULL,
                    node TEXT NOT NULL,
                    download INTEGER NOT NULL,
                    upload INTEGER NOT NULL,
                    PRIMARY KEY (bucket, device_ip, route, node)
                );
                CREATE TABLE IF NOT EXISTS traffic_resource (
                    bucket INTEGER NOT NULL,
                    device_ip TEXT NOT NULL,
                    device_name TEXT NOT NULL,
                    resource TEXT NOT NULL,
                    route TEXT NOT NULL,
                    download INTEGER NOT NULL,
                    upload INTEGER NOT NULL,
                    PRIMARY KEY (bucket, device_ip, resource, route)
                );
                CREATE TABLE IF NOT EXISTS traffic_total (
                    bucket INTEGER NOT NULL,
                    device_ip TEXT NOT NULL,
                    device_name TEXT NOT NULL,
                    download INTEGER NOT NULL,
                    upload INTEGER NOT NULL,
                    outside_download INTEGER NOT NULL,
                    outside_upload INTEGER NOT NULL,
                    samples INTEGER NOT NULL,
                    mihomo_download INTEGER NOT NULL DEFAULT 0,
                    mihomo_upload INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (bucket, device_ip)
                );
                CREATE INDEX IF NOT EXISTS traffic_route_bucket_idx
                    ON traffic_route(bucket);
                CREATE INDEX IF NOT EXISTS traffic_resource_bucket_idx
                    ON traffic_resource(bucket);
                CREATE INDEX IF NOT EXISTS traffic_total_bucket_idx
                    ON traffic_total(bucket);
                """
            )
            columns = {
                str(row[1])
                for row in connection.execute("PRAGMA table_info(traffic_total)").fetchall()
            }
            if "mihomo_download" not in columns:
                connection.execute(
                    "ALTER TABLE traffic_total ADD COLUMN mihomo_download INTEGER NOT NULL DEFAULT 0"
                )
            if "mihomo_upload" not in columns:
                connection.execute(
                    "ALTER TABLE traffic_total ADD COLUMN mihomo_upload INTEGER NOT NULL DEFAULT 0"
                )
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass

    def _loop(self) -> None:
        while not self._stop.is_set():
            started = self.clock()
            try:
                self._sample_connections(started)
            except Exception as exc:  # noqa: BLE001 - collector must survive source outages
                self._record_source_error("connections", exc)
            if started - self._last_client_at >= self.client_interval_seconds:
                try:
                    self._sample_clients(started)
                except Exception as exc:  # noqa: BLE001 - collector must survive source outages
                    self._record_source_error("clients", exc)
                self._last_client_at = started
            if started - self._last_flush_at >= FLUSH_SECONDS:
                self._flush_pending()
                self._last_flush_at = started
            if started - self._last_prune_at >= 3600:
                self._prune(int(started))
                self._last_prune_at = started
            elapsed = max(0.0, self.clock() - started)
            self._stop.wait(max(0.2, self.sample_interval_seconds - elapsed))

    def _record_source_error(self, source: str, exc: Exception) -> None:
        message = str(exc or "sample_failed")[:160]
        with self._lock:
            if source == "connections":
                self._connection_errors += 1
                self._connection_error = message
            else:
                self._client_errors += 1
                self._client_error = message
                self._client_state = "error"
            self._last_error = self._connection_error or self._client_error

    def _sample_connections(self, now: float) -> None:
        payload = self.connections_factory()
        raw_connections = payload.get("connections") if isinstance(payload, Mapping) else None
        source_count = (
            len(raw_connections)
            if isinstance(raw_connections, Sequence)
            and not isinstance(raw_connections, (str, bytes, bytearray))
            else 0
        )
        rows = (
            list(raw_connections[:MAX_CONNECTIONS])
            if isinstance(raw_connections, Sequence)
            and not isinstance(raw_connections, (str, bytes, bytearray))
            else []
        )
        current: dict[str, tuple[int, int]] = {}
        bucket = _bucket(now)
        first_sample = not self._connections_initialized
        for raw in rows:
            connection = _mapping(raw)
            connection_id = _text(connection.get("id"), 160)
            if not connection_id:
                continue
            download = _counter(connection.get("download"))
            upload = _counter(connection.get("upload"))
            current[connection_id] = (download, upload)
            previous = self._previous_connections.get(connection_id)
            if first_sample:
                delta_download = 0
                delta_upload = 0
            elif previous is None:
                delta_download = download
                delta_upload = upload
            else:
                delta_download = download - previous[0] if download >= previous[0] else download
                delta_upload = upload - previous[1] if upload >= previous[1] else upload
            if not delta_download and not delta_upload:
                continue
            device_ip, device_name = _device(connection)
            route, node = _route(connection)
            resource = _resource(connection)
            route_key = (bucket, device_ip, device_name, route, node)
            resource_key = (bucket, device_ip, device_name, resource, route)
            with self._lock:
                route_value = self._pending_routes[route_key]
                route_value[0] += delta_download
                route_value[1] += delta_upload
                resource_value = self._pending_resources[resource_key]
                resource_value[0] += delta_download
                resource_value[1] += delta_upload
                device_value = self._mihomo_since_clients[device_ip]
                device_value[0] += delta_download
                device_value[1] += delta_upload
                total_value = self._pending_totals[(bucket, device_ip, device_name)]
                total_value[5] += delta_download
                total_value[6] += delta_upload
        with self._lock:
            self._previous_connections = current
            self._connections_initialized = True
            self._connection_samples += 1
            self._last_connection_success_at = int(now)
            self._last_sample_at = int(now)
            self._connection_error = ""
            if source_count > MAX_CONNECTIONS:
                self._connection_truncated_samples += 1
            self._last_error = self._client_error

    def _sample_clients(self, now: float) -> None:
        payload = self.clients_factory()
        items = payload.get("items") if isinstance(payload, Mapping) else None
        rows = (
            list(items[:128])
            if isinstance(items, Sequence) and not isinstance(items, (str, bytes, bytearray))
            else []
        )
        current: dict[str, tuple[int, int]] = {}
        bucket = _bucket(now)
        available = bool(payload.get("available")) if isinstance(payload, Mapping) else False
        if not available or not rows:
            with self._lock:
                self._client_state = "unavailable"
                self._client_samples += 1
                self._last_client_success_at = int(now)
                self._last_sample_at = int(now)
                self._client_error = ""
                self._last_error = self._connection_error
            return
        with self._lock:
            pending_mihomo = {
                key: tuple(value) for key, value in self._mihomo_since_clients.items()
            }
        for raw in rows:
            item = _mapping(raw)
            device_ip = _text(item.get("ip"), 64)
            if not device_ip:
                continue
            device_name = _text(item.get("name"), 96) or device_ip
            download = _counter(item.get("received_bytes"))
            upload = _counter(item.get("sent_bytes"))
            current[device_ip] = (download, upload)
            previous = self._previous_clients.get(device_ip)
            if previous is None:
                continue
            delta_download = download - previous[0] if download >= previous[0] else 0
            delta_upload = upload - previous[1] if upload >= previous[1] else 0
            mihomo_download, mihomo_upload = pending_mihomo.get(device_ip, (0, 0))
            outside_download = max(0, delta_download - mihomo_download)
            outside_upload = max(0, delta_upload - mihomo_upload)
            if not any((delta_download, delta_upload, outside_download, outside_upload)):
                continue
            key = (bucket, device_ip, device_name)
            with self._lock:
                value = self._pending_totals[key]
                value[0] += delta_download
                value[1] += delta_upload
                value[2] += outside_download
                value[3] += outside_upload
                value[4] += 1
        with self._lock:
            for device_ip in current:
                self._mihomo_since_clients.pop(device_ip, None)
            self._previous_clients = current
            self._clients_initialized = True
            self._client_state = "available" if available and current else "unavailable"
            self._client_samples += 1
            self._last_client_success_at = int(now)
            self._last_sample_at = int(now)
            self._client_error = ""
            self._last_error = self._connection_error

    @staticmethod
    def _top_rows(
        values: dict[tuple[Any, ...], list[int]],
        *,
        per_bucket: int,
    ) -> list[tuple[tuple[Any, ...], list[int]]]:
        grouped: dict[int, list[tuple[tuple[Any, ...], list[int]]]] = defaultdict(list)
        for key, value in values.items():
            grouped[int(key[0])].append((key, value))
        result: list[tuple[tuple[Any, ...], list[int]]] = []
        for rows in grouped.values():
            rows.sort(key=lambda item: item[1][0] + item[1][1], reverse=True)
            result.extend(rows[:per_bucket])
        return result

    def _flush_pending(self) -> None:
        with self._lock:
            routes = dict(self._pending_routes)
            resources = dict(self._pending_resources)
            totals = dict(self._pending_totals)
            self._pending_routes.clear()
            self._pending_resources.clear()
            self._pending_totals.clear()
        if not routes and not resources and not totals:
            return
        route_rows = self._top_rows(routes, per_bucket=MAX_ROUTE_ROWS_PER_BUCKET)
        resource_rows = self._top_rows(resources, per_bucket=MAX_RESOURCE_ROWS_PER_BUCKET)
        with self._connect() as connection:
            connection.executemany(
                """
                INSERT INTO traffic_route
                    (bucket, device_ip, device_name, route, node, download, upload)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(bucket, device_ip, route, node) DO UPDATE SET
                    device_name=excluded.device_name,
                    download=traffic_route.download + excluded.download,
                    upload=traffic_route.upload + excluded.upload
                """,
                [(*key, value[0], value[1]) for key, value in route_rows],
            )
            connection.executemany(
                """
                INSERT INTO traffic_resource
                    (bucket, device_ip, device_name, resource, route, download, upload)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(bucket, device_ip, resource, route) DO UPDATE SET
                    device_name=excluded.device_name,
                    download=traffic_resource.download + excluded.download,
                    upload=traffic_resource.upload + excluded.upload
                """,
                [(*key, value[0], value[1]) for key, value in resource_rows],
            )
            connection.executemany(
                """
                INSERT INTO traffic_total
                    (bucket, device_ip, device_name, download, upload,
                     outside_download, outside_upload, samples,
                     mihomo_download, mihomo_upload)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(bucket, device_ip) DO UPDATE SET
                    device_name=excluded.device_name,
                    download=traffic_total.download + excluded.download,
                    upload=traffic_total.upload + excluded.upload,
                    outside_download=traffic_total.outside_download + excluded.outside_download,
                    outside_upload=traffic_total.outside_upload + excluded.outside_upload,
                    samples=traffic_total.samples + excluded.samples,
                    mihomo_download=traffic_total.mihomo_download + excluded.mihomo_download,
                    mihomo_upload=traffic_total.mihomo_upload + excluded.mihomo_upload
                """,
                [
                    (*key, value[0], value[1], value[2], value[3], value[4], value[5], value[6])
                    for key, value in totals.items()
                ],
            )
            for bucket in {int(key[0]) for key, _value in route_rows}:
                connection.execute(
                    """
                    DELETE FROM traffic_route
                    WHERE bucket = ? AND rowid NOT IN (
                        SELECT rowid FROM traffic_route
                        WHERE bucket = ?
                        ORDER BY download + upload DESC
                        LIMIT ?
                    )
                    """,
                    (bucket, bucket, MAX_ROUTE_ROWS_PER_BUCKET),
                )
            for bucket in {int(key[0]) for key, _value in resource_rows}:
                connection.execute(
                    """
                    DELETE FROM traffic_resource
                    WHERE bucket = ? AND rowid NOT IN (
                        SELECT rowid FROM traffic_resource
                        WHERE bucket = ?
                        ORDER BY download + upload DESC
                        LIMIT ?
                    )
                    """,
                    (bucket, bucket, MAX_RESOURCE_ROWS_PER_BUCKET),
                )

    def _prune(self, now: int) -> None:
        cutoff = _bucket(now - self.retention_seconds)
        try:
            with self._connect() as connection:
                for table in ("traffic_route", "traffic_resource", "traffic_total"):
                    connection.execute(f"DELETE FROM {table} WHERE bucket < ?", (cutoff,))
        except sqlite3.DatabaseError:
            return

    def _pending_snapshot(self, start: int) -> tuple[list[tuple], list[tuple], list[tuple]]:
        with self._lock:
            routes = [
                (*key, value[0], value[1])
                for key, value in self._pending_routes.items()
                if key[0] >= start
            ]
            resources = [
                (*key, value[0], value[1])
                for key, value in self._pending_resources.items()
                if key[0] >= start
            ]
            totals = [
                _total_row(
                    bucket=key[0],
                    device_ip=key[1],
                    device_name=key[2],
                    download=value[0],
                    upload=value[1],
                    outside_download=value[2],
                    outside_upload=value[3],
                    samples=value[4],
                    mihomo_download=value[5],
                    mihomo_upload=value[6],
                )
                for key, value in self._pending_totals.items()
                if key[0] >= start
            ]
        return routes, resources, totals

    def summary(self, *, range_seconds: int) -> dict[str, Any]:
        now = int(self.clock())
        seconds = max(15 * 60, min(self.retention_seconds, int(range_seconds)))
        start = _bucket(now - seconds)
        with self._connect() as connection:
            route_rows = connection.execute(
                """
                SELECT bucket, device_ip, device_name, route, node, download, upload
                FROM traffic_route WHERE bucket >= ?
                """,
                (start,),
            ).fetchall()
            resource_rows = connection.execute(
                """
                SELECT bucket, device_ip, device_name, resource, route, download, upload
                FROM traffic_resource WHERE bucket >= ?
                """,
                (start,),
            ).fetchall()
            total_rows = connection.execute(
                """
                SELECT bucket, device_ip, device_name, download, upload,
                       outside_download, outside_upload, samples,
                       mihomo_download, mihomo_upload
                FROM traffic_total WHERE bucket >= ?
                """,
                (start,),
            ).fetchall()
        pending_routes, pending_resources, pending_totals = self._pending_snapshot(start)
        route_rows.extend(pending_routes)
        resource_rows.extend(pending_resources)
        total_rows.extend(pending_totals)
        total_mihomo_keys = {
            (int(row[0]), str(row[1]))
            for row in total_rows
            if len(row) >= 10 and (_counter(row[8]) or _counter(row[9]))
        }

        series: dict[int, dict[str, int]] = defaultdict(
            lambda: {"mihomo_download": 0, "mihomo_upload": 0, "outside_download": 0, "outside_upload": 0}
        )
        devices: dict[str, dict[str, Any]] = {}
        routes: dict[tuple[str, str], dict[str, Any]] = {}
        resources: dict[str, dict[str, Any]] = {}

        for bucket, device_ip, device_name, route, node, download, upload in route_rows:
            down, up = _counter(download), _counter(upload)
            if (int(bucket), str(device_ip)) not in total_mihomo_keys:
                series[int(bucket)]["mihomo_download"] += down
                series[int(bucket)]["mihomo_upload"] += up
            device = devices.setdefault(
                str(device_ip),
                {
                    "ip": str(device_ip),
                    "name": str(device_name or device_ip),
                    "mihomo_download": 0,
                    "mihomo_upload": 0,
                    "outside_download": 0,
                    "outside_upload": 0,
                    "total_download": 0,
                    "total_upload": 0,
                    "routes": {},
                },
            )
            if device_name:
                device["name"] = str(device_name)
            if (int(bucket), str(device_ip)) not in total_mihomo_keys:
                device["mihomo_download"] += down
                device["mihomo_upload"] += up
            route_key = (str(route), str(node))
            device_route = device["routes"].setdefault(
                route_key,
                {"route": str(route), "node": str(node), "download": 0, "upload": 0},
            )
            device_route["download"] += down
            device_route["upload"] += up
            route_item = routes.setdefault(
                route_key,
                {
                    "route": str(route),
                    "node": str(node),
                    "download": 0,
                    "upload": 0,
                    "_devices": {},
                },
            )
            route_item["download"] += down
            route_item["upload"] += up
            route_device = route_item["_devices"].setdefault(
                str(device_ip),
                {
                    "ip": str(device_ip),
                    "name": str(device_name or device_ip),
                    "download": 0,
                    "upload": 0,
                },
            )
            route_device["download"] += down
            route_device["upload"] += up

        rci_samples = 0
        for raw_total_row in total_rows:
            (
                bucket,
                device_ip,
                device_name,
                download,
                upload,
                outside_download,
                outside_upload,
                samples,
                mihomo_download,
                mihomo_upload,
            ) = _total_row(
                bucket=raw_total_row[0],
                device_ip=raw_total_row[1],
                device_name=raw_total_row[2],
                download=raw_total_row[3],
                upload=raw_total_row[4],
                outside_download=raw_total_row[5],
                outside_upload=raw_total_row[6],
                samples=raw_total_row[7],
                mihomo_download=raw_total_row[8],
                mihomo_upload=raw_total_row[9],
            )
            down, up = _counter(download), _counter(upload)
            outside_down, outside_up = _counter(outside_download), _counter(outside_upload)
            rci_samples += _counter(samples)
            series[int(bucket)]["outside_download"] += outside_down
            series[int(bucket)]["outside_upload"] += outside_up
            series[int(bucket)]["mihomo_download"] += mihomo_download
            series[int(bucket)]["mihomo_upload"] += mihomo_upload
            device = devices.setdefault(
                str(device_ip),
                {
                    "ip": str(device_ip),
                    "name": str(device_name or device_ip),
                    "mihomo_download": 0,
                    "mihomo_upload": 0,
                    "outside_download": 0,
                    "outside_upload": 0,
                    "total_download": 0,
                    "total_upload": 0,
                    "routes": {},
                },
            )
            if device_name:
                device["name"] = str(device_name)
            device["outside_download"] += outside_down
            device["outside_upload"] += outside_up
            device["mihomo_download"] += mihomo_download
            device["mihomo_upload"] += mihomo_upload
            device["total_download"] += down
            device["total_upload"] += up

        for bucket, device_ip, device_name, resource, route, download, upload in resource_rows:
            down, up = _counter(download), _counter(upload)
            item = resources.setdefault(
                str(resource),
                {
                    "resource": str(resource),
                    "download": 0,
                    "upload": 0,
                    "devices": set(),
                    "device_ips": set(),
                    "routes": set(),
                    "_breakdown": {},
                },
            )
            item["download"] += down
            item["upload"] += up
            item["devices"].add(str(device_name or device_ip))
            item["device_ips"].add(str(device_ip))
            item["routes"].add(str(route))
            breakdown = item["_breakdown"].setdefault(
                (str(device_ip), str(route)),
                {
                    "ip": str(device_ip),
                    "name": str(device_name or device_ip),
                    "route": str(route),
                    "download": 0,
                    "upload": 0,
                },
            )
            breakdown["download"] += down
            breakdown["upload"] += up

        device_items: list[dict[str, Any]] = []
        for device in devices.values():
            route_items = sorted(
                device.pop("routes").values(),
                key=lambda item: item["download"] + item["upload"],
                reverse=True,
            )[:12]
            mihomo_total = device["mihomo_download"] + device["mihomo_upload"]
            outside_total = device["outside_download"] + device["outside_upload"]
            reported_total = device["total_download"] + device["total_upload"]
            device["routes"] = route_items
            device["mihomo_bytes"] = mihomo_total
            device["outside_bytes"] = outside_total
            device["total_bytes"] = max(reported_total, mihomo_total + outside_total)
            device_items.append(device)
        device_items.sort(key=lambda item: item["total_bytes"], reverse=True)

        route_items = []
        for item in routes.values():
            breakdown = sorted(
                item.pop("_devices").values(),
                key=lambda row: row["download"] + row["upload"],
                reverse=True,
            )
            item["device_count"] = len(breakdown)
            item["device_ips"] = sorted(row["ip"] for row in breakdown)[:16]
            item["breakdown"] = breakdown[:16]
            item["bytes"] = item["download"] + item["upload"]
            route_items.append(item)
        route_items.sort(key=lambda item: item["bytes"], reverse=True)

        resource_items = []
        for item in resources.values():
            item["device_count"] = len(item["devices"])
            item["devices"] = sorted(item["devices"])[:8]
            item["device_ips"] = sorted(item["device_ips"])[:16]
            item["routes"] = sorted(item["routes"])[:8]
            item["breakdown"] = sorted(
                item.pop("_breakdown").values(),
                key=lambda row: row["download"] + row["upload"],
                reverse=True,
            )[:32]
            item["bytes"] = item["download"] + item["upload"]
            resource_items.append(item)
        resource_items.sort(key=lambda item: item["bytes"], reverse=True)

        series_items = []
        cursor = start
        while cursor <= _bucket(now):
            item = series.get(cursor, {})
            mihomo = _counter(item.get("mihomo_download")) + _counter(item.get("mihomo_upload"))
            outside = _counter(item.get("outside_download")) + _counter(item.get("outside_upload"))
            download = _counter(item.get("mihomo_download")) + _counter(item.get("outside_download"))
            upload = _counter(item.get("mihomo_upload")) + _counter(item.get("outside_upload"))
            series_items.append(
                {
                    "at": cursor,
                    "mihomo_bytes": mihomo,
                    "outside_bytes": outside,
                    "download_bytes": download,
                    "upload_bytes": upload,
                    "total_bytes": download + upload,
                }
            )
            cursor += BUCKET_SECONDS

        mihomo_download = sum(item["mihomo_download"] for item in device_items)
        mihomo_upload = sum(item["mihomo_upload"] for item in device_items)
        outside_download = sum(item["outside_download"] for item in device_items)
        outside_upload = sum(item["outside_upload"] for item in device_items)
        mihomo_bytes = mihomo_download + mihomo_upload
        outside_bytes = outside_download + outside_upload
        total_bytes = mihomo_bytes + outside_bytes
        database_size = 0
        for suffix in ("", "-wal", "-shm"):
            try:
                database_size += max(0, os.path.getsize(f"{self.db_path}{suffix}"))
            except OSError:
                pass
        with self._connect() as connection:
            storage_rows = {
                table: int(
                    connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                )
                for table in ("traffic_route", "traffic_resource", "traffic_total")
            }
        with self._lock:
            connection_age = (
                max(0, now - self._last_connection_success_at)
                if self._last_connection_success_at
                else None
            )
            client_age = (
                max(0, now - self._last_client_success_at)
                if self._last_client_success_at
                else None
            )
            if not self._connection_samples:
                connection_state = "waiting"
            elif self._connection_error:
                connection_state = "error"
            elif connection_age is not None and connection_age > max(
                30, self.sample_interval_seconds * 3
            ):
                connection_state = "stale"
            else:
                connection_state = "live"
            if not self._client_samples:
                client_state = "waiting"
            elif self._client_state == "unavailable":
                client_state = "unavailable"
            elif self._client_error:
                client_state = "error"
            elif client_age is not None and client_age > max(
                90, self.client_interval_seconds * 3
            ):
                client_state = "stale"
            else:
                client_state = "live"
            if connection_state == "waiting":
                quality_state = "warming_up"
            elif connection_state in {"error", "stale"}:
                quality_state = "degraded"
            elif client_state != "live":
                quality_state = "partial"
            else:
                quality_state = "healthy"
            collection = {
                "state": "collecting" if self.running else "stopped",
                "started_at": self._started_at or None,
                "last_sample_at": self._last_sample_at or None,
                "last_error": self._last_error or None,
                "sample_interval_seconds": self.sample_interval_seconds,
                "client_interval_seconds": self.client_interval_seconds,
                "client_counters": self._client_state,
                "retention_seconds": self.retention_seconds,
            }
            quality = {
                "state": quality_state,
                "classification_percent": (
                    round(mihomo_bytes * 100.0 / total_bytes, 1)
                    if total_bytes
                    else None
                ),
                "confirmed_bytes": mihomo_bytes,
                "estimated_bytes": outside_bytes,
                "unclassified_bytes": None if not rci_samples else 0,
                "connections": {
                    "state": connection_state,
                    "samples": self._connection_samples,
                    "errors": self._connection_errors,
                    "last_success_at": self._last_connection_success_at or None,
                    "age_seconds": connection_age,
                    "truncated_samples": self._connection_truncated_samples,
                    "last_error": self._connection_error or None,
                },
                "clients": {
                    "state": client_state,
                    "samples": self._client_samples,
                    "errors": self._client_errors,
                    "last_success_at": self._last_client_success_at or None,
                    "age_seconds": client_age,
                    "last_error": self._client_error or None,
                },
                "storage": {
                    "database_size_bytes": database_size,
                    "rows": storage_rows,
                },
            }
        return {
            "schema_version": TRAFFIC_ANALYTICS_SCHEMA_VERSION,
            "range_seconds": seconds,
            "from": start,
            "to": now,
            "summary": {
                "mihomo_bytes": mihomo_bytes,
                "mihomo_download_bytes": mihomo_download,
                "mihomo_upload_bytes": mihomo_upload,
                "outside_bytes": outside_bytes,
                "outside_download_bytes": outside_download,
                "outside_upload_bytes": outside_upload,
                "download_bytes": mihomo_download + outside_download,
                "upload_bytes": mihomo_upload + outside_upload,
                "total_bytes": total_bytes,
                "device_count": len(device_items),
                "route_count": len(route_items),
                "resource_count": len(resource_items),
            },
            "series": series_items,
            "devices": device_items[:64],
            "routes": route_items[:64],
            "resources": resource_items[:64],
            "coverage": {
                "mihomo": True,
                "keenetic_client_counters": rci_samples > 0,
                "outside_estimated": True,
                "outside_method": "keenetic_total_minus_mihomo",
                "mihomo_method": "connection_delta_sampling",
                "accuracy": "observed_lower_bound",
            },
            "collection": collection,
            "quality": quality,
        }


__all__ = [
    "BUCKET_SECONDS",
    "DEFAULT_CLIENT_INTERVAL_SECONDS",
    "DEFAULT_RETENTION_SECONDS",
    "DEFAULT_SAMPLE_INTERVAL_SECONDS",
    "MihomoTrafficAnalyticsCollector",
    "TRAFFIC_ANALYTICS_SCHEMA_VERSION",
]
