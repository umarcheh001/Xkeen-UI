"""GitHub self-update helpers (stable releases).

PR/Commit 3 (self-update):
  - check "latest" release for the configured repo via GitHub API
  - small caching layer to avoid hammering GitHub / rate limits
  - keep output schema stable and defensive

No installation is performed here.
"""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import TimeoutError as FutureTimeoutError
from typing import Any, Dict, List, Optional, Tuple

from services.net import NET_EXECUTOR


_GITHUB_API_BASE = os.environ.get("XKEEN_UI_GITHUB_API_BASE", "https://api.github.com").rstrip("/")
_USER_AGENT = os.environ.get("XKEEN_UI_HTTP_USER_AGENT", "xkeen-ui")

# Network timeout for GitHub API requests (seconds)
try:
    _API_TIMEOUT = max(3.0, float(os.environ.get("XKEEN_UI_UPDATE_API_TIMEOUT", "10") or 10))
except Exception:
    _API_TIMEOUT = 10.0

# Cache TTL in seconds (serve cached "latest" quickly; refresh in background when stale).
try:
    _REL_TTL = max(5, int(os.environ.get("XKEEN_UI_UPDATE_CHECK_CACHE_TTL", "60") or 60))
except Exception:
    _REL_TTL = 60

# Release notes can be large; keep it compact for UI.
try:
    _MAX_BODY_CHARS = max(256, int(os.environ.get("XKEEN_UI_UPDATE_RELEASE_NOTES_MAX_CHARS", "4096") or 4096))
except Exception:
    _MAX_BODY_CHARS = 4096

# Cache and in-flight futures are keyed by repo string ("owner/name").
_REL_CACHE: Dict[str, Dict[str, Any]] = {}
_REL_FUTURES: Dict[str, Any] = {}
_LOCK = threading.Lock()

# Cache and in-flight futures for main-channel (branch tarball).
_MAIN_CACHE: Dict[str, Dict[str, Any]] = {}
_MAIN_FUTURES: Dict[str, Any] = {}


def _req_json(url: str, *, timeout: float = _API_TIMEOUT) -> Tuple[Any, Dict[str, Any]]:
    """Blocking JSON GET with minimal headers. Returns (parsed_json, meta)."""
    headers = {
        "User-Agent": _USER_AGENT,
        "Accept": "application/vnd.github+json",
    }
    req = urllib.request.Request(url, headers=headers, method="GET")
    meta: Dict[str, Any] = {"url": url}
    with urllib.request.urlopen(req, timeout=float(timeout)) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
        meta["status"] = int(getattr(resp, "status", 200) or 200)
        try:
            meta["etag"] = resp.headers.get("ETag")
        except Exception:
            meta["etag"] = None
        # Rate limit headers (best-effort)
        try:
            meta["ratelimit_remaining"] = resp.headers.get("X-RateLimit-Remaining")
            meta["ratelimit_limit"] = resp.headers.get("X-RateLimit-Limit")
            meta["ratelimit_reset"] = resp.headers.get("X-RateLimit-Reset")
        except Exception:
            pass
        return json.loads(raw), meta


def _pick_asset(assets: List[Dict[str, Any]], *, prefer_name: str) -> Optional[Dict[str, Any]]:
    """Pick a preferred asset by exact name, else heuristics."""
    if not assets:
        return None
    # exact match first
    for a in assets:
        try:
            if str(a.get("name") or "") == prefer_name:
                return a
        except Exception:
            continue
    # fallback: any .tar.gz (for main release artifacts)
    if prefer_name.endswith(".tar.gz"):
        for a in assets:
            try:
                n = str(a.get("name") or "")
                if n.endswith(".tar.gz"):
                    return a
            except Exception:
                continue
    # fallback: any sha256-ish file
    if "sha" in prefer_name.lower():
        for a in assets:
            try:
                n = str(a.get("name") or "").lower()
                if "sha256" in n or n.endswith(".sha256") or n.endswith(".sha"):
                    return a
            except Exception:
                continue
    return None



def _pick_sha_for_asset(assets: List[Dict[str, Any]], asset_name: str) -> Optional[Dict[str, Any]]:
    """Pick best-effort SHA256/checksum asset for a given artifact.

    Supported schemes (common in GitHub Releases):
      - sidecar files: <asset>.sha256 / .sha256.txt / .sha256sum / .sha / ...
      - basename files: <asset_without_ext>.sha256 / ...
      - checksum manifests: SHA256SUMS / checksums.txt

    Returns the chosen asset dict (name/download_url/...) with extra keys:
      kind: 'sidecar'|'manifest'
      for_asset: <asset_name>
    """
    if not assets or not asset_name:
        return None

    name_map = {}
    for a in assets:
        try:
            n = str(a.get('name') or '')
        except Exception:
            continue
        if n:
            name_map[n] = a

    candidates = [
        asset_name + '.sha256',
        asset_name + '.sha256.txt',
        asset_name + '.sha256sum',
        asset_name + '.sha256sum.txt',
        asset_name + '.sha',
        asset_name + '.sha.txt',
    ]

    base = asset_name
    for suf in ('.tar.gz', '.tgz', '.tar', '.zip'):
        if base.endswith(suf):
            base0 = base[: -len(suf)]
            candidates += [
                base0 + '.sha256',
                base0 + '.sha256.txt',
                base0 + '.sha256sum',
                base0 + '.sha',
            ]
            break

    for nm in candidates:
        a = name_map.get(nm)
        if a:
            out = dict(a)
            out['kind'] = 'sidecar'
            out['for_asset'] = asset_name
            return out

    manifests = [
        'SHA256SUMS',
        'SHA256SUMS.txt',
        'sha256sums',
        'sha256sums.txt',
        'checksums.txt',
        'checksums.sha256',
        'checksums',
    ]
    for nm in manifests:
        a = name_map.get(nm)
        if a:
            out = dict(a)
            out['kind'] = 'manifest'
            out['for_asset'] = asset_name
            return out

    return None

def _sanitize_release(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Return a compact UI-safe release structure."""
    tag = raw.get("tag_name")
    name = raw.get("name")
    html_url = raw.get("html_url")
    published_at = raw.get("published_at")
    draft = bool(raw.get("draft"))
    prerelease = bool(raw.get("prerelease"))

    body = raw.get("body")
    if body is None:
        body_s = ""
    else:
        try:
            body_s = str(body)
        except Exception:
            body_s = ""
    if len(body_s) > _MAX_BODY_CHARS:
        body_s = body_s[: _MAX_BODY_CHARS].rstrip() + "\n…(truncated)…"

    assets_out: List[Dict[str, Any]] = []
    raw_assets = raw.get("assets")
    if isinstance(raw_assets, list):
        for a in raw_assets[:50]:
            if not isinstance(a, dict):
                continue
            assets_out.append(
                {
                    "name": a.get("name"),
                    "size": a.get("size"),
                    "content_type": a.get("content_type"),
                    "created_at": a.get("created_at"),
                    "updated_at": a.get("updated_at"),
                    "download_url": a.get("browser_download_url"),
                }
            )

    # Pick the main artifact and optional sha file.
    # Prefer the "routing" release artifact (current project convention),
    # but keep backward compatibility with older releases.
    main_asset = _pick_asset(assets_out, prefer_name="xkeen-ui-routing.tar.gz") or _pick_asset(
        assets_out, prefer_name="xkeen-ui.tar.gz"
    )
    sha_asset = _pick_sha_for_asset(assets_out, (main_asset or {}).get('name') if isinstance(main_asset, dict) else '')
    return {
        "tag": tag,
        "name": name,
        "html_url": html_url,
        "published_at": published_at,
        "draft": draft,
        "prerelease": prerelease,
        "body": body_s,
        "assets": assets_out,
        "asset": main_asset,
        "sha256_asset": sha_asset,
    }


def _fetch_latest_release(repo: str) -> Dict[str, Any]:
    """Blocking fetch latest release from GitHub. Returns stable dict."""
    repo = (repo or "").strip()
    if not repo or "/" not in repo:
        return {"ok": False, "error": "invalid_repo", "latest": None, "meta": {"repo": repo}}

    url = f"{_GITHUB_API_BASE}/repos/{repo}/releases/latest"
    try:
        data, meta = _req_json(url, timeout=_API_TIMEOUT)
        if not isinstance(data, dict):
            return {"ok": False, "error": "bad_response", "latest": None, "meta": meta}
        latest = _sanitize_release(data)
        return {"ok": True, "error": None, "latest": latest, "meta": meta}
    except urllib.error.HTTPError as e:
        # 404 can mean "no releases" (common on fresh repos).
        if getattr(e, "code", None) == 404:
            return {"ok": True, "error": None, "latest": None, "meta": {"repo": repo, "status": 404, "reason": "no_releases"}}
        # Other HTTP errors: surface code + short message.
        try:
            msg = e.read().decode("utf-8", errors="replace") if hasattr(e, "read") else ""
        except Exception:
            msg = ""
        return {"ok": False, "error": f"http_{getattr(e, 'code', 'error')}", "latest": None, "meta": {"repo": repo, "status": getattr(e, "code", None), "message": msg[:400]}}
    except Exception as e:
        return {"ok": False, "error": "network_error", "latest": None, "meta": {"repo": repo, "message": str(e)[:400]}}


def github_get_latest_release(repo: str, *, wait_seconds: float = 2.0, force_refresh: bool = False) -> Tuple[Dict[str, Any], bool]:
    """Get latest release for repo with caching and a short UI-friendly wait.

    Returns:
        (result, stale)
    Where result has stable keys:
        ok: bool
        error: str|None
        latest: dict|None
        meta: dict
    """
    repo = (repo or "").strip()
    now = time.time()

    # Serve fresh cache immediately.
    cached = _REL_CACHE.get(repo)
    if not force_refresh and cached and (now - float(cached.get("ts") or 0.0)) < _REL_TTL:
        return dict(cached.get("data") or {"ok": False, "error": "cache_empty", "latest": None, "meta": {"repo": repo}}), False

    # Ensure background fetch is in-flight.
    with _LOCK:
        fut = _REL_FUTURES.get(repo)
        if fut is None or getattr(fut, "done", lambda: True)():
            fut = NET_EXECUTOR.submit(_fetch_latest_release, repo)
            _REL_FUTURES[repo] = fut

    # Wait briefly for the result.
    try:
        data = fut.result(timeout=max(0.1, float(wait_seconds)))
        if not isinstance(data, dict):
            data = {"ok": False, "error": "bad_response", "latest": None, "meta": {"repo": repo}}
        _REL_CACHE[repo] = {"ts": time.time(), "data": data}
        return data, False
    except FutureTimeoutError:
        if cached and cached.get("data"):
            return dict(cached["data"]), True
        raise TimeoutError("timeout")
    except Exception:
        if cached and cached.get("data"):
            return dict(cached["data"]), True
        raise


# ---------------------------------------------------------------------------
# Main channel (branch tarball)
# ---------------------------------------------------------------------------


def _sanitize_commit(repo: str, branch: str, raw: Dict[str, Any]) -> Dict[str, Any]:
    """Return a compact UI-safe commit structure for main channel."""
    sha = raw.get('sha')
    html_url = raw.get('html_url')
    commit = raw.get('commit') if isinstance(raw.get('commit'), dict) else {}
    committer = commit.get('committer') if isinstance(commit.get('committer'), dict) else {}
    date = committer.get('date')
    msg = commit.get('message')
    try:
        msg_s = str(msg or '')
    except Exception:
        msg_s = ''
    # first line only
    msg_line = msg_s.splitlines()[0].strip() if msg_s else ''

    sha_s = str(sha or '').strip()
    short_sha = sha_s[:7] if sha_s else ''

    tarball_url = None
    if sha_s and '/' in (repo or ''):
        # codeload is stable and fast; curl -L also works with api.github.com/tarball/sha
        tarball_url = f"https://codeload.github.com/{repo}/tar.gz/{sha_s}"

    return {
        'kind': 'main',
        'branch': branch,
        'sha': sha_s or None,
        'short_sha': short_sha or None,
        'committed_at': date,
        'message': msg_line or None,
        'html_url': html_url,
        'tarball_url': tarball_url,
    }


def _fetch_latest_main(repo: str, branch: Optional[str] = None) -> Dict[str, Any]:
    """Blocking fetch latest commit for repo branch and build tarball URL."""
    repo = (repo or '').strip()
    if not repo or '/' not in repo:
        return {'ok': False, 'error': 'invalid_repo', 'latest': None, 'meta': {'repo': repo}}

    meta: Dict[str, Any] = {'repo': repo}

    # Resolve branch: explicit -> env -> repo.default_branch -> main/master fallback
    br = (branch or os.environ.get('XKEEN_UI_UPDATE_BRANCH') or '').strip() or None
    default_branch = None
    try:
        repo_data, repo_meta = _req_json(f"{_GITHUB_API_BASE}/repos/{repo}", timeout=_API_TIMEOUT)
        meta['repo_meta'] = repo_meta
        if isinstance(repo_data, dict):
            default_branch = repo_data.get('default_branch')
    except Exception as e:
        meta['repo_meta_error'] = str(e)[:200]

    if not br:
        br = str(default_branch or 'main').strip()

    # If branch is wrong (e.g., master), retry once with a fallback.
    tried = []
    for b in [br, 'main', 'master']:
        b = (b or '').strip()
        if not b or b in tried:
            continue
        tried.append(b)
        url = f"{_GITHUB_API_BASE}/repos/{repo}/commits/{b}"
        try:
            data, cmeta = _req_json(url, timeout=_API_TIMEOUT)
            meta['commit_meta'] = cmeta
            if not isinstance(data, dict) or not data.get('sha'):
                continue
            latest = _sanitize_commit(repo, b, data)
            meta['branch'] = b
            meta['default_branch'] = default_branch
            return {'ok': True, 'error': None, 'latest': latest, 'meta': meta}
        except urllib.error.HTTPError as e:
            # try next fallback branch
            meta[f'http_{b}'] = getattr(e, 'code', None)
            continue
        except Exception as e:
            meta[f'err_{b}'] = str(e)[:200]
            continue

    return {'ok': False, 'error': 'check_failed', 'latest': None, 'meta': meta}


def github_get_latest_main(
    repo: str,
    *,
    branch: Optional[str] = None,
    wait_seconds: float = 2.0,
    force_refresh: bool = False,
) -> Tuple[Dict[str, Any], bool]:
    """Get latest commit for main channel with caching and short UI-friendly wait.

    Cache key includes the requested branch (or env/default marker) to avoid mixing.
    Returns (result, stale) similar to github_get_latest_release.
    """
    repo = (repo or '').strip()
    bkey = (branch or os.environ.get('XKEEN_UI_UPDATE_BRANCH') or 'default').strip() or 'default'
    key = f"{repo}#{bkey}"

    now = time.time()
    cached = _MAIN_CACHE.get(key)
    if not force_refresh and cached and (now - float(cached.get('ts') or 0.0)) < _REL_TTL:
        return dict(cached.get('data') or {'ok': False, 'error': 'cache_empty', 'latest': None, 'meta': {'repo': repo, 'branch': bkey}}), False

    with _LOCK:
        fut = _MAIN_FUTURES.get(key)
        if fut is None or getattr(fut, 'done', lambda: True)():
            fut = NET_EXECUTOR.submit(_fetch_latest_main, repo, bkey if bkey != 'default' else None)
            _MAIN_FUTURES[key] = fut

    try:
        data = fut.result(timeout=max(0.1, float(wait_seconds)))
        if not isinstance(data, dict):
            data = {'ok': False, 'error': 'bad_response', 'latest': None, 'meta': {'repo': repo, 'branch': bkey}}
        _MAIN_CACHE[key] = {'ts': time.time(), 'data': data}
        return data, False
    except FutureTimeoutError:
        if cached and cached.get('data'):
            return dict(cached['data']), True
        raise TimeoutError('timeout')
    except Exception:
        if cached and cached.get('data'):
            return dict(cached['data']), True
        raise
