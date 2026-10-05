from __future__ import annotations

import pytest

from services.module_catalog_client import (
    CATALOG_REDIRECT_HOSTS,
    LATEST_RELEASE_URL,
    CatalogClientError,
    CatalogTransportError,
    FetchPolicy,
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
