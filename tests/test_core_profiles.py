from __future__ import annotations

import importlib

import pytest


profiles = importlib.import_module("services.core_profiles")


def _asset(name: str, url: str | None = None) -> dict[str, str]:
    return {
        "name": name,
        "browser_download_url": url or f"https://example.test/{name}",
    }


def _release(tag: str, assets: list[dict[str, str]], *, prerelease: bool = False) -> dict:
    return {
        "tag_name": tag,
        "html_url": f"https://github.com/example/repo/releases/tag/{tag}",
        "published_at": "2026-09-30T00:00:00Z",
        "draft": False,
        "prerelease": prerelease,
        "assets": assets,
    }


def test_catalogs_are_engine_scoped_and_use_stable_ids():
    assert [p.profile_id for p in profiles.list_profiles("xray")] == [
        "official",
        "uwuray",
        "gfw-knocker",
        "jolymmiles",
        "patterniha",
    ]
    assert [p.profile_id for p in profiles.list_profiles("mihomo")] == [
        "official",
        "mihomo-enhanced",
        "prizrak-core",
        "vernesong",
        "aster-core",
    ]
    with pytest.raises(ValueError, match="Неизвестный профиль"):
        profiles.get_profile("xray", "mihomo-enhanced")


def test_resolve_mipsle_mihomo_asset_and_checksums_txt(monkeypatch):
    release = _release(
        "v1.19.32",
        [
            _asset("mihomo-linux-mipsle-softfloat-v1.19.32.gz"),
            _asset("checksums.txt", url="https://example.test/checksums.txt"),
        ],
    )
    monkeypatch.setattr(profiles, "_github_json", lambda *_args, **_kwargs: release)
    monkeypatch.setattr(
        profiles,
        "_download_text",
        lambda *_args, **_kwargs: "a" * 64 + "  mihomo-linux-mipsle-softfloat-v1.19.32.gz\n",
    )
    result = profiles.resolve_release(
        profiles.get_profile("mihomo", "official"),
        profiles.RouterPlatform("mipsel", "mipsel-3.4", "le"),
        timeout_s=1,
    )
    assert result["installable"] is True
    assert result["asset"]["name"] == "mihomo-linux-mipsle-softfloat-v1.19.32.gz"
    assert result["checksum"]["sha256"] == "a" * 64


def test_resolve_prizrak_uses_custom_binary_prefix(monkeypatch):
    release = _release(
        "v1.19.31-r3",
        [
            _asset("prizrak-core-linux-mipsle-v1.19.31-r3.gz"),
            _asset("checksums.txt", url="https://example.test/checksums.txt"),
        ],
    )
    monkeypatch.setattr(profiles, "_github_json", lambda *_args, **_kwargs: release)
    monkeypatch.setattr(
        profiles,
        "_download_text",
        lambda *_args, **_kwargs: "b" * 64 + "  prizrak-core-linux-mipsle-v1.19.31-r3.gz\n",
    )
    result = profiles.resolve_release(
        profiles.get_profile("mihomo", "prizrak-core"),
        profiles.RouterPlatform("mipsel", "mipsel-3.4", "le"),
        timeout_s=1,
    )
    assert result["installable"] is True
    assert result["asset"]["name"].startswith("prizrak-core-linux-mipsle-")
    assert result["binary_name"] == "mihomo"


def test_resolve_mihomo_uses_github_asset_digest_without_checksums_file(monkeypatch):
    asset = _asset("prizrak-core-linux-amd64-v1.19.32-r1.gz")
    asset["digest"] = "sha256:" + "d" * 64
    release = _release("v1.19.32-r1", [asset])
    monkeypatch.setattr(profiles, "_github_json", lambda *_args, **_kwargs: release)

    result = profiles.resolve_release(
        profiles.get_profile("mihomo", "prizrak-core"),
        profiles.RouterPlatform("x86_64", "x86_64", "le"),
        timeout_s=1,
    )

    assert result["installable"] is True
    assert result["asset"]["name"] == "prizrak-core-linux-amd64-v1.19.32-r1.gz"
    assert result["checksum"]["sha256"] == "d" * 64


@pytest.mark.parametrize(
    ("profile_id", "asset_name"),
    [
        ("vernesong", "mihomo-linux-amd64-alpha-smart-baef5ee.gz"),
        ("aster-core", "aster-core-linux-amd64-alpha-main-56e24f5.gz"),
    ],
)
def test_resolve_opted_in_prerelease_profiles(profile_id, asset_name, monkeypatch):
    asset = _asset(asset_name)
    asset["digest"] = "sha256:" + "e" * 64
    release = _release("Prerelease-Alpha", [asset], prerelease=True)
    monkeypatch.setattr(profiles, "_github_json", lambda *_args, **_kwargs: release)
    monkeypatch.setattr(profiles, "_github_releases", lambda *_args, **_kwargs: [release], raising=False)

    result = profiles.resolve_release(
        profiles.get_profile("mihomo", profile_id),
        profiles.RouterPlatform("x86_64", "x86_64", "le"),
        timeout_s=1,
    )

    assert result["installable"] is True
    assert result["stable"]["tag"] == "Prerelease-Alpha"
    assert result["asset"]["name"] == asset_name
    assert result["checksum"]["sha256"] == "e" * 64


def test_resolve_keeps_prerelease_disabled_for_stable_profiles(monkeypatch):
    asset = _asset("mihomo-linux-amd64-alpha-smart-baef5ee.gz")
    asset["digest"] = "sha256:" + "f" * 64
    release = _release("Prerelease-Alpha", [asset], prerelease=True)
    monkeypatch.setattr(profiles, "_github_json", lambda *_args, **_kwargs: release)

    result = profiles.resolve_release(
        profiles.get_profile("mihomo", "official"),
        profiles.RouterPlatform("x86_64", "x86_64", "le"),
        timeout_s=1,
    )

    assert result["installable"] is False
    assert result["reason"] == "invalid_release"


def test_resolve_xray_uses_matching_dgst_checksum(monkeypatch):
    release = _release(
        "v26.3.27",
        [
            _asset("Xray-linux-32.zip"),
            _asset("Xray-linux-32.zip.dgst", url="https://example.test/xray.dgst"),
        ],
    )
    monkeypatch.setattr(profiles, "_github_json", lambda *_args, **_kwargs: release)
    monkeypatch.setattr(
        profiles,
        "_download_text",
        lambda *_args, **_kwargs: "SHA-256= " + "c" * 64 + "\n",
    )
    result = profiles.resolve_release(
        profiles.get_profile("xray", "official"),
        profiles.RouterPlatform("i386", "i386_pentium", "le"),
        timeout_s=1,
    )
    assert result["installable"] is True
    assert result["asset"]["name"] == "Xray-linux-32.zip"
    assert result["checksum"]["sha256"] == "c" * 64


def test_resolve_rejects_missing_asset_and_checksum(monkeypatch):
    release = _release("v26.3.27", [_asset("Xray-windows-64.zip")])
    monkeypatch.setattr(profiles, "_github_json", lambda *_args, **_kwargs: release)
    result = profiles.resolve_release(
        profiles.get_profile("xray", "official"),
        profiles.RouterPlatform("mipsel", "mipsel-3.4", "le"),
        timeout_s=1,
    )
    assert result["installable"] is False
    assert result["reason"] == "asset_missing"


def test_resolve_rejects_prerelease_and_draft(monkeypatch):
    release = _release("alpha-1", [], prerelease=True)
    release["draft"] = True
    monkeypatch.setattr(profiles, "_github_json", lambda *_args, **_kwargs: release)
    result = profiles.resolve_release(
        profiles.get_profile("mihomo", "official"),
        profiles.RouterPlatform("aarch64", "aarch64", "le"),
        timeout_s=1,
    )
    assert result["installable"] is False
    assert result["reason"] == "invalid_release"


def test_platform_detection_prefers_explicit_machine_and_opkg(monkeypatch):
    monkeypatch.setattr(
        profiles.os,
        "uname",
        lambda: type("Uname", (), {"machine": "aarch64"})(),
        raising=False,
    )
    monkeypatch.setattr(profiles, "_opkg_primary_arch", lambda: "aarch64_generic")
    monkeypatch.setattr(profiles, "_cpu_endianness", lambda: "le")
    platform = profiles.detect_router_platform()
    assert platform.machine == "aarch64"
    assert platform.opkg_arch == "aarch64_generic"
    assert platform.endianness == "le"


def test_platform_key_uses_detected_mips64_endianness():
    assert profiles._platform_key(profiles.RouterPlatform("mips64", "mips64", "le")) == "mips64le"
    assert profiles._platform_key(profiles.RouterPlatform("mips64", "mips64", "be")) == "mips64"
