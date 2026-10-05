"""Trusted discovery helpers for the official modular-panel catalog."""

from __future__ import annotations

import base64
import io
import json
import math
import os
import socket
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, BinaryIO, Callable, Literal, Mapping, Protocol
from urllib.parse import urljoin, urlsplit

from services.io.atomic import _atomic_write_json
from services.module_catalog_trust import CatalogTrustError, TRUSTED_CATALOG_PUBLIC_KEYS, verify_catalog_signature
from services.module_package_contract import (
    ModulePackageContractError,
    compare_semver,
    validate_catalog_document,
    validate_catalog_source,
    validate_semver,
)


OFFICIAL_REPOSITORY = "umarcheh001/Xkeen-UI"
OFFICIAL_RELEASE_PATH_PREFIX = f"/{OFFICIAL_REPOSITORY}/releases/download/"
LATEST_RELEASE_URL = f"https://api.github.com/repos/{OFFICIAL_REPOSITORY}/releases/latest"
CATALOG_REDIRECT_HOSTS = frozenset(
    {
        "github.com",
        "objects.githubusercontent.com",
        "release-assets.githubusercontent.com",
    }
)
_MAX_DISCOVERY_BYTES = 1024 * 1024
_MAX_CATALOG_BYTES = 1024 * 1024
_MAX_SIGNATURE_BYTES = 16 * 1024


class CatalogClientError(ValueError):
    """A stable catalog-client failure safe to show to callers."""

    def __init__(self, code: str, message: str, **details: Any):
        self.code = str(code)
        self.details = details
        super().__init__(f"{self.code}: {message}")


def _fail(code: str, message: str, **details: Any) -> None:
    raise CatalogClientError(code, message, **details)


class CatalogTransportError(CatalogClientError):
    """A transport failure eligible for validated stale-cache fallback."""


@dataclass(frozen=True, slots=True)
class FetchPolicy:
    """Allow-list applied before a request and at each manual redirect."""

    initial_hosts: frozenset[str]
    redirect_hosts: frozenset[str]
    require_official_release_path: bool


class CatalogTransport(Protocol):
    def fetch_bytes(self, url: str, *, max_bytes: int, policy: FetchPolicy) -> bytes: ...

    def stream_to(self, url: str, output: BinaryIO, *, max_bytes: int, policy: FetchPolicy) -> int: ...


_API_POLICY = FetchPolicy(
    initial_hosts=frozenset({"api.github.com"}),
    redirect_hosts=frozenset({"api.github.com"}),
    require_official_release_path=False,
)
_RELEASE_POLICY = FetchPolicy(
    initial_hosts=frozenset({"github.com"}),
    redirect_hosts=CATALOG_REDIRECT_HOSTS,
    require_official_release_path=True,
)


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Surface redirects to the catalog transport instead of following them."""

    def redirect_request(self, request: object, fp: object, code: int, msg: str, headers: object, newurl: str):
        return None


class UrlLibCatalogTransport:
    """Small HTTPS transport with explicit redirect and response-size limits."""

    _MAX_REDIRECTS = 3
    _CHUNK_SIZE = 64 * 1024

    def __init__(self, *, opener: Any | None = None, timeout_s: float = 15.0):
        self._opener = opener or urllib.request.build_opener(_NoRedirectHandler())
        self._timeout_s = float(timeout_s)

    @staticmethod
    def _close(response: Any) -> None:
        try:
            response.close()
        except Exception:
            pass

    @staticmethod
    def _response_status(response: Any) -> int:
        status = getattr(response, "status", None)
        if status is None and hasattr(response, "getcode"):
            status = response.getcode()
        try:
            return int(status)
        except (TypeError, ValueError):
            raise CatalogTransportError("catalog_transport_http", "catalog response has no valid HTTP status") from None

    @staticmethod
    def _response_header(response: Any, name: str) -> str | None:
        headers = getattr(response, "headers", None)
        if headers is None:
            return None
        getter = getattr(headers, "get", None)
        value = getter(name) if callable(getter) else None
        return value if isinstance(value, str) and value else None

    def _open_response(self, url: str, *, policy: FetchPolicy) -> Any:
        current_url = validate_fetch_url(url, policy=policy)
        for redirect_count in range(self._MAX_REDIRECTS + 1):
            try:
                response = self._opener.open(urllib.request.Request(current_url), timeout=self._timeout_s)
            except urllib.error.HTTPError as error:
                response = error
            except (urllib.error.URLError, socket.timeout, TimeoutError, OSError) as error:
                raise CatalogTransportError("catalog_transport_unavailable", "catalog transport request failed") from error
            status = self._response_status(response)
            if status not in {301, 302, 303, 307, 308}:
                if status != 200:
                    self._close(response)
                    raise CatalogTransportError("catalog_transport_http", "catalog response returned an unexpected HTTP status")
                return response

            location = self._response_header(response, "Location")
            self._close(response)
            if redirect_count == self._MAX_REDIRECTS:
                raise CatalogTransportError("catalog_redirect_limit", "catalog response exceeded redirect limit")
            if location is None:
                raise CatalogTransportError("catalog_redirect_unsafe", "catalog redirect has no location")
            try:
                current_url = validate_fetch_url(urljoin(current_url, location), policy=policy, redirected=True)
            except CatalogClientError as error:
                raise CatalogTransportError(error.code, "catalog redirect is outside the allowed policy") from error
        raise CatalogTransportError("catalog_redirect_limit", "catalog response exceeded redirect limit")

    def stream_to(self, url: str, output: BinaryIO, *, max_bytes: int, policy: FetchPolicy) -> int:
        """Stream one accepted response and fail before exceeding ``max_bytes``."""

        if int(max_bytes) < 0:
            raise CatalogTransportError("catalog_transport_too_large", "catalog response size limit is invalid")
        response = self._open_response(url, policy=policy)
        total = 0
        try:
            while True:
                chunk = response.read(min(self._CHUNK_SIZE, int(max_bytes) - total + 1))
                if not chunk:
                    break
                total += len(chunk)
                if total > int(max_bytes):
                    raise CatalogTransportError("catalog_transport_too_large", "catalog response exceeds its size limit")
                output.write(chunk)
        except CatalogTransportError:
            raise
        except (OSError, TypeError, ValueError) as error:
            raise CatalogTransportError("catalog_transport_unavailable", "catalog response could not be read") from error
        finally:
            self._close(response)
        return total

    def fetch_bytes(self, url: str, *, max_bytes: int, policy: FetchPolicy) -> bytes:
        output = io.BytesIO()
        self.stream_to(url, output, max_bytes=max_bytes, policy=policy)
        return output.getvalue()


def _validate_release_path(path: str) -> None:
    if not path.startswith(OFFICIAL_RELEASE_PATH_PREFIX):
        _fail("catalog_source_not_official", "catalog source must use the official release path")
    release_and_asset = path[len(OFFICIAL_RELEASE_PATH_PREFIX) :]
    release_tag, separator, asset_name = release_and_asset.partition("/")
    if not separator or not release_tag.startswith("v") or not asset_name or "/" in asset_name or "\\" in asset_name:
        _fail("catalog_source_not_official", "catalog source must name one immutable release asset")
    try:
        validate_semver(release_tag.removeprefix("v"), "catalog_release_version")
    except ModulePackageContractError as error:
        _fail(error.code, "catalog source release version is invalid")


def validate_fetch_url(url: str, *, policy: FetchPolicy, redirected: bool = False) -> str:
    """Validate an initial official URL or an already-resolved HTTPS redirect."""

    try:
        parsed = urlsplit(str(url or ""))
        port = parsed.port
    except ValueError:
        _fail("catalog_source_not_official", "catalog URL is malformed")
    hosts = policy.redirect_hosts if redirected else policy.initial_hosts
    failure_code = "catalog_redirect_unsafe" if redirected else "catalog_source_not_official"
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.hostname.lower() not in hosts
        or parsed.username is not None
        or parsed.password is not None
        or port not in (None, 443)
    ):
        _fail(failure_code, "catalog URL is outside the allowed HTTPS hosts")
    if not redirected and policy.require_official_release_path:
        if parsed.query or parsed.fragment:
            _fail("catalog_source_not_official", "catalog source must not use mutable URL selectors")
        _validate_release_path(parsed.path)
    return parsed.geturl()


def official_release_asset_url(release_version: str, filename: str) -> str:
    """Build an immutable official release-asset URL from trusted components."""

    try:
        version = validate_semver(release_version, "catalog_release_version")
    except ModulePackageContractError as error:
        _fail(error.code, "release version is invalid")
    asset_name = str(filename or "")
    if not asset_name or any(character in asset_name for character in "/\\?#"):
        _fail("catalog_source_not_official", "release asset must be one filename")
    return validate_fetch_url(
        f"https://github.com{OFFICIAL_RELEASE_PATH_PREFIX}v{version}/{asset_name}",
        policy=FetchPolicy(
            initial_hosts=frozenset({"github.com"}),
            redirect_hosts=CATALOG_REDIRECT_HOSTS,
            require_official_release_path=True,
        ),
    )


def parse_latest_release(payload: Mapping[str, Any]) -> str:
    """Extract a stable SemVer from GitHub's latest-release metadata."""

    if not isinstance(payload, Mapping):
        _fail("catalog_release_discovery_invalid", "latest release metadata must be an object")
    if payload.get("draft") is not False or payload.get("prerelease") is not False:
        _fail("catalog_release_unstable", "latest release must be published and stable")
    tag_name = payload.get("tag_name")
    if not isinstance(tag_name, str) or not tag_name.startswith("v"):
        _fail("catalog_release_discovery_invalid", "latest release tag must use v<semver>")
    try:
        return validate_semver(tag_name.removeprefix("v"), "catalog_release_version")
    except ModulePackageContractError as error:
        _fail(error.code, "latest release tag is invalid")


@dataclass(frozen=True, slots=True)
class CatalogSnapshot:
    """A catalog accepted by the trust boundary and ready for a future updater."""

    catalog: Mapping[str, Any]
    catalog_bytes: bytes
    signature_bytes: bytes
    release_version: str
    catalog_url: str
    fetched_at: float
    freshness: Literal["fresh", "stale"]
    stale_reason: str | None


class ModuleCatalogClient:
    """Fetch an official release catalog and persist only verified bytes."""

    def __init__(
        self,
        ui_state_dir: str | os.PathLike[str],
        *,
        transport: CatalogTransport | None = None,
        now: Callable[[], float] = time.time,
        cache_ttl_s: float = 24 * 60 * 60,
        platform_architecture: str | None = None,
        core_version: str | None = None,
        keyring: Mapping[str, bytes] = TRUSTED_CATALOG_PUBLIC_KEYS,
    ) -> None:
        self._cache_path = Path(ui_state_dir).resolve() / "module-catalog" / "catalog-cache.json"
        self._transport = transport or UrlLibCatalogTransport()
        self._now = now
        self._cache_ttl_s = float(cache_ttl_s)
        self._platform_architecture = platform_architecture
        self._core_version = core_version
        self._keyring = keyring

    @staticmethod
    def _client_validation_error(error: CatalogTrustError | ModulePackageContractError) -> CatalogClientError:
        return CatalogClientError(error.code, "catalog trust validation failed")

    def _verified_snapshot(
        self,
        *,
        catalog_bytes: bytes,
        signature_bytes: bytes,
        release_version: str,
        catalog_url: str,
        fetched_at: float,
    ) -> CatalogSnapshot:
        try:
            validated_url = validate_catalog_source(catalog_url)
            source_version = validated_url.removeprefix("https://github.com" + OFFICIAL_RELEASE_PATH_PREFIX)
            source_version = source_version.removesuffix("/catalog.json").removeprefix("v")
            if validate_semver(release_version, "catalog_release_version") != source_version:
                raise CatalogClientError(
                    "catalog_release_version_mismatch",
                    "catalog release version does not match its immutable source URL",
                )
            signature = verify_catalog_signature(catalog_bytes, signature_bytes, keyring=self._keyring)
            document = json.loads(catalog_bytes.decode("utf-8"))
            catalog = validate_catalog_document(
                document,
                release_version=source_version,
                signing_key_id=signature.key_id,
                trusted_signing_key_ids=frozenset(self._keyring),
                platform_architecture=self._platform_architecture,
                core_version=self._core_version,
            )
        except CatalogClientError:
            raise
        except (CatalogTrustError, ModulePackageContractError) as error:
            raise self._client_validation_error(error) from error
        except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError) as error:
            raise CatalogClientError("catalog_schema_invalid", "catalog content is not valid JSON") from error
        return CatalogSnapshot(
            catalog=catalog,
            catalog_bytes=bytes(catalog_bytes),
            signature_bytes=bytes(signature_bytes),
            release_version=source_version,
            catalog_url=validated_url,
            fetched_at=float(fetched_at),
            freshness="fresh",
            stale_reason=None,
        )

    def _write_cache(self, snapshot: CatalogSnapshot) -> None:
        record = {
            "schema_version": 1,
            "catalog": base64.b64encode(snapshot.catalog_bytes).decode("ascii"),
            "signature": base64.b64encode(snapshot.signature_bytes).decode("ascii"),
            "catalog_url": snapshot.catalog_url,
            "release_version": snapshot.release_version,
            "fetched_at": snapshot.fetched_at,
        }
        try:
            _atomic_write_json(str(self._cache_path), record, mode=0o600)
        except OSError as error:
            raise CatalogClientError("catalog_cache_write_failed", "verified catalog cache could not be written") from error

    def _read_cache(self) -> CatalogSnapshot | None:
        if not self._cache_path.exists():
            return None
        try:
            record = json.loads(self._cache_path.read_text(encoding="utf-8"))
            if not isinstance(record, Mapping) or record.get("schema_version") != 1:
                raise ValueError("unsupported cache record")
            encoded_catalog = record["catalog"]
            encoded_signature = record["signature"]
            catalog_url = record["catalog_url"]
            release_version = record["release_version"]
            fetched_at = float(record["fetched_at"])
            if (
                not isinstance(encoded_catalog, str)
                or not isinstance(encoded_signature, str)
                or not isinstance(catalog_url, str)
                or not isinstance(release_version, str)
                or not math.isfinite(fetched_at)
            ):
                raise ValueError("invalid cache record")
            catalog_bytes = base64.b64decode(encoded_catalog, validate=True)
            signature_bytes = base64.b64decode(encoded_signature, validate=True)
            return self._verified_snapshot(
                catalog_bytes=catalog_bytes,
                signature_bytes=signature_bytes,
                release_version=release_version,
                catalog_url=catalog_url,
                fetched_at=fetched_at,
            )
        except (CatalogClientError, KeyError, OSError, TypeError, ValueError) as error:
            raise CatalogClientError("catalog_cache_invalid", "verified catalog cache is invalid") from error

    def _fetch_remote(self) -> CatalogSnapshot:
        discovery_bytes = self._transport.fetch_bytes(
            LATEST_RELEASE_URL,
            max_bytes=_MAX_DISCOVERY_BYTES,
            policy=_API_POLICY,
        )
        try:
            discovery = json.loads(discovery_bytes.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise CatalogClientError("catalog_release_discovery_invalid", "latest release metadata is invalid") from error
        release_version = parse_latest_release(discovery)
        catalog_url = official_release_asset_url(release_version, "catalog.json")
        signature_url = official_release_asset_url(release_version, "catalog.json.sig")
        catalog_bytes = self._transport.fetch_bytes(
            catalog_url,
            max_bytes=_MAX_CATALOG_BYTES,
            policy=_RELEASE_POLICY,
        )
        signature_bytes = self._transport.fetch_bytes(
            signature_url,
            max_bytes=_MAX_SIGNATURE_BYTES,
            policy=_RELEASE_POLICY,
        )
        return self._verified_snapshot(
            catalog_bytes=catalog_bytes,
            signature_bytes=signature_bytes,
            release_version=release_version,
            catalog_url=catalog_url,
            fetched_at=float(self._now()),
        )

    def get_catalog(self, *, force_refresh: bool = False) -> CatalogSnapshot:
        """Return a fresh catalog or a verified stale cache after transport failure."""

        cached: CatalogSnapshot | None = None
        cache_error: CatalogClientError | None = None
        try:
            cached = self._read_cache()
        except CatalogClientError as error:
            cache_error = error
        now = float(self._now())
        if cached is not None and not force_refresh and max(0.0, now - cached.fetched_at) <= self._cache_ttl_s:
            return cached
        try:
            snapshot = self._fetch_remote()
        except CatalogTransportError as error:
            if cached is not None:
                return replace(cached, freshness="stale", stale_reason=error.code)
            if cache_error is not None:
                raise cache_error from error
            raise CatalogClientError("catalog_unavailable", "catalog transport is unavailable") from error
        if cached is not None and compare_semver(snapshot.release_version, cached.release_version) < 0:
            raise CatalogClientError(
                "catalog_version_rollback",
                "catalog release version is older than the highest verified cache version",
            )
        self._write_cache(snapshot)
        return snapshot
