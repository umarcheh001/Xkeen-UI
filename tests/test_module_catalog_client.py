from __future__ import annotations

import base64
import hashlib
import json
import stat

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from services.module_catalog_client import (
    CATALOG_REDIRECT_HOSTS,
    LATEST_RELEASE_URL,
    CatalogClientError,
    CatalogTransportError,
    FetchPolicy,
    ModuleCatalogClient,
    UrlLibCatalogTransport,
    official_release_asset_url,
    parse_latest_release,
    validate_fetch_url,
)


RELEASE_POLICY = FetchPolicy(
    initial_hosts=frozenset({"github.com"}),
    redirect_hosts=CATALOG_REDIRECT_HOSTS,
    require_official_release_path=True,
)


class _Response:
    def __init__(self, status: int, body: bytes = b"", location: str | None = None):
        self.status = status
        self.headers = {} if location is None else {"Location": location}
        self._body = body
        self._offset = 0

    def read(self, amount: int = -1) -> bytes:
        if amount < 0:
            amount = len(self._body) - self._offset
        result = self._body[self._offset : self._offset + amount]
        self._offset += len(result)
        return result

    def close(self) -> None:
        return None


class _Opener:
    def __init__(self, responses: list[_Response]):
        self.responses = responses
        self.urls: list[str] = []

    def open(self, request: object, timeout: float) -> _Response:
        self.urls.append(str(getattr(request, "full_url")))
        return self.responses.pop(0)


class _CatalogTransport:
    def __init__(self, responses: dict[str, bytes | Exception], *, stream_responses: dict[str, bytes | Exception] | None = None):
        self.responses = responses
        self.calls: list[str] = []
        self.stream_responses = stream_responses or {}
        self.stream_calls: list[str] = []

    def fetch_bytes(self, url: str, *, max_bytes: int, policy: FetchPolicy) -> bytes:
        self.calls.append(url)
        response = self.responses[url]
        if isinstance(response, Exception):
            raise response
        assert len(response) <= max_bytes
        return response

    def stream_to(self, url: str, output, *, max_bytes: int, policy: FetchPolicy) -> int:
        self.stream_calls.append(url)
        response = self.stream_responses[url]
        if isinstance(response, Exception):
            raise response
        output.write(response)
        return len(response)


def _public_pem(private_key: Ed25519PrivateKey) -> bytes:
    return private_key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )


def _catalog_bytes(version: str, *, archive_bytes: bytes = b"abc") -> bytes:
    document = {
        "schema_version": 1,
        "release_version": version,
        "channel": "stable",
        "source_commit": "a" * 40,
        "modules": [
            {
                "id": "tool.files",
                "version": version,
                "channel": "stable",
                "panel_api": "1",
                "module_api": "1",
                "min_core": "1.0.0",
                "architectures": ["aarch64"],
                "requires": ["core"],
                "conflicts": [],
                "requires_restart": True,
                "archive": f"xkeen-module-tool.files-{version}.tar.gz",
                "size": len(archive_bytes),
                "sha256": hashlib.sha256(archive_bytes).hexdigest(),
                "signing_key_id": "release-2026",
            }
        ],
    }
    return (json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def _signature_bytes(private_key: Ed25519PrivateKey, catalog_bytes: bytes) -> bytes:
    return (
        json.dumps(
            {
                "schema_version": 1,
                "algorithm": "Ed25519",
                "key_id": "release-2026",
                "signature": base64.b64encode(private_key.sign(catalog_bytes)).decode("ascii"),
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    ).encode("utf-8")


def _release_responses(
    private_key: Ed25519PrivateKey, version: str, *, archive_bytes: bytes = b"abc"
) -> dict[str, bytes]:
    catalog_bytes = _catalog_bytes(version, archive_bytes=archive_bytes)
    return {
        LATEST_RELEASE_URL: json.dumps(
            {"tag_name": f"v{version}", "draft": False, "prerelease": False},
            sort_keys=True,
        ).encode("utf-8"),
        official_release_asset_url(version, "catalog.json"): catalog_bytes,
        official_release_asset_url(version, "catalog.json.sig"): _signature_bytes(private_key, catalog_bytes),
    }


def test_official_release_asset_url_is_immutable_and_versioned() -> None:
    assert LATEST_RELEASE_URL == "https://api.github.com/repos/umarcheh001/Xkeen-UI/releases/latest"
    assert official_release_asset_url("1.2.3", "catalog.json") == (
        "https://github.com/umarcheh001/Xkeen-UI/releases/download/v1.2.3/catalog.json"
    )


@pytest.mark.parametrize("filename", ("../catalog.json", "module/archive.tar.gz", "catalog.json?branch=main"))
def test_official_release_asset_url_rejects_non_asset_filenames(filename: str) -> None:
    with pytest.raises(CatalogClientError, match="catalog_source_not_official"):
        official_release_asset_url("1.2.3", filename)


@pytest.mark.parametrize(
    "payload",
    (
        {"tag_name": "v1.2.3", "draft": True, "prerelease": False},
        {"tag_name": "v1.2.3", "draft": False, "prerelease": True},
        {"tag_name": "v1.2", "draft": False, "prerelease": False},
        {"tag_name": "release-1.2.3", "draft": False, "prerelease": False},
    ),
)
def test_parse_latest_release_rejects_unstable_or_invalid_tags(payload: dict[str, object]) -> None:
    with pytest.raises(CatalogClientError):
        parse_latest_release(payload)


def test_parse_latest_release_uses_only_stable_semver_tag() -> None:
    assert parse_latest_release(
        {
            "tag_name": "v1.2.3",
            "draft": False,
            "prerelease": False,
            "assets": [{"browser_download_url": "https://example.invalid/catalog.json"}],
        }
    ) == "1.2.3"


@pytest.mark.parametrize(
    "url",
    (
        "http://github.com/umarcheh001/Xkeen-UI/releases/download/v1.2.3/catalog.json",
        "https://github.com/other/repo/releases/download/v1.2.3/catalog.json",
        "https://github.com/umarcheh001/Xkeen-UI/releases/download/v1.2.3/catalog.json?branch=main",
        "https://github.com/umarcheh001/Xkeen-UI/releases/download/v1.2.3/catalog.json#mutable",
    ),
)
def test_validate_fetch_url_rejects_mutable_or_non_official_initial_urls(url: str) -> None:
    with pytest.raises(CatalogClientError, match="catalog_source_not_official"):
        validate_fetch_url(url, policy=RELEASE_POLICY)


def test_validate_fetch_url_allows_only_known_https_redirect_hosts() -> None:
    redirected = "https://objects.githubusercontent.com/release-asset?X-Amz-Signature=test"

    assert validate_fetch_url(redirected, policy=RELEASE_POLICY, redirected=True) == redirected

    with pytest.raises(CatalogClientError, match="catalog_redirect_unsafe"):
        validate_fetch_url("http://objects.githubusercontent.com/release-asset", policy=RELEASE_POLICY, redirected=True)
    with pytest.raises(CatalogClientError, match="catalog_redirect_unsafe"):
        validate_fetch_url("https://example.invalid/release-asset", policy=RELEASE_POLICY, redirected=True)


def test_transport_follows_only_approved_manual_redirects() -> None:
    initial = official_release_asset_url("1.2.3", "catalog.json")
    redirected = "https://objects.githubusercontent.com/release-asset?X-Amz-Signature=test"
    opener = _Opener([_Response(302, location=redirected), _Response(200, body=b"catalog")])

    result = UrlLibCatalogTransport(opener=opener, timeout_s=1).fetch_bytes(
        initial,
        max_bytes=64,
        policy=RELEASE_POLICY,
    )

    assert result == b"catalog"
    assert opener.urls == [initial, redirected]


def test_transport_rejects_unsafe_or_excessive_redirects() -> None:
    initial = official_release_asset_url("1.2.3", "catalog.json")
    unsafe = _Opener([_Response(302, location="https://example.invalid/catalog.json")])
    with pytest.raises(CatalogTransportError, match="catalog_redirect_unsafe"):
        UrlLibCatalogTransport(opener=unsafe, timeout_s=1).fetch_bytes(initial, max_bytes=64, policy=RELEASE_POLICY)

    loop_url = "https://objects.githubusercontent.com/release-asset"
    looping = _Opener([_Response(302, location=loop_url) for _ in range(4)])
    with pytest.raises(CatalogTransportError, match="catalog_redirect_limit"):
        UrlLibCatalogTransport(opener=looping, timeout_s=1).fetch_bytes(initial, max_bytes=64, policy=RELEASE_POLICY)


def test_transport_enforces_response_byte_limit() -> None:
    initial = official_release_asset_url("1.2.3", "catalog.json")
    opener = _Opener([_Response(200, body=b"catalog")])

    with pytest.raises(CatalogTransportError, match="catalog_transport_too_large"):
        UrlLibCatalogTransport(opener=opener, timeout_s=1).fetch_bytes(initial, max_bytes=3, policy=RELEASE_POLICY)


def test_client_returns_fresh_signature_verified_catalog_and_writes_private_cache(tmp_path) -> None:
    private_key = Ed25519PrivateKey.generate()
    transport = _CatalogTransport(_release_responses(private_key, "1.2.3"))
    client = ModuleCatalogClient(
        tmp_path,
        transport=transport,
        now=lambda: 100.0,
        keyring={"release-2026": _public_pem(private_key)},
        platform_architecture="aarch64",
        core_version="1.0.0",
    )

    snapshot = client.get_catalog()

    assert snapshot.release_version == "1.2.3"
    assert snapshot.freshness == "fresh"
    assert snapshot.stale_reason is None
    assert snapshot.catalog["modules"][0]["id"] == "tool.files"
    assert transport.calls == [
        LATEST_RELEASE_URL,
        official_release_asset_url("1.2.3", "catalog.json"),
        official_release_asset_url("1.2.3", "catalog.json.sig"),
    ]
    cache_path = tmp_path / "module-catalog" / "catalog-cache.json"
    assert cache_path.is_file()
    assert stat.S_IMODE(cache_path.stat().st_mode) == 0o600


def test_client_returns_fresh_cache_without_network_request(tmp_path) -> None:
    private_key = Ed25519PrivateKey.generate()
    clock = [100.0]
    transport = _CatalogTransport(_release_responses(private_key, "1.2.3"))
    client = ModuleCatalogClient(
        tmp_path,
        transport=transport,
        now=lambda: clock[0],
        keyring={"release-2026": _public_pem(private_key)},
    )
    client.get_catalog()
    initial_calls = list(transport.calls)
    clock[0] = 200.0

    cached = client.get_catalog()

    assert cached.freshness == "fresh"
    assert cached.release_version == "1.2.3"
    assert transport.calls == initial_calls


def test_client_uses_expired_verified_cache_only_after_transport_failure(tmp_path) -> None:
    private_key = Ed25519PrivateKey.generate()
    clock = [100.0]
    transport = _CatalogTransport(_release_responses(private_key, "1.2.3"))
    client = ModuleCatalogClient(
        tmp_path,
        transport=transport,
        now=lambda: clock[0],
        keyring={"release-2026": _public_pem(private_key)},
    )
    client.get_catalog()
    clock[0] += 24 * 60 * 60 + 1
    transport.responses = {
        LATEST_RELEASE_URL: CatalogTransportError("catalog_transport_unavailable", "offline"),
    }

    stale = client.get_catalog()

    assert stale.freshness == "stale"
    assert stale.stale_reason == "catalog_transport_unavailable"


def test_client_reports_catalog_unavailable_without_verified_cache(tmp_path) -> None:
    transport = _CatalogTransport(
        {LATEST_RELEASE_URL: CatalogTransportError("catalog_transport_unavailable", "offline")}
    )
    client = ModuleCatalogClient(tmp_path, transport=transport)

    with pytest.raises(CatalogClientError) as raised:
        client.get_catalog()

    assert raised.value.code == "catalog_unavailable"


def test_client_rejects_tampered_cache_instead_of_returning_it_offline(tmp_path) -> None:
    private_key = Ed25519PrivateKey.generate()
    transport = _CatalogTransport(_release_responses(private_key, "1.2.3"))
    client = ModuleCatalogClient(
        tmp_path,
        transport=transport,
        now=lambda: 100.0,
        keyring={"release-2026": _public_pem(private_key)},
    )
    client.get_catalog()
    cache_path = tmp_path / "module-catalog" / "catalog-cache.json"
    cache_path.write_text('{"schema_version":1,"catalog":"tampered"}\n', encoding="utf-8")
    transport.responses = {
        LATEST_RELEASE_URL: CatalogTransportError("catalog_transport_unavailable", "offline"),
    }

    with pytest.raises(CatalogClientError) as raised:
        client.get_catalog(force_refresh=True)

    assert raised.value.code == "catalog_cache_invalid"


def test_client_does_not_hide_remote_signature_failure_with_cache(tmp_path) -> None:
    private_key = Ed25519PrivateKey.generate()
    clock = [100.0]
    transport = _CatalogTransport(_release_responses(private_key, "1.2.3"))
    client = ModuleCatalogClient(
        tmp_path,
        transport=transport,
        now=lambda: clock[0],
        keyring={"release-2026": _public_pem(private_key)},
    )
    client.get_catalog()
    clock[0] += 24 * 60 * 60 + 1
    responses = _release_responses(private_key, "1.2.3")
    responses[official_release_asset_url("1.2.3", "catalog.json")] = b"tampered-catalog"
    transport.responses = responses

    with pytest.raises(CatalogClientError) as raised:
        client.get_catalog()

    assert raised.value.code == "catalog_signature_invalid"


def test_client_rejects_validly_signed_release_version_rollback(tmp_path) -> None:
    private_key = Ed25519PrivateKey.generate()
    clock = [100.0]
    transport = _CatalogTransport(_release_responses(private_key, "1.2.4"))
    client = ModuleCatalogClient(
        tmp_path,
        transport=transport,
        now=lambda: clock[0],
        keyring={"release-2026": _public_pem(private_key)},
    )
    client.get_catalog()
    clock[0] += 24 * 60 * 60 + 1
    transport.responses = _release_responses(private_key, "1.2.3")

    with pytest.raises(CatalogClientError) as raised:
        client.get_catalog()

    assert raised.value.code == "catalog_version_rollback"


def test_client_downloads_only_trusted_archive_bytes(tmp_path) -> None:
    private_key = Ed25519PrivateKey.generate()
    archive_bytes = b"abc"
    archive_url = official_release_asset_url("1.2.3", "xkeen-module-tool.files-1.2.3.tar.gz")
    transport = _CatalogTransport(
        _release_responses(private_key, "1.2.3", archive_bytes=archive_bytes),
        stream_responses={archive_url: archive_bytes},
    )
    client = ModuleCatalogClient(
        tmp_path / "state",
        transport=transport,
        now=lambda: 100.0,
        keyring={"release-2026": _public_pem(private_key)},
    )
    snapshot = client.get_catalog()

    archive_path = client.download_verified_archive(snapshot, "tool.files", tmp_path / "downloads")

    assert archive_path.name == "xkeen-module-tool.files-1.2.3.tar.gz"
    assert archive_path.read_bytes() == archive_bytes
    assert transport.stream_calls == [archive_url]


@pytest.mark.parametrize(
    ("archive_bytes", "code"),
    [
        (b"abcd", "catalog_archive_size_mismatch"),
        (b"xyz", "catalog_archive_checksum_mismatch"),
    ],
)
def test_client_removes_partial_archive_when_bytes_do_not_match_catalog(
    tmp_path, archive_bytes: bytes, code: str
) -> None:
    private_key = Ed25519PrivateKey.generate()
    expected_archive = b"abc"
    archive_url = official_release_asset_url("1.2.3", "xkeen-module-tool.files-1.2.3.tar.gz")
    transport = _CatalogTransport(
        _release_responses(private_key, "1.2.3", archive_bytes=expected_archive),
        stream_responses={archive_url: archive_bytes},
    )
    client = ModuleCatalogClient(
        tmp_path / "state",
        transport=transport,
        now=lambda: 100.0,
        keyring={"release-2026": _public_pem(private_key)},
    )
    snapshot = client.get_catalog()
    downloads = tmp_path / "downloads"

    with pytest.raises(CatalogClientError) as raised:
        client.download_verified_archive(snapshot, "tool.files", downloads)

    assert raised.value.code == code
    assert list(downloads.glob("*.part")) == []
    assert not (downloads / "xkeen-module-tool.files-1.2.3.tar.gz").exists()


def test_client_rejects_unknown_module_before_downloading(tmp_path) -> None:
    private_key = Ed25519PrivateKey.generate()
    transport = _CatalogTransport(_release_responses(private_key, "1.2.3"))
    client = ModuleCatalogClient(
        tmp_path,
        transport=transport,
        now=lambda: 100.0,
        keyring={"release-2026": _public_pem(private_key)},
    )
    snapshot = client.get_catalog()

    with pytest.raises(CatalogClientError) as raised:
        client.download_verified_archive(snapshot, "tool.terminal", tmp_path / "downloads")

    assert raised.value.code == "catalog_module_unknown"
    assert transport.stream_calls == []
