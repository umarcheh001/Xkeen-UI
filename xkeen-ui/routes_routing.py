"""Routing-related API routes as a Flask Blueprint."""
from __future__ import annotations

import os
import json
import re
import base64
import time
import subprocess
import threading

import urllib.request
import urllib.error

from flask import Blueprint, request, jsonify, current_app
from typing import Any, Callable, Dict, Optional, Tuple

from routes_remotefs import _local_allowed_roots, _local_resolve

# Optional: auto-snapshot Xray config fragments on overwrite.
try:
    from services.xray_backups import snapshot_before_overwrite as _snapshot_before_overwrite
except Exception:
    _snapshot_before_overwrite = None


# --------------------------- DAT GeoIP/GeoSite helpers ---------------------------

_GEODAT_CACHE: Dict[Tuple[Any, ...], Tuple[float, Any]] = {}
_GEODAT_INFLIGHT: Dict[Tuple[Any, ...], threading.Event] = {}
_GEODAT_INFLIGHT_LOCK = threading.Lock()



def _geodat_cache_get(key: Tuple[Any, ...], ttl_s: int) -> Any | None:
    if ttl_s <= 0:
        return None
    now = time.time()
    v = _GEODAT_CACHE.get(key)
    if not v:
        return None
    ts, payload = v
    if (now - ts) > ttl_s:
        try:
            del _GEODAT_CACHE[key]
        except Exception:
            pass
        return None
    return payload


def _geodat_cache_set(key: Tuple[Any, ...], payload: Any, ttl_s: int, *, max_items: int = 256) -> None:
    if ttl_s <= 0:
        return
    try:
        _GEODAT_CACHE[key] = (time.time(), payload)
        # very small in-memory LRU-ish eviction
        if len(_GEODAT_CACHE) > max_items:
            # delete ~25% oldest
            try:
                items = sorted(_GEODAT_CACHE.items(), key=lambda kv: kv[1][0])
                n_del = max(1, int(max_items * 0.25))
                for k, _ in items[:n_del]:
                    _GEODAT_CACHE.pop(k, None)
            except Exception:
                pass
    except Exception:
        return


def _geodat_inflight_acquire(key: Tuple[Any, ...]) -> tuple[threading.Event, bool]:
    """Return (event, is_leader). Only leader should run the expensive command."""
    try:
        with _GEODAT_INFLIGHT_LOCK:
            ev = _GEODAT_INFLIGHT.get(key)
            if ev is not None:
                return ev, False
            ev = threading.Event()
            _GEODAT_INFLIGHT[key] = ev
            return ev, True
    except Exception:
        # Fail open: caller becomes leader.
        return threading.Event(), True


def _geodat_inflight_release(key: Tuple[Any, ...], ev: threading.Event) -> None:
    try:
        with _GEODAT_INFLIGHT_LOCK:
            _GEODAT_INFLIGHT.pop(key, None)
    except Exception:
        pass
    try:
        ev.set()
    except Exception:
        pass


def _geodat_page_window() -> int:
    """Window size for paging cache (must be <=500)."""
    raw = (os.getenv('XKEEN_GEODAT_PAGE_WINDOW', '') or '').strip()
    try:
        v = int(float(raw))
    except Exception:
        v = 500
    # keep within 50..500 (plan limit <=500)
    return max(50, min(v, 500))




def _json_extract(text: str) -> Any:
    """Parse JSON even if stdout has extra lines."""
    s = (text or '').strip()
    if not s:
        raise ValueError('empty')
    try:
        return json.loads(s)
    except Exception:
        pass
    # best-effort: find first JSON object/array.
    for ch in ('{', '['):
        i = s.find(ch)
        if i >= 0:
            try:
                return json.loads(s[i:])
            except Exception:
                continue
    raise ValueError('bad_json')


def _geodat_bin_path() -> str:
    return (os.getenv('XKEEN_GEODAT_BIN', '') or '').strip() or '/opt/etc/xkeen-ui/bin/xk-geodat'


def _run_xk_geodat_json(argv: list[str], *, timeout_s: int) -> Any:
    """Run xk-geodat and return parsed JSON.

    We try the provided argv first; if it fails with JSON parse error, we still
    surface stderr/exitcode as details.
    """
    def _run(env: dict[str, str]):
        return subprocess.run(
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
            timeout=max(1, int(timeout_s or 20)),
        )

    env0 = os.environ.copy()
    p = _run(env0)
    out = (p.stdout or '').strip()
    err = (p.stderr or '').strip()

    # Workaround for binaries that vendor go4.org/unsafe/assume-no-moving-gc.
    # When built with newer Go (e.g. go1.26), they may panic at init unless
    # ASSUME_NO_MOVING_GC_UNSAFE_RISK_IT_WITH is set.
    if p.returncode != 0:
        comb = (err + "\n" + out).strip()
        m = re.search(r"ASSUME_NO_MOVING_GC_UNSAFE_RISK_IT_WITH=(go\d+\.\d+)", comb)
        if m and "ASSUME_NO_MOVING_GC_UNSAFE_RISK_IT_WITH" not in env0:
            env1 = env0.copy()
            env1["ASSUME_NO_MOVING_GC_UNSAFE_RISK_IT_WITH"] = m.group(1)
            p2 = _run(env1)
            out2 = (p2.stdout or '').strip()
            err2 = (p2.stderr or '').strip()
            if p2.returncode == 0:
                p, out, err = p2, out2, err2
            else:
                raise RuntimeError(f"exit_{p2.returncode}: {err2 or out2}")
        else:
            raise RuntimeError(f"exit_{p.returncode}: {err or out}")

    try:
        return _json_extract(out)
    except Exception as e:
        raise RuntimeError(f"bad_json: {e}; stderr={err}")


def _geodat_stat_meta(path: str) -> Dict[str, Any]:
    st = os.stat(path)
    return {
        'size': int(getattr(st, 'st_size', 0) or 0),
        'mtime': int(getattr(st, 'st_mtime', 0) or 0),
    }


# --- core.log helpers (never fail) ---
try:
    from services.logging_setup import core_logger as _get_core_logger
    _CORE_LOGGER = _get_core_logger()
except Exception:
    _CORE_LOGGER = None


def _core_log(level: str, msg: str, **extra) -> None:
    if _CORE_LOGGER is None:
        return
    try:
        if extra:
            try:
                tail = ", ".join(f"{k}={v}" for k, v in extra.items())
            except Exception:
                tail = repr(extra)
            full = f"{msg} | {tail}"
        else:
            full = msg
        fn = getattr(_CORE_LOGGER, str(level or "info").lower(), None)
        if callable(fn):
            fn(full)
        else:
            _CORE_LOGGER.info(full)
    except Exception:
        pass





def _apply_local_metadata_best_effort(dst_path: str, st0: os.stat_result | None) -> None:
    """Best-effort restore mode/owner when overwriting an existing file."""
    if st0 is None:
        return
    try:
        mode = int(getattr(st0, 'st_mode', 0) or 0) & 0o7777
        if mode:
            try:
                os.chmod(dst_path, mode)
            except Exception:
                pass
        try:
            uid = int(getattr(st0, 'st_uid', -1))
            gid = int(getattr(st0, 'st_gid', -1))
            if uid >= 0 and gid >= 0:
                os.chown(dst_path, uid, gid)
        except Exception:
            pass
    except Exception:
        return


def _download_to_file(url: str, tmp_path: str, max_bytes: int | None) -> int:
    """Download URL to tmp_path with an optional size cap (bytes)."""
    req = urllib.request.Request(url, headers={"User-Agent": "Xkeen-UI"})
    with urllib.request.urlopen(req, timeout=45) as resp:
        status = getattr(resp, "status", None)
        if isinstance(status, int) and status >= 400:
            raise RuntimeError(f"http_{status}")
        try:
            length = resp.headers.get("Content-Length")
            if length is not None and max_bytes is not None and int(length) > max_bytes:
                raise RuntimeError("size_limit")
        except ValueError:
            pass

        total = 0
        with open(tmp_path, "wb") as f:
            while True:
                chunk = resp.read(256 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if max_bytes is not None and total > max_bytes:
                    raise RuntimeError("size_limit")
                f.write(chunk)
    return total


def error_response(message: str, status: int = 400, *, ok: bool | None = None, **extra) -> Any:
    """Return a JSON error response for this blueprint.

    Mirrors ``app.api_error`` format: at least ``{"error": ...}``,
    optionally with ``"ok": False`` when ``ok`` is explicitly passed.
    """
    payload: Dict[str, Any] = {"error": message}
    if ok is not None:
        payload["ok"] = ok
    if extra:
        payload.update(extra)
    return jsonify(payload), status



def create_routing_blueprint(
    ROUTING_FILE: str,
    ROUTING_FILE_RAW: str,
    XRAY_CONFIGS_DIR: str,
    XRAY_CONFIGS_DIR_REAL: str,
    BACKUP_DIR: str,
    BACKUP_DIR_REAL: str,
    load_json: Callable[[str, Dict[str, Any]], Optional[Dict[str, Any]]],
    strip_json_comments_text: Callable[[str], str],
    restart_xkeen: Callable[..., bool],
) -> Blueprint:
    """Create blueprint with /api/routing endpoints.

    All heavy lifting is still done by the original helper functions and
    constants passed in from app.py.
    """
    bp = Blueprint("routing", __name__)

    # --- DAT GeoIP / GeoSite: backend reader (xk-geodat) ---
    # NOTE: UI parts are implemented in later PRs; here we only provide
    # read-only endpoints that the UI can call.

    def _geodat_validate(kind: str, path: str) -> tuple[str, str, dict[str, Any]]:
        k = (kind or '').strip().lower()
        if k not in ('geosite', 'geoip'):
            raise ValueError('bad_kind')
        p = (path or '').strip()
        if not p:
            raise ValueError('path_required')
        if not p.lower().endswith('.dat'):
            raise ValueError('path_must_end_with_dat')

        roots = _local_allowed_roots()
        rp = _local_resolve(p, roots)
        if not os.path.isfile(rp):
            raise FileNotFoundError('missing_dat_file')
        meta = _geodat_stat_meta(rp)
        return k, rp, meta

    def _geodat_timeout_s() -> int:
        raw = (os.getenv('XKEEN_GEODAT_TIMEOUT', '') or '').strip()
        try:
            v = int(float(raw))
        except Exception:
            v = 25
        return max(3, min(v, 120))

    def _geodat_cache_ttl_s() -> int:
        raw = (os.getenv('XKEEN_GEODAT_CACHE_TTL', '') or '').strip()
        try:
            v = int(float(raw))
        except Exception:
            v = 60
        return max(0, min(v, 600))

    def _geodat_missing_bin_payload() -> tuple[dict[str, Any], int]:
        # Keep it 200 so the UI can show a hint instead of a generic network error.
        return {"ok": False, "error": "missing_xk_geodat"}, 200
    def _geodat_error_payload(code: str, *, kind: str | None = None, path: str | None = None, details: str | None = None) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"ok": False, "error": str(code or "error")}
        if kind is not None:
            payload["kind"] = str(kind)
        if path is not None:
            payload["path"] = str(path)
        if details:
            payload["details"] = str(details)
        # Friendly hints for UI
        if payload["error"] == "missing_xk_geodat":
            payload["hint"] = "Не установлен xk-geodat. Нажмите «Установить xk-geodat» в карточке DAT или запустите scripts/install_xk_geodat.sh и обновите страницу."
        elif payload["error"] == "missing_dat_file":
            payload["hint"] = "DAT-файл не найден. Проверьте путь и установку DAT (GeoSite/GeoIP)."
        elif payload["error"] == "xk_geodat_timeout":
            payload["hint"] = "xk-geodat не ответил вовремя. Попробуйте ещё раз или увеличьте XKEEN_GEODAT_TIMEOUT."
        elif payload["error"] == "xk_geodat_failed":
            payload["hint"] = "Ошибка выполнения xk-geodat. Проверьте логи панели и целостность DAT."
        return payload



    @bp.get('/api/routing/dat/tags')
    def api_dat_tags() -> Any:
        """List tags inside geoip/geosite DAT via xk-geodat."""
        kind = request.args.get('kind', '')
        path = request.args.get('path', '')

        try:
            k, rp, meta = _geodat_validate(kind, path)
        except ValueError as e:
            return error_response(str(e), 400, ok=False)
        except PermissionError as e:
            return error_response(str(e), 403, ok=False)
        except FileNotFoundError as e:
            # Expected UX state: "нет файла".
            return jsonify({"ok": False, "error": str(e), "kind": str(kind or ''), "path": str(path or '')}), 200
        except Exception as e:
            return error_response(f"validate_failed: {e}", 400, ok=False)

        ttl_s = _geodat_cache_ttl_s()
        key = ('tags', k, rp, meta.get('size'), meta.get('mtime'))
        cached = _geodat_cache_get(key, ttl_s)
        if cached is not None:
            return jsonify(cached)

        bin_path = _geodat_bin_path()
        if not os.path.isfile(bin_path):
            payload, status = _geodat_missing_bin_payload()
            payload = _geodat_error_payload(payload.get('error', 'missing_xk_geodat'), kind=k, path=rp)
            _geodat_cache_set(key, payload, min(ttl_s, 10))
            return jsonify(payload), status

        # Prevent cache stampede when multiple UI tabs open the modal.
        ev, is_leader = _geodat_inflight_acquire(key)
        if not is_leader:
            try:
                ev.wait(timeout=2.0)
            except Exception:
                pass
            cached2 = _geodat_cache_get(key, ttl_s)
            if cached2 is not None:
                return jsonify(cached2)
            # fallthrough: become leader if cache still empty
            ev, is_leader = _geodat_inflight_acquire(key)

        timeout_s = _geodat_timeout_s()

        # Expected CLI (PR plan):
        #   xk-geodat tags --kind geosite|geoip --path /.../geosite.dat
        argv = [bin_path, 'tags', '--kind', k, '--path', rp]
        try:
            data = _run_xk_geodat_json(argv, timeout_s=timeout_s)
        except subprocess.TimeoutExpired:
            payload = _geodat_error_payload("xk_geodat_timeout", kind=k, path=rp)
            _geodat_cache_set(key, payload, min(ttl_s, 10))
            return jsonify(payload), 200
        except Exception as e:
            payload = _geodat_error_payload("xk_geodat_failed", kind=k, path=rp, details=str(e))
            _geodat_cache_set(key, payload, min(ttl_s, 10))
            return jsonify(payload), 200
        finally:
            try:
                if 'is_leader' in locals() and is_leader:
                    _geodat_inflight_release(key, ev)
            except Exception:
                pass

        tags = None
        # Accept both {"tags": [...]} and just [...] formats.
        if isinstance(data, dict) and isinstance(data.get('tags'), list):
            tags = data.get('tags')
        elif isinstance(data, list):
            tags = data
        else:
            tags = []

        payload = {
            'ok': True,
            'kind': k,
            'path': rp,
            'meta': meta,
            'tags': tags,
        }

        _geodat_cache_set(key, payload, ttl_s)
        return jsonify(payload), 200

    @bp.get('/api/routing/dat/tag')
    def api_dat_tag_details() -> Any:
        """Get items for a specific tag inside geoip/geosite DAT via xk-geodat (paged)."""
        kind = request.args.get('kind', '')
        path = request.args.get('path', '')
        tag = (request.args.get('tag', '') or '').strip()
        offset_raw = (request.args.get('offset', '') or '').strip()
        limit_raw = (request.args.get('limit', '') or '').strip()

        if not tag:
            return error_response('tag_required', 400, ok=False)

        try:
            offset = int(offset_raw or '0')
        except Exception:
            offset = 0
        try:
            limit = int(limit_raw or '200')
        except Exception:
            limit = 200

        offset = max(0, offset)
        limit = max(1, min(limit, 500))

        try:
            k, rp, meta = _geodat_validate(kind, path)
        except ValueError as e:
            return error_response(str(e), 400, ok=False)
        except PermissionError as e:
            return error_response(str(e), 403, ok=False)
        except FileNotFoundError as e:
            return jsonify({"ok": False, "error": str(e), "kind": str(kind or ''), "path": str(path or '')}), 200
        except Exception as e:
            return error_response(f"validate_failed: {e}", 400, ok=False)

        ttl_s = _geodat_cache_ttl_s()
        key_err = ('tagerr', k, rp, meta.get('size'), meta.get('mtime'), tag)

        bin_path = _geodat_bin_path()
        if not os.path.isfile(bin_path):
            payload, status = _geodat_missing_bin_payload()
            payload = _geodat_error_payload(payload.get('error','missing_xk_geodat'), kind=k, path=rp)
            _geodat_cache_set(key_err, payload, min(ttl_s, 10))
            return jsonify(payload), status

        # Windowed paging cache: avoid running xk-geodat on every next/prev click.
        # We fetch a larger window (<=500) and slice locally for the requested offset/limit.
        win = _geodat_page_window()
        fetch_limit = max(limit, win)
        fetch_limit = max(1, min(fetch_limit, 500))
        win_offset = (offset // fetch_limit) * fetch_limit

        key_win = ('tagwin', k, rp, meta.get('size'), meta.get('mtime'), tag, win_offset, fetch_limit)
        cached_win = _geodat_cache_get(key_win, ttl_s)

        if cached_win is None:
            # Prevent cache stampede (multiple requests for the same window).
            ev, is_leader = _geodat_inflight_acquire(key_win)
            if not is_leader:
                try:
                    ev.wait(timeout=2.0)
                except Exception:
                    pass
                cached_win = _geodat_cache_get(key_win, ttl_s)
                if cached_win is None:
                    # If still missing, try to become leader.
                    ev, is_leader = _geodat_inflight_acquire(key_win)

            if cached_win is None:
                timeout_s = _geodat_timeout_s()
                argv_dump = [bin_path, 'dump', '--kind', k, '--path', rp, '--tag', tag, '--offset', str(win_offset), '--limit', str(fetch_limit)]
                try:
                    try:
                        data = _run_xk_geodat_json(argv_dump, timeout_s=timeout_s)
                    except RuntimeError as e:
                        msg = (str(e) or '').lower()
                        if 'unknown command' in msg:
                            argv_tag = [bin_path, 'tag', '--kind', k, '--path', rp, '--tag', tag, '--offset', str(win_offset), '--limit', str(fetch_limit)]
                            data = _run_xk_geodat_json(argv_tag, timeout_s=timeout_s)
                        else:
                            raise
                except subprocess.TimeoutExpired:
                    payload_err = _geodat_error_payload('xk_geodat_timeout', kind=k, path=rp)
                    _geodat_cache_set(key_win, payload_err, min(ttl_s, 10))
                    return jsonify(payload_err), 200
                except Exception as e:
                    payload_err = _geodat_error_payload('xk_geodat_failed', kind=k, path=rp, details=str(e))
                    _geodat_cache_set(key_win, payload_err, min(ttl_s, 10))
                    return jsonify(payload_err), 200
                finally:
                    try:
                        if 'is_leader' in locals() and is_leader:
                            _geodat_inflight_release(key_win, ev)
                    except Exception:
                        pass

                items_full: list[Any] = []
                total = None
                if isinstance(data, dict):
                    if isinstance(data.get('items'), list):
                        items_full = data.get('items')  # type: ignore[assignment]
                    if isinstance(data.get('total'), int):
                        total = data.get('total')
                elif isinstance(data, list):
                    items_full = data

                cached_win = {
                    'ok': True,
                    'kind': k,
                    'path': rp,
                    'meta': meta,
                    'tag': tag,
                    'offset': win_offset,
                    'limit': fetch_limit,
                    'items': items_full,
                }
                if total is not None:
                    cached_win['total'] = int(total)

                _geodat_cache_set(key_win, cached_win, ttl_s)

        # If cached window is an error payload, return it.
        if not cached_win or cached_win.get('ok') is not True:
            return jsonify(cached_win or _geodat_error_payload('xk_geodat_failed', kind=k, path=rp, details='cache_empty')), 200

        base_offset = int(cached_win.get('offset', win_offset) or 0)
        items_all = cached_win.get('items') or []
        try:
            start_i = max(0, offset - base_offset)
        except Exception:
            start_i = 0
        end_i = start_i + limit
        items = list(items_all)[start_i:end_i]

        payload: Dict[str, Any] = {
            'ok': True,
            'kind': k,
            'path': rp,
            'meta': meta,
            'tag': tag,
            'offset': offset,
            'limit': limit,
            'items': items,
        }
        if 'total' in cached_win:
            payload['total'] = cached_win.get('total')

        return jsonify(payload), 200


    # --- xk-geodat installer/status (UI button: install/update without SSH) ---
    def _geodat_install_script_path() -> str:
        return (os.getenv('XKEEN_GEODAT_INSTALL_SCRIPT', '') or '').strip() or '/opt/etc/xkeen-ui/scripts/install_xk_geodat.sh'

    def _geodat_run_help(bin_path: str) -> tuple[bool, str]:
        def _run(env: dict[str, str]):
            return subprocess.run(
                [bin_path, '--help'],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=env,
                timeout=3,
            )

        env0 = os.environ.copy()
        p = _run(env0)
        out = (p.stdout or '').strip()
        err = (p.stderr or '').strip()
        comb = (out + "\n" + err).strip()

        if p.returncode != 0:
            m = re.search(r"ASSUME_NO_MOVING_GC_UNSAFE_RISK_IT_WITH=(go\d+\.\d+)", comb)
            if m and "ASSUME_NO_MOVING_GC_UNSAFE_RISK_IT_WITH" not in env0:
                env1 = env0.copy()
                env1["ASSUME_NO_MOVING_GC_UNSAFE_RISK_IT_WITH"] = m.group(1)
                p2 = _run(env1)
                out2 = (p2.stdout or '').strip()
                err2 = (p2.stderr or '').strip()
                comb2 = (out2 + "\n" + err2).strip()
                # If it executes (even with non-zero), we consider it installed.
                if p2.returncode in (126, 127) or 'Exec format error' in comb2 or 'not found' in comb2:
                    return False, comb2[:800]
                return True, (comb2 or comb)[:800]

            # Non-fatal: some builds exit non-zero on --help. Treat as installed
            # unless it's an execution/format error.
            if p.returncode in (126, 127) or 'Exec format error' in comb or 'not found' in comb:
                return False, comb[:800]
            return True, comb[:800]

        return True, (comb or out or err)[:800]

    @bp.get('/api/routing/geodat/status')
    def api_geodat_status() -> Any:
        """Return xk-geodat install status (exists + sanity check)."""
        bin_path = _geodat_bin_path()
        exists = bool(bin_path and os.path.isfile(bin_path))
        meta = None
        ok_help = False
        help_text = ''
        if exists:
            try:
                meta = _geodat_stat_meta(bin_path)
            except Exception:
                meta = None
            ok_help, help_text = _geodat_run_help(bin_path)
        return jsonify({
            "ok": True,
            "installed": bool(exists and ok_help),
            "path": bin_path,
            "meta": meta,
            "help": help_text,
        }), 200

    @bp.post('/api/routing/geodat/install')
    def api_geodat_install() -> Any:
        """Install or update xk-geodat binary (used by UI; no SSH required).

        Supports:
          - default: download correct arch from GitHub releases (via install script)
          - JSON body: {"url": "https://..."} to install from a direct URL
          - multipart/form-data: file=<binary> to install from uploaded binary
        """
        script_path = _geodat_install_script_path()
        if not os.path.isfile(script_path):
            return jsonify({"ok": False, "error": "install_script_missing", "hint": f"Не найден скрипт установки: {script_path}"}), 200

        bin_path = _geodat_bin_path()
        env = os.environ.copy()
        env["XKEEN_GEODAT_BIN"] = bin_path
        env["XKEEN_GEODAT_INSTALL"] = "1"  # non-interactive
        env.setdefault("XKEEN_GEODAT_TIMEOUT", os.getenv("XKEEN_GEODAT_TIMEOUT", "25") or "25")

        tmp_uploaded = None

        # multipart upload mode
        try:
            if request.files and "file" in request.files:
                f = request.files.get("file")
                if f and getattr(f, "filename", ""):
                    import tempfile, uuid
                    tmpdir = tempfile.gettempdir()
                    tmp_uploaded = os.path.join(tmpdir, f"xk-geodat-upload-{uuid.uuid4().hex}")
                    f.save(tmp_uploaded)
                    try:
                        os.chmod(tmp_uploaded, 0o755)
                    except Exception:
                        pass
                    env["XKEEN_GEODAT_LOCAL"] = tmp_uploaded
        except Exception:
            pass

        # JSON overrides (URL install)
        try:
            data = request.get_json(silent=True) or {}
            url = str(data.get("url") or "").strip()
            if url:
                env["XKEEN_GEODAT_URL"] = url
        except Exception:
            data = {}

        # Run install script
        try:
            proc = subprocess.run(
                ["/bin/sh", script_path],
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=180,
            )
            out = (proc.stdout or "")
            err = (proc.stderr or "")
        except subprocess.TimeoutExpired:
            return jsonify({"ok": False, "error": "install_timeout", "hint": "Скрипт установки не завершился вовремя."}), 200
        except Exception as e:
            return jsonify({"ok": False, "error": "install_failed", "details": str(e)}), 200
        finally:
            # cleanup uploaded tmp file
            try:
                if tmp_uploaded and os.path.exists(tmp_uploaded):
                    os.remove(tmp_uploaded)
            except Exception:
                pass

        exists = bool(bin_path and os.path.isfile(bin_path))
        ok_help, help_text = (False, "")
        if exists:
            ok_help, help_text = _geodat_run_help(bin_path)

        installed = bool(exists and ok_help)
        payload: Dict[str, Any] = {
            "ok": True,
            "installed": installed,
            "path": bin_path,
            "rc": getattr(proc, "returncode", None),
            "stdout": out[-4000:],
            "stderr": err[-4000:],
        }
        if help_text:
            payload["help"] = help_text

        if not installed:
            payload["warning"] = "not_installed"
            payload["hint"] = "xk-geodat не установлен. Проверьте архитектуру роутера/доступ к GitHub или установите бинарник из файла."
        return jsonify(payload), 200

    # ---------------------------------------------------------------------
    # Routing templates (local filesystem) — used by the UI "Импорт шаблона"
    # ---------------------------------------------------------------------
    # We keep templates in the user's /opt/etc/xray tree so they can add their
    # own presets without changing the UI.
    #
    # Default location:
    #   /opt/etc/xray/templates/routing/*.jsonc
    #
    # The UI calls:
    #   GET /api/routing/templates            -> list
    #   GET /api/routing/templates/<filename> -> content
    #   POST /api/routing/templates           -> create/update user template
    #   DELETE /api/routing/templates/<name>  -> delete user template
    #
    # On first run we auto-seed the directory from the bundled templates
    # shipped with the panel (opt/etc/xray/templates/routing).
    try:
        _xray_root = os.path.dirname(os.path.dirname(ROUTING_FILE))
        ROUTING_TEMPLATES_DIR = os.getenv(
            "XKEEN_XRAY_ROUTING_TEMPLATES_DIR",
            os.path.join(_xray_root, "templates", "routing"),
        )
    except Exception:
        ROUTING_TEMPLATES_DIR = "/opt/etc/xray/templates/routing"

    # Built-in templates shipped with the UI archive.
    # NOTE: We do NOT create any extra meta.json files on disk.
    # For user templates, title/description are stored inside the template
    # itself as a JSONC header line:
    #   // xkeen-template: {"title":"...","description":"..."}
    _TEMPLATE_META = {
        "05_routing_base.jsonc": {
            "title": "Базовый пример (JSONC)",
            "description": "Селективный прокси (vless-reality) для Telegram/YouTube/Discord и др.; блокирует рекламу/QUIC/опасные UDP; остальное — direct.",
        },
        "05_routing_zkeen_only.jsonc": {
            "title": "Только заблокированное (zkeen)",
            "description": "Проксирует только списки ext:geosite_zkeen.dat, остальное идёт напрямую.",
        },
        "05_routing_all_proxy_except_ru.jsonc": {
            "title": "Всё в proxy, кроме RU",
            "description": "Проксирует весь трафик, кроме geoip/geosite RU и локальных сетей.",
        },
    }

    _TEMPLATE_HEADER_RE = re.compile(r"^\s*//\s*xkeen-template:\s*(\{.*\})\s*$")

    def _parse_template_header(text: str) -> Dict[str, str]:
        """Parse xkeen-template header from JSONC template text."""
        if not text:
            return {}
        try:
            # Only look at the first few lines
            lines = text.splitlines()[:8]
        except Exception:
            return {}
        for ln in lines:
            m = _TEMPLATE_HEADER_RE.match(ln)
            if not m:
                # Skip empty lines and plain comments
                continue
            raw = m.group(1)
            try:
                obj = json.loads(raw)
                if not isinstance(obj, dict):
                    return {}
                title = str(obj.get("title") or "").strip()
                desc = str(obj.get("description") or "").strip()
                out: Dict[str, str] = {}
                if title:
                    out["title"] = title
                if desc:
                    out["description"] = desc
                return out
            except Exception:
                return {}
        return {}

    def _read_template_file_meta(path: str) -> Dict[str, str]:
        try:
            with open(path, "r", encoding="utf-8") as f:
                head = f.read(4096)
        except Exception:
            return {}
        return _parse_template_header(head)

    def _strip_existing_template_header(content: str) -> str:
        """Remove existing xkeen-template header at the very top to avoid duplicates."""
        if not isinstance(content, str):
            return ""
        lines = content.splitlines()
        if not lines:
            return content
        # remove BOM if present
        if lines and lines[0].startswith("\ufeff"):
            lines[0] = lines[0].lstrip("\ufeff")
        # Drop first matching header line (only if it appears before any JSON content)
        if _TEMPLATE_HEADER_RE.match(lines[0] or ""):
            return "\n".join(lines[1:]).lstrip("\n")
        return content

    def _seed_routing_templates_once() -> None:
        """Seed built-in templates only once.

        We intentionally avoid re-seeding on every service restart so that
        user deletions/changes persist.
        """
        try:
            os.makedirs(ROUTING_TEMPLATES_DIR, exist_ok=True)
        except Exception:
            return

        marker = os.path.join(ROUTING_TEMPLATES_DIR, ".xkeen_seeded")
        try:
            if os.path.exists(marker):
                return
        except Exception:
            return

        # bundled templates directory inside the UI repo
        try:
            base_dir = os.path.dirname(os.path.abspath(__file__))
            bundled = os.path.join(base_dir, "opt", "etc", "xray", "templates", "routing")
        except Exception:
            bundled = ""
        if not bundled or not os.path.isdir(bundled):
            return

        try:
            for fname in os.listdir(bundled):
                if not (fname.endswith(".json") or fname.endswith(".jsonc")):
                    continue
                src = os.path.join(bundled, fname)
                dst = os.path.join(ROUTING_TEMPLATES_DIR, fname)
                if os.path.exists(dst):
                    continue
                try:
                    with open(src, "rb") as rf:
                        data = rf.read()
                    with open(dst, "wb") as wf:
                        wf.write(data)
                except Exception:
                    continue
        except Exception:
            return

        # Create marker so we don't seed again.
        try:
            with open(marker, "w", encoding="utf-8") as f:
                f.write("seeded\n")
        except Exception:
            pass

    # Seed built-in templates only once.
    try:
        _seed_routing_templates_once()
    except Exception:
        pass


    # ---- Routing fragment selector helpers (UI dropdown) ----
    # IMPORTANT: do NOT hardcode /opt here. app.py already resolves
    # a writable BASE_ETC_DIR on macOS/dev environments.
    _XRAY_CONFIGS_DIR = XRAY_CONFIGS_DIR
    _XRAY_CONFIGS_DIR_REAL = XRAY_CONFIGS_DIR_REAL

    def _paths_for_routing(file_arg: Optional[str] = None) -> tuple[str, str]:
        """Resolve routing fragment paths (clean JSON + raw JSONC).

        - Default: ROUTING_FILE / ROUTING_FILE_RAW passed into blueprint.
        - If file_arg is provided (basename or absolute path under configs dir),
          use that file as clean JSON; raw JSONC is derived as <file>.jsonc.
        - If file_arg ends with .jsonc, treat it as raw and map clean to .json.
        """
        if not file_arg:
            return ROUTING_FILE, ROUTING_FILE_RAW

        try:
            v = str(file_arg or "").strip()
        except Exception:
            v = ""
        if not v:
            return ROUTING_FILE, ROUTING_FILE_RAW

        # Allow absolute path, but only inside XRAY_CONFIGS_DIR
        if os.path.isabs(v):
            cand = v
        else:
            # For safety disallow nested paths like a/b.json
            if "/" in v or "\\" in v:
                raise ValueError("invalid filename")
            cand = os.path.join(_XRAY_CONFIGS_DIR, v)

        cand_real = os.path.realpath(cand)
        # Ensure it's inside configs dir
        base = _XRAY_CONFIGS_DIR_REAL
        if not (cand_real == base or cand_real.startswith(base + os.sep)):
            raise ValueError("outside configs dir")

        if not (cand_real.endswith(".json") or cand_real.endswith(".jsonc")):
            raise ValueError("unsupported extension")

        if cand_real.endswith(".jsonc"):
            raw_path = cand_real
            clean_path = cand_real[:-1]  # .jsonc -> .json
        else:
            clean_path = cand_real
            raw_path = cand_real + "c"  # .json -> .jsonc

        return clean_path, raw_path


    @bp.get("/api/routing/fragments")
    def api_list_routing_fragments() -> Any:
        """List routing fragment files in XRAY_CONFIGS_DIR.

        Used by UI dropdown: /opt/etc/xray/configs/*routing*.json
        """
        items = []
        try:
            if os.path.isdir(_XRAY_CONFIGS_DIR):
                for name in os.listdir(_XRAY_CONFIGS_DIR):
                    lname = str(name or "").lower()
                    if not lname.endswith(".json"):
                        continue
                    if "routing" not in lname:
                        continue
                    full = os.path.join(_XRAY_CONFIGS_DIR, name)
                    if not os.path.isfile(full):
                        continue
                    try:
                        st = os.stat(full)
                        items.append({
                            "name": name,
                            "size": int(getattr(st, "st_size", 0) or 0),
                            "mtime": int(getattr(st, "st_mtime", 0) or 0),
                        })
                    except Exception:
                        items.append({"name": name})
        except Exception:
            items = []

        try:
            items.sort(key=lambda it: str(it.get("name") or "").lower())
        except Exception:
            pass

        current_name = os.path.basename(ROUTING_FILE)
        return jsonify({
            "ok": True,
            "dir": _XRAY_CONFIGS_DIR,
            "current": current_name,
            "items": items,
        })

    @bp.get("/api/routing")
    def api_get_routing() -> Any:
        """Return routing config as raw text with comments if available.

        Supports optional query param ``?file=<name>`` to choose a fragment file
        inside ``XRAY_CONFIGS_DIR`` (e.g. 05_routing_hys2.json or custom *routing*.json).

        Selection rules:

        - If both ROUTING_FILE and ROUTING_FILE_RAW exist:
          - If ROUTING_FILE is newer than ROUTING_FILE_RAW (edited externally),
            return ROUTING_FILE.
          - Otherwise return ROUTING_FILE_RAW.
        - If only ROUTING_FILE_RAW exists, return it.
        - Else, read ROUTING_FILE and return a pretty-printed JSON.

        Additionally, disable HTTP caching so the editor always gets fresh data.
        """
        def _no_cache(resp: Any, notice: str | None = None, kind: str = "info") -> Any:
            # Avoid stale data due to browser/proxy caching.
            try:
                resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
                resp.headers["Pragma"] = "no-cache"
                resp.headers["Expires"] = "0"
                # Optional UI notice (ASCII-safe base64).
                if notice:
                    try:
                        b64 = base64.b64encode(str(notice).encode("utf-8")).decode("ascii")
                        resp.headers["X-XKeen-Notice-B64"] = b64
                        resp.headers["X-XKeen-Notice-Kind"] = str(kind or "info")
                    except Exception:
                        pass
            except Exception:
                pass
            return resp

        # Allow selecting a routing fragment by filename.
        file_arg = request.args.get("file", "")
        try:
            sel_main, sel_raw = _paths_for_routing(file_arg)
        except Exception:
            # If the stored fragment name is stale/invalid, fall back to defaults.
            sel_main, sel_raw = ROUTING_FILE, ROUTING_FILE_RAW

        raw_exists = os.path.exists(sel_raw)
        main_exists = os.path.exists(sel_main)

        # If the main JSON was edited outside of the UI after JSONC was created,
        # show the main file to avoid the UI "sticking" to the older *.jsonc.
        if raw_exists and main_exists:
            try:
                st_raw = os.stat(sel_raw)
                st_main = os.stat(sel_main)
                raw_mtime_ns = getattr(st_raw, "st_mtime_ns", int(st_raw.st_mtime * 1_000_000_000))
                main_mtime_ns = getattr(st_main, "st_mtime_ns", int(st_main.st_mtime * 1_000_000_000))
                if main_mtime_ns > raw_mtime_ns:
                    with open(sel_main, "r", encoding="utf-8") as f:
                        text = f.read()
                    return _no_cache(current_app.response_class(text, mimetype="application/json"))
            except Exception:
                # Any failure -> fall back to the normal preference order.
                pass

        # Prefer raw file with comments if it exists
        if raw_exists:
            try:
                with open(sel_raw, "r", encoding="utf-8") as f:
                    raw = f.read()
                return _no_cache(current_app.response_class(raw, mimetype="application/json"))
            except FileNotFoundError:
                pass

        # If raw JSONC file does not exist yet, but the main JSON file already
        # contains JSONC-style comments (some users keep comments in *.json),
        # do a one-time auto-migration:
        #   - create <name>.jsonc with comments for the editor
        #   - rewrite <name>.json as clean JSON for Xray
        # This makes the behavior predictable after first open.
        if main_exists and (not raw_exists):
            try:
                with open(sel_main, "r", encoding="utf-8") as f:
                    main_text = f.read()

                cleaned_main = strip_json_comments_text(main_text)

                # If stripping changes the content, we likely had real comments.
                # (URLs like https:// are inside strings and are preserved.)
                if main_text != cleaned_main:
                    # Validate and normalize the uncommented JSON first.
                    obj = json.loads(cleaned_main or "{}")
                    pretty_clean = json.dumps(obj, ensure_ascii=False, indent=2)

                    # Ensure directory exists for raw file
                    try:
                        raw_dir = os.path.dirname(sel_raw) or "."
                        os.makedirs(raw_dir, exist_ok=True)
                    except Exception:
                        pass

                    def _atomic_write_text(p: str, content: str) -> None:
                        tmp = f"{p}.tmp"
                        with open(tmp, "w", encoding="utf-8", newline="\n") as wf:
                            wf.write(content)
                        os.replace(tmp, p)

                    # Write clean JSON first, then raw JSONC last so raw has newer mtime
                    # and the editor continues to prefer it.
                    try:
                        _atomic_write_text(sel_main, pretty_clean.rstrip("\n") + "\n")
                    except Exception as e:
                        _core_log(
                            "warning",
                            "routing: automigrate: failed to rewrite main json",
                            file=sel_main,
                            err=str(e),
                        )

                    migrated_ok = False
                    try:
                        _atomic_write_text(sel_raw, main_text.rstrip("\n") + "\n")
                        migrated_ok = True
                        _core_log(
                            "info",
                            "routing: automigrated json-with-comments to jsonc",
                            main=sel_main,
                            raw=sel_raw,
                        )
                    except Exception as e:
                        _core_log(
                            "warning",
                            "routing: automigrate: failed to create raw jsonc",
                            file=sel_raw,
                            err=str(e),
                        )

                    if migrated_ok:
                        try:
                            bn_main = os.path.basename(sel_main)
                            bn_raw = os.path.basename(sel_raw)
                            notice = f"Обнаружены комментарии в {bn_main} → выполнена миграция в {bn_raw}"
                        except Exception:
                            notice = "Обнаружены комментарии в routing.json → выполнена миграция в routing.jsonc"
                        return _no_cache(
                            current_app.response_class(main_text, mimetype="application/json"),
                            notice=notice,
                            kind="info",
                        )

                    return _no_cache(current_app.response_class(main_text, mimetype="application/json"))
            except Exception as e:
                _core_log("warning", "routing: automigrate: unexpected error", err=str(e))

        # Fallback: pretty-print cleaned JSON from main file
        data = load_json(sel_main, default={})
        if data is None:
            text = ""
        else:
            text = json.dumps(data, ensure_ascii=False, indent=2)
        return _no_cache(current_app.response_class(text, mimetype="application/json"))


    @bp.post("/api/routing")
    def api_set_routing() -> Any:
        """Accept raw routing JSON with comments, validate it and save.

        Supports optional query param ``?file=<name>`` to choose a fragment file.

        - Raw body (with comments) is saved to <fragment>.jsonc
        - Cleaned JSON (without comments) is written to <fragment>.json
        """
        raw_bytes = request.get_data(cache=False)
        try:
            raw_text = raw_bytes.decode("utf-8")
        except UnicodeDecodeError:
            try:
                raw_text = raw_bytes.decode("utf-8", errors="replace")
            except Exception:
                return jsonify({"ok": False, "error": "cannot decode body as utf-8"}), 400

        if not raw_text.strip():
            return jsonify({"ok": False, "error": "empty body"}), 400

        # Allow saving into a selected routing fragment by filename.
        file_arg = request.args.get("file", "")
        try:
            sel_main, sel_raw = _paths_for_routing(file_arg)
        except Exception:
            sel_main, sel_raw = ROUTING_FILE, ROUTING_FILE_RAW


        # Remove comments and validate JSON
        cleaned = strip_json_comments_text(raw_text)
        try:
            obj = json.loads(cleaned)
        except Exception as e:
            return jsonify({"ok": False, "error": f"invalid json: {e}"}), 400

        # Auto-create snapshots before overwrite.
        try:
            if _snapshot_before_overwrite and BACKUP_DIR and BACKUP_DIR_REAL:
                _snapshot_before_overwrite(
                    sel_main,
                    backup_dir=BACKUP_DIR,
                    xray_configs_dir_real=XRAY_CONFIGS_DIR_REAL,
                    backup_dir_real=BACKUP_DIR_REAL,
                )
                _snapshot_before_overwrite(
                    sel_raw,
                    backup_dir=BACKUP_DIR,
                    xray_configs_dir_real=XRAY_CONFIGS_DIR_REAL,
                    backup_dir_real=BACKUP_DIR_REAL,
                )
        except Exception:
            pass

        # IMPORTANT: write clean JSON first, then raw JSONC last.
        # api_get_routing prefers *.jsonc when it is newer than *.json.
        def _atomic_write_text(path: str, content: str) -> None:
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8", newline="\n") as wf:
                wf.write(content)
            os.replace(tmp, path)

        def _atomic_write_json(path: str, obj: Any) -> None:
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8", newline="\n") as wf:
                json.dump(obj, wf, ensure_ascii=False, indent=2)
                wf.write("\n")
            os.replace(tmp, path)

        # Save cleaned JSON for xkeen/xray (main file)
        try:
            d = os.path.dirname(sel_main)
            if d and not os.path.isdir(d):
                os.makedirs(d, exist_ok=True)
            _atomic_write_json(sel_main, obj)
        except Exception as e:
            return jsonify({"ok": False, "error": f"failed to write routing file: {e}"}), 500

        # Save raw text (with comments) last so it stays newer and is shown in UI
        try:
            d_raw = os.path.dirname(sel_raw)
            if d_raw and not os.path.isdir(d_raw):
                os.makedirs(d_raw, exist_ok=True)
            _atomic_write_text(sel_raw, raw_text)
        except Exception as e:
            return jsonify({"ok": False, "error": f"failed to write raw file: {e}"}), 500

        restart_arg = request.args.get("restart", None)
        restart_flag = True
        if restart_arg is not None:
            restart_arg = restart_arg.strip().lower()
            restart_flag = restart_arg in ("1", "true", "yes", "on", "y")
        restarted = restart_flag and restart_xkeen(source="routing")
        _core_log("info", "routing.save", restarted=bool(restarted), restart_flag=bool(restart_flag), remote_addr=str(request.remote_addr or ""))

        return jsonify({"ok": True, "restarted": restarted}), 200


    # -------------------- Routing templates API --------------------

    @bp.get("/api/routing/templates")
    def api_list_routing_templates() -> Any:
        """List available routing templates (local files)."""
        items = []
        try:
            os.makedirs(ROUTING_TEMPLATES_DIR, exist_ok=True)
        except Exception:
            pass

        try:
            names = []
            for n in os.listdir(ROUTING_TEMPLATES_DIR):
                if not (n.endswith(".json") or n.endswith(".jsonc")):
                    continue
                # Ignore old/legacy meta files if they exist.
                if n.startswith("_routing_templates_meta"):
                    continue
                p = os.path.join(ROUTING_TEMPLATES_DIR, n)
                if os.path.isfile(p):
                    names.append(n)
        except Exception:
            names = []

        # Stable ordering: known templates first, then alphabetical.
        try:
            known = [n for n in _TEMPLATE_META.keys() if n in names]
            rest = sorted([n for n in names if n not in _TEMPLATE_META])
            names = known + rest
        except Exception:
            names = sorted(names)

        for fname in names:
            path = os.path.join(ROUTING_TEMPLATES_DIR, fname)
            meta: Dict[str, str] = {}
            try:
                meta = _read_template_file_meta(path)
            except Exception:
                meta = {}

            # Built-in meta fallback (nice titles for shipped presets)
            builtin_meta = _TEMPLATE_META.get(fname, {})
            title = (meta.get("title") or builtin_meta.get("title") or fname)
            desc = (meta.get("description") or builtin_meta.get("description") or "")
            builtin = fname in _TEMPLATE_META

            items.append({
                "filename": fname,
                "title": title,
                "description": desc,
                "builtin": bool(builtin),
            })
        # Backward/forward compatibility with the UI JS:
        # some versions expect key "templates", others "items".
        return jsonify({"ok": True, "items": items, "templates": items})


    @bp.get("/api/routing/templates/<string:filename>")
    def api_get_routing_template(filename: str) -> Any:
        """Return a template file content as text/plain."""
        fname = str(filename or "").strip()
        # Simple sanitization: no path separators
        if not fname or "/" in fname or "\\" in fname:
            return error_response("invalid template name", 400, ok=False)
        if not (fname.endswith(".json") or fname.endswith(".jsonc")):
            return error_response("invalid template extension", 400, ok=False)

        path = os.path.join(ROUTING_TEMPLATES_DIR, fname)
        if not os.path.isfile(path):
            return error_response("template not found", 404, ok=False)
        try:
            with open(path, "r", encoding="utf-8") as f:
                text = f.read()
        except Exception as e:
            return error_response(f"failed to read template: {e}", 500, ok=False)

        resp = current_app.response_class(text, mimetype="text/plain; charset=utf-8")
        try:
            resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
            resp.headers["Pragma"] = "no-cache"
            resp.headers["Expires"] = "0"
        except Exception:
            pass
        return resp


    # ---------- Create/update/delete user templates ----------

    _SAFE_TEMPLATE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

    def _normalize_template_filename(raw: str) -> str:
        name = str(raw or "").strip()
        name = re.sub(r"\s+", "_", name)
        # no path traversal
        if not name or "/" in name or "\\" in name or "\x00" in name:
            return ""
        # default extension
        if not (name.endswith(".json") or name.endswith(".jsonc")):
            name = name + ".jsonc"
        base = name
        if base.endswith(".jsonc"):
            base = base[:-6]
        elif base.endswith(".json"):
            base = base[:-5]
        if not _SAFE_TEMPLATE_NAME_RE.match(base):
            return ""
        return name

    def _compose_template_text(title: str, desc: str, content: str) -> str:
        body = _strip_existing_template_header(content)
        t = str(title or "").strip()
        d = str(desc or "").strip()
        if not t and not d:
            return body
        meta_obj: Dict[str, str] = {}
        if t:
            meta_obj["title"] = t
        if d:
            meta_obj["description"] = d
        header = "// xkeen-template: " + json.dumps(meta_obj, ensure_ascii=False)
        return header + "\n" + body.lstrip("\n")


    @bp.post("/api/routing/templates")
    def api_save_routing_template() -> Any:
        """Create/update a user routing template.

        JSON body:
          {
            "filename": "my_template.jsonc",
            "content": "...jsonc...",
            "title": "..." (optional),
            "description": "..." (optional),
            "overwrite": true/false
          }
        """
        data = request.get_json(silent=True) or {}
        fname = _normalize_template_filename(data.get("filename") or data.get("name") or "")
        if not fname:
            return error_response("invalid template name", 400, ok=False)

        # Do not allow overwriting/deleting built-in templates via this endpoint.
        if fname in _TEMPLATE_META:
            return error_response("built-in templates cannot be overwritten", 403, ok=False)

        content = str(data.get("content") or "")
        if not content.strip():
            return error_response("empty content", 400, ok=False)

        overwrite = bool(data.get("overwrite"))
        title = str(data.get("title") or "")
        desc = str(data.get("description") or "")

        # Validate JSONC content (strip comments -> JSON)
        try:
            cleaned = strip_json_comments_text(content)
            json.loads(cleaned)
        except Exception as e:
            return error_response(f"invalid json/jsonc: {e}", 400, ok=False)

        try:
            os.makedirs(ROUTING_TEMPLATES_DIR, exist_ok=True)
        except Exception:
            pass

        path = os.path.join(ROUTING_TEMPLATES_DIR, fname)
        exists = os.path.isfile(path)
        if exists and not overwrite:
            return error_response("template already exists", 409, ok=False)

        # "Бережный" overwrite: keep old title/description if user left them empty.
        if exists and overwrite and (not title.strip() or not desc.strip()):
            try:
                old_meta = _read_template_file_meta(path)
            except Exception:
                old_meta = {}
            if not title.strip():
                title = str(old_meta.get("title") or "")
            if not desc.strip():
                desc = str(old_meta.get("description") or "")

        final_text = _compose_template_text(title, desc, content)

        try:
            tmp_path = path + ".tmp"
            with open(tmp_path, "w", encoding="utf-8") as f:
                f.write(final_text)
            os.replace(tmp_path, path)
        except Exception as e:
            return error_response(f"failed to write template: {e}", 500, ok=False)

        # Return updated meta as the UI expects it.
        out_meta = _read_template_file_meta(path)
        return jsonify({
            "ok": True,
            "filename": fname,
            "title": out_meta.get("title") or fname,
            "description": out_meta.get("description") or "",
            "builtin": False,
        })


    @bp.delete("/api/routing/templates/<string:filename>")
    def api_delete_routing_template(filename: str) -> Any:
        """Delete a user routing template file."""
        fname = _normalize_template_filename(filename)
        if not fname:
            return error_response("invalid template name", 400, ok=False)
        if fname in _TEMPLATE_META:
            return error_response("built-in templates cannot be deleted", 403, ok=False)

        path = os.path.join(ROUTING_TEMPLATES_DIR, fname)
        if not os.path.isfile(path):
            return error_response("template not found", 404, ok=False)
        try:
            os.remove(path)
        except Exception as e:
            return error_response(f"failed to delete template: {e}", 500, ok=False)
        return jsonify({"ok": True, "deleted": fname})


    @bp.post("/api/routing/dat/update")
    def api_update_dat() -> Any:
        """Download a .dat file from URL into local filesystem (allowed roots only)."""
        data = request.get_json(silent=True) or {}
        path = str(data.get("path") or "").strip()
        url = str(data.get("url") or "").strip()
        kind = str(data.get("kind") or "").strip().lower()

        if not path:
            return error_response("path_required", 400, ok=False)
        if not url:
            return error_response("url_required", 400, ok=False)
        if not (url.startswith("http://") or url.startswith("https://")):
            return error_response("bad_url", 400, ok=False)
        if not path.lower().endswith(".dat"):
            return error_response("path_must_end_with_dat", 400, ok=False)

        try:
            roots = _local_allowed_roots()
            rp = _local_resolve(path, roots)
        except PermissionError as e:
            return error_response(str(e), 403, ok=False)

        max_mb_raw = str(os.getenv("XKEEN_MAX_DAT_MB", "128") or "128").strip()
        try:
            max_mb = int(float(max_mb_raw))
        except Exception:
            max_mb = 128
        max_bytes = None if max_mb <= 0 else max_mb * 1024 * 1024

        parent = os.path.dirname(rp)
        if parent and not os.path.isdir(parent):
            try:
                os.makedirs(parent, exist_ok=True)
            except Exception as e:
                return error_response(f"mkdir_failed: {e}", 500, ok=False)

        st0 = None
        try:
            if os.path.exists(rp):
                st0 = os.stat(rp)
        except Exception:
            st0 = None

        tmp_path = rp + ".tmp"
        try:
            size = _download_to_file(url, tmp_path, max_bytes)
            os.replace(tmp_path, rp)
            _apply_local_metadata_best_effort(rp, st0)
        except RuntimeError as e:
            try:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
            except Exception:
                pass
            msg = str(e) or ""
            if msg == "size_limit":
                return error_response("size_limit", 413, ok=False, max_mb=max_mb)
            return error_response("download_failed", 400, ok=False, details=msg)
        except (urllib.error.URLError, urllib.error.HTTPError) as e:
            try:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
            except Exception:
                pass
            return error_response(f"download_failed: {e}", 400, ok=False)
        except Exception as e:
            try:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
            except Exception:
                pass
            return error_response(f"download_failed: {e}", 400, ok=False)

        _core_log("info", "routing.dat_update", kind=kind, path=rp, url=url, size=size, remote_addr=str(request.remote_addr or ""))
        return jsonify({"ok": True, "path": rp, "size": size}), 200

    return bp
