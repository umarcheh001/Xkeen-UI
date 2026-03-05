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
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

import subprocess

from flask import Blueprint, jsonify, request


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


def _norm_ver(v: Optional[str]) -> str:
    s = str(v or "").strip()
    if s.lower().startswith("v"):
        s = s[1:].strip()
    return s


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
    return m.group(1) if m else None


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
    except Exception as e:
        return {"ok": False, "repo": repo, "tag": None, "url": None, "error": "request_failed", "meta": {"message": str(e)[:200]}}


def create_cores_status_blueprint(ui_state_dir: str) -> Blueprint:
    bp = Blueprint("cores_status", __name__)

    cache_path = os.path.join(str(ui_state_dir or "/tmp"), "cores_updates_cache.json")

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

    @bp.get("/api/cores/versions")
    def api_cores_versions() -> Any:
        try:
            data = _detect_installed()
            return jsonify({"ok": True, "cores": data, "ts": time.time()})
        except Exception as e:
            return jsonify({"ok": False, "error": "detect_failed", "meta": {"message": str(e)[:200]}})

    @bp.get("/api/cores/updates")
    def api_cores_updates() -> Any:
        force = str(request.args.get("force") or "").strip() in ("1", "true", "yes", "force")
        ttl_s = _cfg_cache_ttl_s()
        now = time.time()

        if not force:
            cached = _read_json(cache_path)
            try:
                if cached and float(cached.get("checked_ts") or 0) > 0:
                    age = now - float(cached.get("checked_ts") or 0)
                    if age < float(cached.get("ttl_s") or ttl_s):
                        data = cached.get("data") if isinstance(cached.get("data"), dict) else None
                        if data:
                            installed = _detect_installed()
                            latest = data.get("latest") if isinstance(data.get("latest"), dict) else {}
                            resp = {
                                "ok": bool(data.get("ok", True)),
                                "latest": latest,
                                "checked_ts": float(cached.get("checked_ts") or now),
                                "ttl_s": float(cached.get("ttl_s") or ttl_s),
                                "stale": bool(cached.get("stale") or False),
                                "installed": installed,
                            }
                            resp["update_available"] = {
                                "xray": bool(installed.get("xray", {}).get("installed"))
                                and _norm_ver(installed.get("xray", {}).get("version"))
                                and _norm_ver(installed.get("xray", {}).get("version")) != _norm_ver(latest.get("xray", {}).get("tag")),
                                "mihomo": bool(installed.get("mihomo", {}).get("installed"))
                                and _norm_ver(installed.get("mihomo", {}).get("version"))
                                and _norm_ver(installed.get("mihomo", {}).get("version")) != _norm_ver(latest.get("mihomo", {}).get("tag")),
                            }
                            return jsonify(resp)
            except Exception:
                pass

        installed = _detect_installed()
        timeout_s = _cfg_api_timeout_s()

        xray_repo = str(os.environ.get("XKEEN_UI_XRAY_REPO") or "XTLS/Xray-core")
        mihomo_repo = str(os.environ.get("XKEEN_UI_MIHOMO_REPO") or "MetaCubeX/mihomo")

        xr = _github_latest_release_tag(xray_repo, timeout_s=timeout_s)
        mh = _github_latest_release_tag(mihomo_repo, timeout_s=timeout_s)

        latest: Dict[str, Any] = {
            "xray": {"repo": xray_repo, "tag": xr.get("tag"), "url": xr.get("url"), "ok": bool(xr.get("ok")), "error": xr.get("error"), "meta": xr.get("meta")},
            "mihomo": {"repo": mihomo_repo, "tag": mh.get("tag"), "url": mh.get("url"), "ok": bool(mh.get("ok")), "error": mh.get("error"), "meta": mh.get("meta")},
        }
        ok = bool(xr.get("ok")) and bool(mh.get("ok"))

        upd = {
            "xray": bool(installed.get("xray", {}).get("installed"))
            and _norm_ver(installed.get("xray", {}).get("version"))
            and _norm_ver(installed.get("xray", {}).get("version")) != _norm_ver(latest["xray"].get("tag")),
            "mihomo": bool(installed.get("mihomo", {}).get("installed"))
            and _norm_ver(installed.get("mihomo", {}).get("version"))
            and _norm_ver(installed.get("mihomo", {}).get("version")) != _norm_ver(latest["mihomo"].get("tag")),
        }

        resp = {
            "ok": ok,
            "latest": latest,
            "installed": installed,
            "update_available": upd,
            "checked_ts": now,
            "ttl_s": ttl_s,
            "stale": False,
        }

        try:
            _write_json_atomic(cache_path, {"checked_ts": now, "ttl_s": ttl_s, "stale": False, "data": {"ok": ok, "latest": latest}})
        except Exception:
            pass

        return jsonify(resp)

    return bp
