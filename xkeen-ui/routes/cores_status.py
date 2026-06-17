"""Cores status API (installed versions + update availability).

Endpoints:
  - GET /api/cores/versions  (offline, fast)
  - GET /api/cores/updates   (GitHub API with a small on-disk cache)

Used by the Commands tab header.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

import subprocess

from flask import Blueprint, current_app, jsonify, request

from routes.common.errors import log_route_exception


_CACHE_FORMAT_VERSION = 3


def _env_int(name: str, default: int) -> int:
    v = os.environ.get(name)
    if v is None:
        return default
    try:
        return int(str(v).strip())
    except Exception:
        return default


def _env_float(name: str, default: float) -> float:
    v = os.environ.get(name)
    if v is None:
        return default
    try:
        return float(str(v).strip())
    except Exception:
        return default


def _cfg_cache_ttl_s() -> int:
    # Default: 6 hours
    return max(60, _env_int("XKEEN_UI_CORES_UPDATE_CACHE_TTL", 6 * 3600))


def _cfg_api_timeout_s() -> float:
    return max(2.0, _env_float("XKEEN_UI_CORES_UPDATE_API_TIMEOUT", 6.0))


def _cfg_user_agent() -> str:
    ua = os.environ.get("XKEEN_UI_HTTP_USER_AGENT", "xkeen-ui") or "xkeen-ui"
    return str(ua)


def _log_github_request_failure(repo: str, exc: BaseException) -> None:
    """Record expected upstream/network failures without a traceback."""
    try:
        current_app.logger.debug(
            "cores_status.request_failed | %r | %s",
            {"repo": repo},
            str(exc or "request_failed"),
        )
    except Exception:
        pass


def _norm_ver(v: Optional[str]) -> str:
    s = str(v or "").strip()
    if s.lower().startswith("v"):
        s = s[1:].strip()
    return s


def _parse_prerelease_parts(value: str) -> Tuple[Tuple[int, Any], ...]:
    out: List[Tuple[int, Any]] = []
    for raw_part in str(value or "").split("."):
        part = str(raw_part or "").strip()
        if not part:
            continue
        if part.isdigit():
            out.append((0, int(part)))
        else:
            out.append((1, part.lower()))
    return tuple(out)


def _parse_version_key(value: Optional[str]) -> Optional[Tuple[int, int, int, Tuple[Tuple[int, Any], ...]]]:
    s = _norm_ver(value)
    if not s:
        return None
    match = re.match(r"^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$", s)
    if not match:
        return None
    major = int(match.group(1) or 0)
    minor = int(match.group(2) or 0)
    patch = int(match.group(3) or 0)
    prerelease = _parse_prerelease_parts(match.group(4) or "")
    return (major, minor, patch, prerelease)


def _cmp_prerelease_parts(
    left: Tuple[Tuple[int, Any], ...],
    right: Tuple[Tuple[int, Any], ...],
) -> int:
    if not left and not right:
        return 0
    if not left:
        return 1
    if not right:
        return -1
    limit = min(len(left), len(right))
    for idx in range(limit):
        a_kind, a_value = left[idx]
        b_kind, b_value = right[idx]
        if a_kind != b_kind:
            return 1 if a_kind > b_kind else -1
        if a_value == b_value:
            continue
        return 1 if a_value > b_value else -1
    if len(left) == len(right):
        return 0
    return 1 if len(left) > len(right) else -1


def _cmp_versions(left: Optional[str], right: Optional[str]) -> int:
    lk = _parse_version_key(left)
    rk = _parse_version_key(right)
    if lk is None or rk is None:
        return 0
    if lk[:3] != rk[:3]:
        return 1 if lk[:3] > rk[:3] else -1
    return _cmp_prerelease_parts(lk[3], rk[3])


def _is_update_available(installed_version: Optional[str], latest_tag: Optional[str]) -> bool:
    installed = _norm_ver(installed_version)
    latest = _norm_ver(latest_tag)
    if not installed or not latest:
        return False
    cmp_res = _cmp_versions(latest, installed)
    if cmp_res != 0:
        return cmp_res > 0
    return latest != installed


def _run_cmd(cmd: List[str], *, timeout_s: float = 2.5) -> Tuple[int, str]:
    try:
        res = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=float(timeout_s),
        )
        return int(res.returncode or 0), str(res.stdout or "")
    except FileNotFoundError:
        return 127, ""
    except subprocess.TimeoutExpired as e:
        out = ""
        try:
            out = str(getattr(e, "output", "") or "")
        except Exception:
            out = ""
        return 124, out
    except Exception:
        return 1, ""


_RE_SEMVER = re.compile(r"\bv?(\d+\.\d+\.\d+)\b")
_RE_MIHOMO_PRERELEASE_BUILD = re.compile(r"\b((?:alpha|beta|rc)[-._][0-9A-Za-z.]+)\b", re.IGNORECASE)


def _parse_xray_version(output: str) -> Optional[str]:
    # Typical: "Xray 1.8.24 (Xray, Penetrates Everything.)"
    if not output:
        return None
    m = re.search(r"\bXray\s+(\d+\.\d+\.\d+)\b", output)
    if m:
        return m.group(1)
    m2 = _RE_SEMVER.search(output)
    return m2.group(1) if m2 else None


def _parse_mihomo_version(output: str) -> Optional[str]:
    # Typical: "Mihomo Meta v1.18.2 linux arm64" or "mihomo version v1.18.2"
    if not output:
        return None
    m = _RE_SEMVER.search(output)
    if m:
        return m.group(1)
    pre = _RE_MIHOMO_PRERELEASE_BUILD.search(output)
    return pre.group(1) if pre else None


def _read_json(path: str) -> Optional[dict]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            v = json.load(f)
        return v if isinstance(v, dict) else None
    except Exception:
        return None


def _write_json_atomic(path: str, data: dict) -> None:
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
    except Exception:
        pass
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def _opkg_primary_arch() -> str:
    rc, txt = _run_cmd(["opkg", "print-architecture"], timeout_s=3.0)
    if rc != 0 or not txt:
        return ""

    candidates: List[str] = []
    for line in txt.splitlines():
        raw = str(line or "").strip()
        if not raw.startswith("arch "):
            continue
        parts = raw.split()
        if len(parts) >= 3:
            candidates.append(parts[1])

    for arch in candidates:
        arch_l = str(arch or "").lower()
        if arch_l and arch_l not in ("all", "noarch"):
            return arch
    return candidates[0] if candidates else ""


def _cpu_endianness() -> str:
    try:
        if os.path.exists("/proc/cpuinfo"):
            data = open("/proc/cpuinfo", "r", encoding="utf-8", errors="ignore").read().lower()
            if "little endian" in data:
                return "le"
            if "big endian" in data:
                return "be"
            if "byte order" in data and "little" in data:
                return "le"
            if "byte order" in data and "big" in data:
                return "be"
    except Exception:
        pass
    return ""


def _iter_release_assets(raw_release: Optional[dict]) -> List[Dict[str, str]]:
    out: List[Dict[str, str]] = []
    for raw_asset in ((raw_release or {}).get("assets") or []):
        if not isinstance(raw_asset, dict):
            continue
        name = str(raw_asset.get("name") or "").strip()
        url = str(raw_asset.get("browser_download_url") or "").strip()
        if not name or not url:
            continue
        out.append({"name": name, "url": url})
    return out


def _mihomo_asset_build_id(name: Optional[str]) -> str:
    raw = os.path.basename(str(name or "").strip())
    if raw.endswith(".gz"):
        raw = raw[:-3]
    match = re.search(r"((?:alpha|beta|rc)[-._][0-9A-Za-z.]+)$", raw, re.IGNORECASE)
    if not match:
        return ""
    return str(match.group(1) or "").strip().lower().replace("_", "-")


def _mihomo_platform_install_plan(
    *,
    arch: Optional[str] = None,
    opkg_arch: Optional[str] = None,
    endian: Optional[str] = None,
) -> Dict[str, Any]:
    machine = str(arch or "").strip()
    if not machine:
        try:
            machine = str(os.uname().machine or "")
        except Exception:
            machine = ""
    machine_l = machine.lower()

    opkg_value = str(opkg_arch or "").strip() or _opkg_primary_arch()
    opkg_l = opkg_value.lower()

    endian_value = str(endian or "").strip().lower() or _cpu_endianness()

    prefixes: List[str] = []
    note = ""

    if "aarch64" in machine_l or "arm64" in machine_l or "aarch64" in opkg_l or "arm64" in opkg_l:
        prefixes = ["mihomo-linux-arm64-"]
    elif "x86_64" in machine_l or "amd64" in machine_l or "x86_64" in opkg_l or "amd64" in opkg_l:
        prefixes = ["mihomo-linux-amd64-"]
    elif re.search(r"\barmv?7", machine_l) or "armv7" in opkg_l:
        prefixes = ["mihomo-linux-armv7-"]
    elif re.search(r"\barmv?6", machine_l) or "armv6" in opkg_l:
        prefixes = ["mihomo-linux-armv6-"]
    elif "arm" in machine_l or "arm" in opkg_l:
        prefixes = ["mihomo-linux-armv5-"]
    elif "mips64le" in machine_l or "mips64le" in opkg_l or "mips64el" in opkg_l:
        prefixes = ["mihomo-linux-mips64le-"]
    elif "mips64" in machine_l or "mips64" in opkg_l:
        prefixes = ["mihomo-linux-mips64-"]
    elif "mips" in machine_l or "mips" in opkg_l:
        is_little_endian = (
            "mipsel" in machine_l
            or "mipsle" in machine_l
            or "mipsel" in opkg_l
            or "mipsle" in opkg_l
            or endian_value == "le"
        )
        note = "Для MIPS используется безопасный порядок установки: softfloat, затем hardfloat."
        if is_little_endian:
            prefixes = [
                "mihomo-linux-mipsle-softfloat-",
                "mihomo-linux-mipsle-hardfloat-",
            ]
        else:
            prefixes = [
                "mihomo-linux-mips-softfloat-",
                "mihomo-linux-mips-hardfloat-",
            ]
    elif "386" in machine_l or "i686" in machine_l or "i386" in machine_l or "386" in opkg_l:
        prefixes = ["mihomo-linux-386-"]
    else:
        note = f"Неизвестная архитектура роутера: {machine or 'unknown'}"

    return {
        "arch": machine,
        "opkg_arch": opkg_value,
        "endian": endian_value,
        "prefixes": prefixes,
        "note": note,
    }


def _resolve_mihomo_prerelease_install(
    raw_release: Optional[dict],
    *,
    arch: Optional[str] = None,
    opkg_arch: Optional[str] = None,
    endian: Optional[str] = None,
) -> Dict[str, Any]:
    plan = _mihomo_platform_install_plan(arch=arch, opkg_arch=opkg_arch, endian=endian)
    assets = _iter_release_assets(raw_release)

    candidates: List[Dict[str, str]] = []
    seen_names: set[str] = set()
    for prefix in plan.get("prefixes") or []:
        for asset in assets:
            name = asset.get("name") or ""
            if not name.endswith(".gz"):
                continue
            if not name.startswith(str(prefix)):
                continue
            if name in seen_names:
                continue
            seen_names.add(name)
            candidates.append({"name": name, "url": asset.get("url") or ""})
            break

    checksum_url = ""
    for asset in assets:
        if str(asset.get("name") or "").strip() == "checksums.txt":
            checksum_url = str(asset.get("url") or "").strip()
            break

    note = str(plan.get("note") or "").strip()
    reason = ""
    if not (plan.get("prefixes") or []):
        reason = "unsupported_arch"
    elif not candidates:
        reason = "asset_not_found"
        if not note:
            note = "Для текущей архитектуры не найден подходящий .gz asset Mihomo pre-release."

    build_ids: List[str] = []
    seen_build_ids: set[str] = set()
    for asset in candidates:
        build_id = _mihomo_asset_build_id(asset.get("name"))
        if not build_id or build_id in seen_build_ids:
            continue
        seen_build_ids.add(build_id)
        build_ids.append(build_id)

    return {
        "mode": "direct_asset",
        "supported": bool(candidates),
        "reason": reason,
        "note": note,
        "arch": plan.get("arch") or "",
        "opkg_arch": plan.get("opkg_arch") or "",
        "endian": plan.get("endian") or "",
        "assets": candidates,
        "build_id": build_ids[0] if build_ids else "",
        "build_ids": build_ids,
        "checksum_url": checksum_url,
    }


def _release_summary(raw: Optional[dict]) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict):
        return None
    tag = str(raw.get("tag_name") or "").strip()
    if not tag:
        return None
    return {
        "tag": tag,
        "url": raw.get("html_url"),
        "name": raw.get("name"),
        "published_at": raw.get("published_at") or raw.get("created_at"),
        "prerelease": bool(raw.get("prerelease")),
    }


def _pick_release(raw_releases: List[dict], *, prerelease: bool) -> Optional[dict]:
    best: Optional[dict] = None
    best_key: Optional[Tuple[str, int]] = None
    for idx, raw in enumerate(raw_releases):
        if not isinstance(raw, dict):
            continue
        if bool(raw.get("draft")):
            continue
        if bool(raw.get("prerelease")) != bool(prerelease):
            continue
        if not str(raw.get("tag_name") or "").strip():
            continue
        key = (str(raw.get("published_at") or raw.get("created_at") or ""), -idx)
        if best is None or key > best_key:
            best = raw
            best_key = key
    return best


def _github_latest_release_tag(repo: str, *, timeout_s: float) -> Dict[str, Any]:
    """Return {ok, repo, tag, url, error?, meta?}."""
    base = os.environ.get("XKEEN_UI_GITHUB_API_BASE", "https://api.github.com") or "https://api.github.com"
    base = str(base).rstrip("/")
    url = f"{base}/repos/{repo}/releases/latest"
    headers = {
        "User-Agent": _cfg_user_agent(),
        "Accept": "application/vnd.github+json",
    }
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=float(timeout_s)) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            data = json.loads(raw)
            tag = data.get("tag_name")
            html = data.get("html_url")
            return {"ok": True, "repo": repo, "tag": tag, "url": html}
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode("utf-8", errors="replace")
        except Exception:
            body = ""
        return {
            "ok": False,
            "repo": repo,
            "tag": None,
            "url": None,
            "error": "http_error",
            "meta": {"status": int(getattr(e, "code", 0) or 0), "body": body[:200]},
        }
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        _log_github_request_failure(repo, e)
        return {"ok": False, "repo": repo, "tag": None, "url": None, "error": "request_failed", "meta": {}}
    except Exception:
        log_route_exception("cores_status.request_failed", repo=repo)
        return {"ok": False, "repo": repo, "tag": None, "url": None, "error": "request_failed", "meta": {}}


def _github_release_snapshot(repo: str, *, timeout_s: float) -> Dict[str, Any]:
    """Return stable + prerelease release info for a repo."""
    base = os.environ.get("XKEEN_UI_GITHUB_API_BASE", "https://api.github.com") or "https://api.github.com"
    base = str(base).rstrip("/")
    url = f"{base}/repos/{repo}/releases?per_page=20"
    headers = {
        "User-Agent": _cfg_user_agent(),
        "Accept": "application/vnd.github+json",
    }
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=float(timeout_s)) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            data = json.loads(raw)
            if not isinstance(data, list):
                raise ValueError("bad_releases_payload")
            stable_raw = _pick_release(data, prerelease=False)
            prerelease_raw = _pick_release(data, prerelease=True)
            stable_release = _release_summary(stable_raw)
            prerelease_release = _release_summary(prerelease_raw)
            if prerelease_release is not None and str(repo or "").strip().lower() == "metacubex/mihomo":
                prerelease_release["install"] = _resolve_mihomo_prerelease_install(prerelease_raw)
                install = prerelease_release.get("install") if isinstance(prerelease_release.get("install"), dict) else {}
                display_tag = str((install or {}).get("build_id") or "").strip()
                if display_tag:
                    prerelease_release["display_tag"] = display_tag
            primary = stable_release or prerelease_release or {}
            return {
                "ok": True,
                "repo": repo,
                "tag": primary.get("tag"),
                "url": primary.get("url"),
                "stable": stable_release,
                "prerelease": prerelease_release,
            }
    except Exception:
        stable_only = _github_latest_release_tag(repo, timeout_s=timeout_s)
        stable_release = None
        if stable_only.get("tag"):
            stable_release = {
                "tag": stable_only.get("tag"),
                "url": stable_only.get("url"),
                "name": None,
                "published_at": None,
                "prerelease": False,
            }
        return {
            "ok": bool(stable_only.get("ok")),
            "repo": repo,
            "tag": stable_only.get("tag"),
            "url": stable_only.get("url"),
            "stable": stable_release,
            "prerelease": None,
            "error": stable_only.get("error"),
            "meta": stable_only.get("meta"),
        }


def _latest_release_or_skip(repo: str, *, installed: bool, timeout_s: float) -> Dict[str, Any]:
    if not installed:
        return {
            "ok": True,
            "repo": repo,
            "tag": None,
            "url": None,
            "stable": None,
            "prerelease": None,
            "error": None,
            "meta": {"reason": "not_installed"},
            "skipped": True,
        }

    data = _github_release_snapshot(repo, timeout_s=timeout_s)
    return {
        "ok": bool(data.get("ok")),
        "repo": repo,
        "tag": data.get("tag"),
        "url": data.get("url"),
        "stable": data.get("stable"),
        "prerelease": data.get("prerelease"),
        "error": data.get("error"),
        "meta": data.get("meta"),
        "skipped": False,
    }


def _compute_update_available(installed: Dict[str, Dict[str, Any]], latest: Dict[str, Any]) -> Dict[str, bool]:
    return {
        "xray": bool(installed.get("xray", {}).get("installed"))
        and _norm_ver(installed.get("xray", {}).get("version"))
        and _is_update_available(
            installed.get("xray", {}).get("version"),
            ((latest.get("xray", {}).get("stable") or {}).get("tag"))
            or latest.get("xray", {}).get("tag"),
        ),
        "mihomo": bool(installed.get("mihomo", {}).get("installed"))
        and _norm_ver(installed.get("mihomo", {}).get("version"))
        and _is_update_available(
            installed.get("mihomo", {}).get("version"),
            ((latest.get("mihomo", {}).get("stable") or {}).get("tag"))
            or latest.get("mihomo", {}).get("tag"),
        ),
    }


def _cache_checked_ts(cached: Optional[dict]) -> Optional[float]:
    if not isinstance(cached, dict):
        return None
    try:
        ts = float(cached.get("checked_ts") or 0)
    except Exception:
        return None
    return ts if ts > 0 else None


def _cache_latest_data(cached: Optional[dict]) -> Dict[str, Any]:
    if not isinstance(cached, dict):
        return {}
    data = cached.get("data")
    if not isinstance(data, dict):
        return {}
    latest = data.get("latest")
    return latest if isinstance(latest, dict) else {}


def _cache_ok_flag(cached: Optional[dict]) -> bool:
    if not isinstance(cached, dict):
        return True
    data = cached.get("data")
    if not isinstance(data, dict):
        return True
    return bool(data.get("ok", True))


def _build_updates_response(
    *,
    installed: Dict[str, Dict[str, Any]],
    latest: Optional[Dict[str, Any]],
    ok: bool,
    checked_ts: Optional[float],
    ttl_s: int,
    stale: bool,
    refreshing: bool,
) -> Dict[str, Any]:
    latest_data = latest if isinstance(latest, dict) else {}
    return {
        "ok": bool(ok),
        "latest": latest_data,
        "installed": installed,
        "update_available": _compute_update_available(installed, latest_data),
        "checked_ts": checked_ts,
        "ttl_s": ttl_s,
        "stale": bool(stale),
        "refreshing": bool(refreshing),
    }


def create_cores_status_blueprint(ui_state_dir: str) -> Blueprint:
    bp = Blueprint("cores_status", __name__)

    cache_path = os.path.join(str(ui_state_dir or "/tmp"), "cores_updates_cache.json")
    refresh_lock = threading.Lock()
    refresh_state = {
        "running": False,
        "started_ts": 0.0,
    }

    def _detect_installed() -> Dict[str, Dict[str, Any]]:
        out: Dict[str, Dict[str, Any]] = {}

        xray_bin = "/opt/sbin/xray"
        xray_exists = os.path.exists(xray_bin)
        if xray_exists:
            rc, txt = _run_cmd([xray_bin, "-version"], timeout_s=2.5)
            out["xray"] = {"installed": True, "version": _parse_xray_version(txt), "rc": rc}
        else:
            out["xray"] = {"installed": False, "version": None, "rc": 127}

        mihomo_bin = "/opt/sbin/mihomo"
        mihomo_exists = os.path.exists(mihomo_bin)
        if mihomo_exists:
            rc, txt = _run_cmd([mihomo_bin, "-v"], timeout_s=2.5)
            out["mihomo"] = {"installed": True, "version": _parse_mihomo_version(txt), "rc": rc}
        else:
            out["mihomo"] = {"installed": False, "version": None, "rc": 127}

        return out

    def _build_cached_response(
        cached: Optional[dict],
        *,
        installed: Dict[str, Dict[str, Any]],
        ttl_s: int,
        stale: bool,
        refreshing: bool,
    ) -> Dict[str, Any]:
        return _build_updates_response(
            installed=installed,
            latest=_cache_latest_data(cached),
            ok=_cache_ok_flag(cached),
            checked_ts=_cache_checked_ts(cached),
            ttl_s=ttl_s,
            stale=stale,
            refreshing=refreshing,
        )

    def _refresh_cache_in_background(
        *,
        app: Any,
        ttl_s: int,
        timeout_s: float,
        xray_repo: str,
        mihomo_repo: str,
    ) -> None:
        try:
            with app.app_context():
                installed = _detect_installed()

                xr = _latest_release_or_skip(
                    xray_repo,
                    installed=bool(installed.get("xray", {}).get("installed")),
                    timeout_s=timeout_s,
                )
                mh = _latest_release_or_skip(
                    mihomo_repo,
                    installed=bool(installed.get("mihomo", {}).get("installed")),
                    timeout_s=timeout_s,
                )

                latest: Dict[str, Any] = {
                    "xray": xr,
                    "mihomo": mh,
                }
                ok = bool(xr.get("ok")) and bool(mh.get("ok"))
                checked_ts = time.time()

                _write_json_atomic(
                    cache_path,
                    {
                        "format_version": _CACHE_FORMAT_VERSION,
                        "checked_ts": checked_ts,
                        "ttl_s": ttl_s,
                        "stale": False,
                        "data": {"ok": ok, "latest": latest},
                    },
                )
        except Exception:
            try:
                with app.app_context():
                    log_route_exception("cores_status.background_refresh_failed")
            except Exception:
                pass
        finally:
            with refresh_lock:
                refresh_state["running"] = False

    def _ensure_background_refresh(
        *,
        ttl_s: int,
        timeout_s: float,
        xray_repo: str,
        mihomo_repo: str,
    ) -> bool:
        app = current_app._get_current_object()
        with refresh_lock:
            if refresh_state["running"]:
                return False
            refresh_state["running"] = True
            refresh_state["started_ts"] = time.time()
        try:
            worker = threading.Thread(
                target=_refresh_cache_in_background,
                kwargs={
                    "app": app,
                    "ttl_s": ttl_s,
                    "timeout_s": timeout_s,
                    "xray_repo": xray_repo,
                    "mihomo_repo": mihomo_repo,
                },
                daemon=True,
            )
            worker.start()
            return True
        except Exception:
            with refresh_lock:
                refresh_state["running"] = False
            raise

    @bp.get("/api/cores/versions")
    def api_cores_versions() -> Any:
        try:
            data = _detect_installed()
            return jsonify({"ok": True, "cores": data, "ts": time.time()})
        except Exception as e:
            log_route_exception("cores_status.detect_failed")
            return jsonify({"ok": False, "error": "detect_failed", "meta": {}})

    @bp.get("/api/cores/updates")
    def api_cores_updates() -> Any:
        force = str(request.args.get("force") or "").strip() in ("1", "true", "yes", "force")
        ttl_s = _cfg_cache_ttl_s()
        now = time.time()
        timeout_s = _cfg_api_timeout_s()

        xray_repo = str(os.environ.get("XKEEN_UI_XRAY_REPO") or "XTLS/Xray-core")
        mihomo_repo = str(os.environ.get("XKEEN_UI_MIHOMO_REPO") or "MetaCubeX/mihomo")
        cached = _read_json(cache_path)
        installed = _detect_installed()
        cached_checked_ts = _cache_checked_ts(cached)
        cache_is_fresh = False
        cache_stale_flag = bool(cached.get("stale") or False) if isinstance(cached, dict) else False

        if not force and cached:
            try:
                if cached_checked_ts and int(cached.get("format_version") or 0) == _CACHE_FORMAT_VERSION:
                    age = now - cached_checked_ts
                    cache_is_fresh = age < float(cached.get("ttl_s") or ttl_s)
                    if cache_is_fresh:
                        return jsonify(
                            _build_cached_response(
                                cached,
                                installed=installed,
                                ttl_s=ttl_s,
                                stale=cache_stale_flag,
                                refreshing=False,
                            )
                        )
            except Exception:
                pass
        elif cached:
            try:
                if cached_checked_ts and int(cached.get("format_version") or 0) == _CACHE_FORMAT_VERSION:
                    age = now - cached_checked_ts
                    cache_is_fresh = age < float(cached.get("ttl_s") or ttl_s)
            except Exception:
                pass

        try:
            _ensure_background_refresh(
                ttl_s=ttl_s,
                timeout_s=timeout_s,
                xray_repo=xray_repo,
                mihomo_repo=mihomo_repo,
            )
        except Exception:
            return jsonify(
                _build_updates_response(
                    installed=installed,
                    latest=_cache_latest_data(cached),
                    ok=_cache_ok_flag(cached),
                    checked_ts=_cache_checked_ts(cached),
                    ttl_s=ttl_s,
                    stale=bool(cached),
                    refreshing=False,
                )
            )

        if cached:
            return jsonify(
                _build_cached_response(
                    cached,
                    installed=installed,
                    ttl_s=ttl_s,
                    stale=bool(cache_stale_flag or not cache_is_fresh),
                    refreshing=True,
                )
            )

        return jsonify(
            _build_updates_response(
                installed=installed,
                latest={"xray": {}, "mihomo": {}},
                ok=True,
                checked_ts=None,
                ttl_s=ttl_s,
                stale=False,
                refreshing=True,
            )
        )

    return bp
