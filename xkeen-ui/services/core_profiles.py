"""Curated release sources for Xray and Mihomo core binaries.

This module deliberately owns a small, immutable catalog. It does not accept a
repository, release asset, or checksum from a caller: those values are fetched
only after a stable ``profile_id`` has been resolved here.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import os
import re
import subprocess
import time
from typing import Any, Final, Literal
import urllib.error
import urllib.request
import json


EngineId = Literal["xray", "mihomo"]
RiskLevel = Literal["official", "alternative", "experimental"]
ReleasePolicy = Literal["stable_only", "prerelease_allowed"]

_ENGINE_IDS: Final[frozenset[str]] = frozenset({"xray", "mihomo"})
_SHA256_RE: Final[re.Pattern[str]] = re.compile(r"(?<![0-9a-fA-F])([0-9a-fA-F]{64})(?![0-9a-fA-F])")


@dataclass(frozen=True, slots=True)
class CoreProfile:
    profile_id: str
    engine_id: EngineId
    repo: str
    display_name: str
    description: str
    risk_level: RiskLevel
    binary_name: str
    release_policy: ReleasePolicy = "stable_only"
    asset_prefix: str | None = None


@dataclass(frozen=True, slots=True)
class RouterPlatform:
    machine: str
    opkg_arch: str
    endianness: str


CORE_PROFILES: Final[dict[str, tuple[CoreProfile, ...]]] = {
    "xray": (
        CoreProfile(
            "official",
            "xray",
            "XTLS/Xray-core",
            "Официальный Xray",
            "Базовая совместимость Xray.",
            "official",
            "xray",
        ),
        CoreProfile(
            "uwuray",
            "xray",
            "MakostaDev/UwuRay",
            "UwuRay",
            "Снята проверка минимальной версии клиента REALITY.",
            "alternative",
            "xray",
        ),
        CoreProfile(
            "gfw-knocker",
            "xray",
            "GFW-knocker/Xray-core",
            "GFW-knocker",
            "Сборка для MahsaNG; используйте как экспериментальный профиль.",
            "experimental",
            "xray",
        ),
        CoreProfile(
            "jolymmiles",
            "xray",
            "Jolymmiles/Xray-core",
            "Jolymmiles",
            "Сборка Xray с изменениями TCP Brutal и SMUX.",
            "experimental",
            "xray",
        ),
        CoreProfile(
            "patterniha",
            "xray",
            "patterniha/Xray-core",
            "patterniha",
            "Альтернативная сборка Xray с собственным циклом релизов.",
            "experimental",
            "xray",
        ),
    ),
    "mihomo": (
        CoreProfile(
            "official",
            "mihomo",
            "MetaCubeX/mihomo",
            "Официальный Mihomo",
            "Базовая совместимость Mihomo.",
            "official",
            "mihomo",
        ),
        CoreProfile(
            "mihomo-enhanced",
            "mihomo",
            "LOVECHEN/mihomo-enhanced",
            "mihomo-enhanced",
            "REALITY client version следует за Xray; добавлены Bridge и Portal.",
            "alternative",
            "mihomo",
        ),
        CoreProfile(
            "prizrak-core",
            "mihomo",
            "legiz-ru/Prizrak-Core",
            "Prizrak-Core",
            "Альтернативная сборка Mihomo.",
            "experimental",
            "mihomo",
        ),
        CoreProfile(
            "vernesong",
            "mihomo",
            "vernesong/mihomo",
            "vernesong/mihomo",
            "Альтернативная сборка Mihomo; используется опубликованный prerelease.",
            "experimental",
            "mihomo",
            "prerelease_allowed",
        ),
        CoreProfile(
            "aster-core",
            "mihomo",
            "Miku0139oao/aster-core",
            "aster-core",
            "Mihomo-based альтернативная сборка; используется опубликованный prerelease.",
            "experimental",
            "mihomo",
            "prerelease_allowed",
            "aster-core",
        ),
    ),
}


class CoreProfileError(RuntimeError):
    """A user-safe error raised while resolving a curated release."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _validate_engine_id(engine_id: str) -> EngineId:
    normalized = str(engine_id or "").strip().lower()
    if normalized not in _ENGINE_IDS:
        raise ValueError("Неизвестное ядро")
    return normalized  # type: ignore[return-value]


def list_profiles(engine_id: str) -> tuple[CoreProfile, ...]:
    return CORE_PROFILES[_validate_engine_id(engine_id)]


def get_profile(engine_id: str, profile_id: str) -> CoreProfile:
    normalized_profile_id = str(profile_id or "").strip()
    for profile in list_profiles(engine_id):
        if profile.profile_id == normalized_profile_id:
            return profile
    raise ValueError("Неизвестный профиль источника ядра")


def profile_view(profile: CoreProfile) -> dict[str, Any]:
    return asdict(profile)


def _run_command(command: list[str], timeout_s: float = 3.0) -> tuple[int, str]:
    try:
        result = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_s,
        )
        return int(result.returncode), str(result.stdout or "")
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return 1, ""


def _opkg_primary_arch() -> str:
    code, output = _run_command(["opkg", "print-architecture"])
    if code != 0:
        return ""
    candidates: list[str] = []
    for line in output.splitlines():
        parts = line.strip().split()
        if len(parts) >= 3 and parts[0] == "arch":
            candidates.append(parts[1])
    for value in candidates:
        if value.lower() not in {"all", "noarch"}:
            return value
    return candidates[0] if candidates else ""


def _cpu_endianness() -> str:
    try:
        with open("/proc/cpuinfo", "r", encoding="utf-8", errors="ignore") as handle:
            text = handle.read().lower()
    except OSError:
        return ""
    if "little endian" in text or "byte order" in text and "little" in text:
        return "le"
    if "big endian" in text or "byte order" in text and "big" in text:
        return "be"
    return ""


def detect_router_platform() -> RouterPlatform:
    try:
        machine = str(os.uname().machine or "")
    except (AttributeError, OSError):
        machine = ""
    return RouterPlatform(
        machine=machine,
        opkg_arch=_opkg_primary_arch(),
        endianness=_cpu_endianness(),
    )


def _platform_key(platform: RouterPlatform) -> str:
    values = " ".join((platform.machine, platform.opkg_arch)).lower().replace("_", "-")
    if "aarch64" in values or "arm64" in values:
        return "arm64"
    if "x86-64" in values or "x86_64" in values or "amd64" in values:
        return "amd64"
    if re.search(r"\b(?:armv?7|arm-?cortex-a7)\b", values):
        return "armv7"
    if re.search(r"\barmv?6\b", values):
        return "armv6"
    if "arm" in values:
        return "armv5"
    if "mips64" in values:
        is_little = "mips64el" in values or "mips64le" in values or platform.endianness == "le"
        return "mips64le" if is_little else "mips64"
    if "mips" in values:
        is_little = "mipsel" in values or "mipsle" in values or platform.endianness == "le"
        return "mipsle" if is_little else "mips"
    if "i686" in values or "i386" in values or re.search(r"\b386\b", values):
        return "386"
    return ""


def _github_json(repo: str, timeout_s: float) -> dict[str, Any]:
    api_base = str(os.environ.get("XKEEN_UI_GITHUB_API_BASE") or "https://api.github.com").rstrip("/")
    request = urllib.request.Request(
        f"{api_base}/repos/{repo}/releases/latest",
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": str(os.environ.get("XKEEN_UI_HTTP_USER_AGENT") or "xkeen-ui"),
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=float(timeout_s)) as response:
            payload = json.loads(response.read().decode("utf-8", errors="replace"))
    except (urllib.error.HTTPError, urllib.error.URLError, OSError, TimeoutError) as exc:
        raise CoreProfileError("github_unavailable", "GitHub недоступен. Попробуйте позже.") from exc
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise CoreProfileError("invalid_release", "GitHub вернул некорректные данные релиза.") from exc
    if not isinstance(payload, dict):
        raise CoreProfileError("invalid_release", "GitHub вернул некорректные данные релиза.")
    return payload


def _github_releases(repo: str, timeout_s: float) -> list[dict[str, Any]]:
    api_base = str(os.environ.get("XKEEN_UI_GITHUB_API_BASE") or "https://api.github.com").rstrip("/")
    request = urllib.request.Request(
        f"{api_base}/repos/{repo}/releases?per_page=20",
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": str(os.environ.get("XKEEN_UI_HTTP_USER_AGENT") or "xkeen-ui"),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=float(timeout_s)) as response:
            payload = json.loads(response.read().decode("utf-8", errors="replace"))
    except (urllib.error.HTTPError, urllib.error.URLError, OSError, TimeoutError) as exc:
        raise CoreProfileError("github_unavailable", "GitHub недоступен. Попробуйте позже.") from exc
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise CoreProfileError("invalid_release", "GitHub вернул некорректные данные релиза.") from exc
    if not isinstance(payload, list):
        raise CoreProfileError("invalid_release", "GitHub вернул некорректные данные релиза.")
    return [item for item in payload if isinstance(item, dict)]


def _download_text(url: str, timeout_s: float) -> str:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": str(os.environ.get("XKEEN_UI_HTTP_USER_AGENT") or "xkeen-ui")},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=float(timeout_s)) as response:
            return response.read().decode("utf-8", errors="replace")
    except (urllib.error.HTTPError, urllib.error.URLError, OSError, TimeoutError) as exc:
        raise CoreProfileError("github_unavailable", "Не удалось скачать контрольную сумму релиза.") from exc


def _asset_view(raw_asset: Any) -> dict[str, str] | None:
    if not isinstance(raw_asset, dict):
        return None
    name = str(raw_asset.get("name") or "").strip()
    url = str(raw_asset.get("browser_download_url") or "").strip()
    if not name or not url:
        return None
    digest = str(raw_asset.get("digest") or "").strip()
    return {"name": name, "url": url, "digest": digest}


def _asset_prefixes(profile: CoreProfile, platform_key: str) -> tuple[str, ...]:
    if profile.engine_id == "xray":
        xray_names = {
            "amd64": ("Xray-linux-64.zip",),
            "386": ("Xray-linux-32.zip",),
            "arm64": ("Xray-linux-arm64-v8a.zip",),
            "armv7": ("Xray-linux-arm32-v7a.zip",),
            "armv6": ("Xray-linux-arm32-v6.zip",),
            "armv5": ("Xray-linux-arm32-v5.zip",),
            "mips": ("Xray-linux-mips32.zip",),
            "mipsle": ("Xray-linux-mips32le.zip",),
            "mips64": ("Xray-linux-mips64.zip",),
            "mips64le": ("Xray-linux-mips64le.zip",),
        }
        return xray_names.get(platform_key, ())

    prefix = profile.asset_prefix or ("prizrak-core" if profile.profile_id == "prizrak-core" else "mihomo")
    mihomo_names = {
        "amd64": (f"{prefix}-linux-amd64-",),
        "386": (f"{prefix}-linux-386-",),
        "arm64": (f"{prefix}-linux-arm64-",),
        "armv7": (f"{prefix}-linux-armv7-",),
        "armv6": (f"{prefix}-linux-armv6-",),
        "armv5": (f"{prefix}-linux-armv5-",),
        "mips": (f"{prefix}-linux-mips-softfloat-", f"{prefix}-linux-mips-hardfloat-", f"{prefix}-linux-mips-"),
        "mipsle": (f"{prefix}-linux-mipsle-softfloat-", f"{prefix}-linux-mipsle-hardfloat-", f"{prefix}-linux-mipsle-"),
        "mips64": (f"{prefix}-linux-mips64-",),
        "mips64le": (f"{prefix}-linux-mips64le-",),
    }
    return mihomo_names.get(platform_key, ())


def _matching_asset(profile: CoreProfile, platform: RouterPlatform, assets: list[dict[str, str]]) -> dict[str, str] | None:
    platform_key = _platform_key(platform)
    for pattern in _asset_prefixes(profile, platform_key):
        for asset in assets:
            name = asset["name"]
            if profile.engine_id == "xray":
                if name == pattern:
                    return asset
            elif name.startswith(pattern) and name.endswith(".gz"):
                return asset
    return None


def _checksum_from_list(text: str, asset_name: str) -> str | None:
    for line in text.splitlines():
        match = re.match(r"^\s*([0-9a-fA-F]{64})\s+\*?(.+?)\s*$", line)
        if match and os.path.basename(match.group(2)) == asset_name:
            return match.group(1).lower()
    return None


def _single_sha256(text: str) -> str | None:
    matches = {match.group(1).lower() for match in _SHA256_RE.finditer(text)}
    return next(iter(matches)) if len(matches) == 1 else None


def _github_asset_sha256(asset: dict[str, str]) -> str | None:
    match = re.fullmatch(r"sha256:([0-9a-fA-F]{64})", asset.get("digest", ""))
    return match.group(1).lower() if match else None


def _checksum_for_asset(
    profile: CoreProfile,
    asset: dict[str, str],
    assets: list[dict[str, str]],
    timeout_s: float,
) -> dict[str, str] | None:
    if profile.engine_id == "mihomo":
        checksum_asset = next((item for item in assets if item["name"] == "checksums.txt"), None)
        if checksum_asset is not None:
            digest = _checksum_from_list(_download_text(checksum_asset["url"], timeout_s), asset["name"])
            if digest:
                return {"sha256": digest, "url": checksum_asset["url"], "name": checksum_asset["name"]}
    else:
        checksum_name = f"{asset['name']}.dgst"
        checksum_asset = next((item for item in assets if item["name"] == checksum_name), None)
        if checksum_asset is not None:
            digest = _single_sha256(_download_text(checksum_asset["url"], timeout_s))
            if digest:
                return {"sha256": digest, "url": checksum_asset["url"], "name": checksum_asset["name"]}

    digest = _github_asset_sha256(asset)
    if digest:
        return {"sha256": digest, "url": "", "name": "GitHub asset digest"}
    return None


def _non_installable(reason: str, platform: RouterPlatform) -> dict[str, Any]:
    return {
        "stable": None,
        "asset": None,
        "checksum": None,
        "platform": asdict(platform),
        "installable": False,
        "reason": reason,
        "stale": False,
        "fetched_at": time.time(),
    }


def resolve_release(profile: CoreProfile, platform: RouterPlatform, *, timeout_s: float) -> dict[str, Any]:
    """Resolve one verified release permitted by the curated profile policy."""

    platform_key = _platform_key(platform)
    if not _asset_prefixes(profile, platform_key):
        return _non_installable("unsupported_arch", platform)
    try:
        if profile.release_policy == "prerelease_allowed":
            releases = [
                release
                for release in _github_releases(profile.repo, timeout_s)
                if not bool(release.get("draft")) and bool(release.get("prerelease"))
            ]
        else:
            releases = [_github_json(profile.repo, timeout_s)]
    except CoreProfileError as exc:
        return _non_installable(exc.code, platform)

    missing_reason = "invalid_release"
    for release in releases:
        if bool(release.get("draft")) or (
            profile.release_policy == "stable_only" and bool(release.get("prerelease"))
        ):
            continue
        tag = str(release.get("tag_name") or "").strip()
        if not tag:
            continue
        assets = [candidate for item in (release.get("assets") or []) if (candidate := _asset_view(item))]
        asset = _matching_asset(profile, platform, assets)
        if asset is None:
            missing_reason = "asset_missing"
            continue
        try:
            checksum = _checksum_for_asset(profile, asset, assets, timeout_s)
        except CoreProfileError as exc:
            return _non_installable(exc.code, platform)
        if checksum is None:
            missing_reason = "checksum_missing"
            continue
        return {
            "stable": {
                "tag": tag,
                "url": str(release.get("html_url") or ""),
                "name": str(release.get("name") or ""),
                "published_at": str(release.get("published_at") or release.get("created_at") or ""),
            },
            "asset": asset,
            "checksum": checksum,
            "binary_name": profile.binary_name,
            "platform": asdict(platform),
            "installable": True,
            "reason": "",
            "stale": False,
            "fetched_at": time.time(),
        }
    return _non_installable(missing_reason, platform)
