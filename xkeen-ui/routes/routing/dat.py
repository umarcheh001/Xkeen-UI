"""/api/routing/dat/* endpoints.

Moved from routes_routing.py as part of refactor checklist (B3 step 6).
"""

from __future__ import annotations

import os
import subprocess
import urllib.error
from typing import Any, Dict

from flask import Blueprint, request, jsonify

from routes.common.errors import error_response

from services.fs_common.local import _local_allowed_roots, _local_resolve

from services.geodat.cache import (
    _geodat_cache_get,
    _geodat_cache_set,
    _geodat_inflight_acquire,
    _geodat_inflight_release,
    _geodat_page_window,
)
from services.geodat.runner import (
    _geodat_bin_path,
    _geodat_cache_ttl_s,
    _geodat_timeout_s,
    _geodat_validate,
    _run_xk_geodat_json,
)
from services.geodat.install import _download_to_file

from services.filemanager.metadata import _apply_local_metadata_best_effort

from services.xray_assets import ensure_xray_dat_assets

from .errors import _geodat_error_payload, _geodat_missing_bin_payload


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


def register_dat_routes(bp: Blueprint) -> None:
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

        argv = [bin_path, 'tags', '--kind', k, '--path', rp]
        try:
            data = _run_xk_geodat_json(argv, timeout_s=timeout_s)
        except subprocess.TimeoutExpired:
            payload_err = _geodat_error_payload('xk_geodat_timeout', kind=k, path=rp)
            _geodat_cache_set(key, payload_err, min(ttl_s, 10))
            return jsonify(payload_err), 200
        except Exception as e:
            payload_err = _geodat_error_payload('xk_geodat_failed', kind=k, path=rp, details=str(e))
            _geodat_cache_set(key, payload_err, min(ttl_s, 10))
            return jsonify(payload_err), 200
        finally:
            try:
                if is_leader:
                    _geodat_inflight_release(key, ev)
            except Exception:
                pass

        # xk-geodat historically returned either:
        #   1) {"tags": ["CN", "US", ...]}
        #   2) {"tags": [{"tag":"CN","count":123}, ...]}
        #   3) ["CN", ...] / [{"tag":...,"count":...}, ...]
        # During refactor we mistakenly `str()`-casted dict items which produced
        # strings like "{'tag': 'CN', 'count': 1}" and broke the UI.
        tags: list[dict[str, Any]] = []

        def _norm_tag_item(x: Any) -> dict[str, Any] | None:
            if x is None:
                return None
            if isinstance(x, str):
                t = x.strip()
                return {"tag": t, "count": None} if t else None
            if isinstance(x, dict):
                # accept both {tag,count} and short {t,c}
                t = x.get("tag") if "tag" in x else x.get("t")
                c = x.get("count") if "count" in x else x.get("c")
                t = str(t or "").strip()
                if not t:
                    return None
                # keep count as int if possible, else null
                try:
                    c = int(c) if c is not None else None
                except Exception:
                    c = None
                return {"tag": t, "count": c}
            # fallback
            s = str(x).strip()
            return {"tag": s, "count": None} if s else None

        raw_tags: Any = None
        if isinstance(data, dict) and isinstance(data.get("tags"), list):
            raw_tags = data.get("tags")
        elif isinstance(data, list):
            raw_tags = data

        if isinstance(raw_tags, list):
            for it in raw_tags:
                v = _norm_tag_item(it)
                if v:
                    tags.append(v)

        payload: Dict[str, Any] = {
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

        bin_path = _geodat_bin_path()
        if not os.path.isfile(bin_path):
            payload, status = _geodat_missing_bin_payload()
            payload = _geodat_error_payload(payload.get('error','missing_xk_geodat'), kind=k, path=rp)
            _geodat_cache_set(('tagerr', k, rp, meta.get('size'), meta.get('mtime'), tag), payload, min(ttl_s, 10))
            return jsonify(payload), status

        # Windowed paging cache
        win = _geodat_page_window()
        fetch_limit = max(limit, win)
        fetch_limit = max(1, min(fetch_limit, 500))
        win_offset = (offset // fetch_limit) * fetch_limit

        key_win = ('tagwin', k, rp, meta.get('size'), meta.get('mtime'), tag, win_offset, fetch_limit)
        cached_win = _geodat_cache_get(key_win, ttl_s)

        if cached_win is None:
            # Prevent cache stampede
            ev, is_leader = _geodat_inflight_acquire(key_win)
            if not is_leader:
                try:
                    ev.wait(timeout=2.0)
                except Exception:
                    pass
                cached_win = _geodat_cache_get(key_win, ttl_s)
                if cached_win is None:
                    ev, is_leader = _geodat_inflight_acquire(key_win)

            if cached_win is None:
                timeout_s = _geodat_timeout_s()
                argv_dump = [
                    bin_path, 'dump', '--kind', k, '--path', rp, '--tag', tag,
                    '--offset', str(win_offset), '--limit', str(fetch_limit)
                ]
                try:
                    try:
                        data = _run_xk_geodat_json(argv_dump, timeout_s=timeout_s)
                    except RuntimeError as e:
                        msg = (str(e) or '').lower()
                        if 'unknown command' in msg:
                            argv_tag = [
                                bin_path, 'tag', '--kind', k, '--path', rp, '--tag', tag,
                                '--offset', str(win_offset), '--limit', str(fetch_limit)
                            ]
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

    @bp.post('/api/routing/dat/update')
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

        _core_log(
            "info",
            "routing.dat_update",
            kind=kind,
            path=rp,
            url=url,
            size=size,
            remote_addr=str(request.remote_addr or ""),
        )

        # Keep Xray asset lookup working for `ext:*.dat:*` rules by ensuring
        # DAT files from /opt/etc/xray/dat are reachable via /opt/sbin.
        try:
            dat_dir = os.environ.get("XRAY_DAT_DIR") or "/opt/etc/xray/dat"
            # Only touch links when the updated file is in the Xray dat folder.
            if rp.startswith(dat_dir.rstrip("/") + "/"):
                asset_dir = os.environ.get("XRAY_ASSET_DIR") or "/opt/sbin"
                ensure_xray_dat_assets(
                    dat_dir=dat_dir,
                    asset_dir=asset_dir,
                    log=lambda line: _core_log("info", line),
                )
        except Exception as e:  # noqa: BLE001
            _core_log("warning", "xray_assets_sync_failed", error=str(e), path=rp)

        return jsonify({"ok": True, "path": rp, "size": size}), 200
