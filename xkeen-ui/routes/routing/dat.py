"""/api/routing/dat/* endpoints.

Moved from routes_routing.py as part of refactor checklist (B3 step 6).
"""

from __future__ import annotations

import os
import subprocess
import urllib.error
import urllib.parse
from typing import Any, Dict

import ipaddress

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
from services.geodat.install import _is_elf_binary

from services.filemanager.metadata import _apply_local_metadata_best_effort

from services.url_policy import (
    blocked_url_hint,
    download_to_file_with_policy,
    get_policy_from_env,
    is_url_allowed as is_url_allowed_for_policy,
)

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


def _dat_url_policy():
    return get_policy_from_env("XKEEN_DAT")


def _dat_url_block_response(reason: str):
    policy = _dat_url_policy()
    return error_response(
        "url_blocked",
        400,
        ok=False,
        reason=str(reason or "").strip() or "blocked",
        hint=blocked_url_hint(
            policy,
            env_prefix="XKEEN_DAT",
            feature_label="Обновление DAT по URL",
        ),
    )


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
        # Guard: sometimes network/captive portal saves HTML instead of a binary.
        if not _is_elf_binary(bin_path):
            payload, status = _geodat_missing_bin_payload()
            payload["hint"] = "xk-geodat установлен некорректно (файл не ELF). Проверьте доступ к GitHub или установите правильный бинарник вручную."
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

    @bp.get('/api/routing/dat/search')
    def api_dat_tag_search() -> Any:
        """Server-side search inside a single tag.

        Used by the DAT modal's 3rd search field in "Весь тег" mode.
        Scans items in the selected tag on backend and returns matches.

        Query args:
          kind=geosite|geoip
          path=/path/file.dat
          tag=TAG
          q=search string
          mode=contains|ipin (optional; default: auto)
          cursor=offset inside tag to continue scan (default 0)
          limit=max matches to return (default 200)

        Response:
          {ok:true, items:[{t,v}], next_cursor:int|null, viewed:int, scanned:int, total?:int}
        """

        kind = request.args.get('kind', '')
        path = request.args.get('path', '')
        tag = (request.args.get('tag', '') or '').strip()
        q_raw = (request.args.get('q', '') or request.args.get('query', '') or '').strip()
        mode_raw = (request.args.get('mode', '') or '').strip().lower()
        cursor_raw = (request.args.get('cursor', '') or request.args.get('scan_offset', '') or '').strip()
        limit_raw = (request.args.get('limit', '') or '').strip()

        if not tag:
            return error_response('tag_required', 400, ok=False)
        if not q_raw:
            return jsonify({'ok': True, 'kind': str(kind or ''), 'path': str(path or ''), 'tag': tag, 'q': '', 'items': [], 'next_cursor': None, 'viewed': 0, 'scanned': 0}), 200
        if len(q_raw) > 512:
            return error_response('q_too_long', 400, ok=False)

        if mode_raw and mode_raw not in ('contains', 'ipin'):
            return error_response('bad_mode', 400, ok=False)

        try:
            cursor = int(cursor_raw or '0')
        except Exception:
            cursor = 0
        try:
            limit = int(limit_raw or '200')
        except Exception:
            limit = 200
        cursor = max(0, cursor)
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
            payload = _geodat_error_payload(payload.get('error', 'missing_xk_geodat'), kind=k, path=rp)
            _geodat_cache_set(('searcherr', k, rp, meta.get('size'), meta.get('mtime'), tag), payload, min(ttl_s, 10))
            return jsonify(payload), status

        q_norm = q_raw.strip().lower()

        def _try_parse_ip(s: str) -> ipaddress._BaseAddress | None:
            """Best-effort parse of IP query for GeoIP searching."""
            ss = (s or '').strip()
            if not ss:
                return None
            # URL
            try:
                if '://' in ss:
                    u = urllib.parse.urlparse(ss)
                    if u.hostname:
                        ss = str(u.hostname)
            except Exception:
                pass
            # [IPv6]:port
            try:
                if ss.startswith('[') and ']' in ss:
                    ss = ss[1:ss.index(']')]
            except Exception:
                pass
            # strip cidr
            try:
                ss = ss.split('/', 1)[0]
            except Exception:
                pass
            # host:port for IPv4
            try:
                if ':' in ss and '.' in ss:
                    ss = ss.split(':', 1)[0]
            except Exception:
                pass
            ss = ss.strip()
            try:
                return ipaddress.ip_address(ss)
            except Exception:
                return None

        # Auto mode:
        # - For GeoIP, if query parses as IP => membership (IP ∈ CIDR)
        # - Otherwise => substring contains
        mode = mode_raw or 'contains'
        ip_q = None
        if mode_raw == 'ipin':
            ip_q = _try_parse_ip(q_raw)
            if ip_q is None:
                return error_response('bad_ip', 400, ok=False)
        elif mode_raw == '' and k == 'geoip':
            ip_q = _try_parse_ip(q_raw)
            if ip_q is not None:
                mode = 'ipin'

        # Safety/perf limits.
        # GeoSite tags are small-ish; GeoIP can be huge, so we scan in chunks and cap scanned items per request.
        max_scan = 20000 if k == 'geosite' else 50000
        chunk = 2000  # xk-geodat dump caps at 2000

        # Cache tag windows (larger than the UI paging window) for a short time.
        win_ttl = min(ttl_s, 15)

        def _get_window(off: int, lim: int) -> Dict[str, Any]:
            key_win = ('searchwin', k, rp, meta.get('size'), meta.get('mtime'), tag, int(off), int(lim))
            cached = _geodat_cache_get(key_win, win_ttl)
            if cached is not None:
                return cached

            ev, is_leader = _geodat_inflight_acquire(key_win)
            if not is_leader:
                try:
                    ev.wait(timeout=2.0)
                except Exception:
                    pass
                cached2 = _geodat_cache_get(key_win, win_ttl)
                if cached2 is not None:
                    return cached2
                ev, is_leader = _geodat_inflight_acquire(key_win)

            try:
                timeout_s = _geodat_timeout_s()
                argv_dump = [
                    bin_path, 'dump', '--kind', k, '--path', rp, '--tag', tag,
                    '--offset', str(off), '--limit', str(lim),
                ]
                data = _run_xk_geodat_json(argv_dump, timeout_s=timeout_s)

                items_full: list[Any] = []
                total_val = None
                if isinstance(data, dict):
                    if isinstance(data.get('items'), list):
                        items_full = data.get('items')  # type: ignore[assignment]
                    if isinstance(data.get('total'), int):
                        total_val = int(data.get('total'))
                elif isinstance(data, list):
                    items_full = data

                out: Dict[str, Any] = {
                    'ok': True,
                    'kind': k,
                    'path': rp,
                    'meta': meta,
                    'tag': tag,
                    'offset': int(off),
                    'limit': int(lim),
                    'items': items_full,
                }
                if total_val is not None:
                    out['total'] = total_val

                _geodat_cache_set(key_win, out, win_ttl, max_items=64)
                return out
            except subprocess.TimeoutExpired:
                return _geodat_error_payload('xk_geodat_timeout', kind=k, path=rp)
            except Exception as e:
                return _geodat_error_payload('xk_geodat_failed', kind=k, path=rp, details=str(e))
            finally:
                try:
                    if is_leader:
                        _geodat_inflight_release(key_win, ev)
                except Exception:
                    pass

        matches: list[Dict[str, Any]] = []
        scanned = 0
        cur = cursor
        total = None
        reached_end = False

        def _extract_tv(it: Any) -> tuple[str, str]:
            if isinstance(it, dict):
                t = str(it.get('t') or it.get('type') or '')
                v = it.get('v') if it.get('v') is not None else it.get('value')
                v = '' if v is None else str(v)
                return t, v
            return '', str(it)

        def _ip_in_item(ipv: ipaddress._BaseAddress, it: Any) -> bool:
            _t, v = _extract_tv(it)
            s = (v or '').strip()
            if not s:
                return False
            # CIDR
            try:
                if '/' in s:
                    net = ipaddress.ip_network(s, strict=False)
                    return ipv in net
            except Exception:
                pass
            # Single IP
            try:
                if ':' in s or '.' in s:
                    ip2 = ipaddress.ip_address(s)
                    return ipv == ip2
            except Exception:
                pass
            # Range: a-b
            try:
                if '-' in s:
                    a, b = [x.strip() for x in s.split('-', 1)]
                    ia = ipaddress.ip_address(a)
                    ib = ipaddress.ip_address(b)
                    iv = int(ipv)
                    return int(ia) <= iv <= int(ib)
            except Exception:
                pass
            return False

        while len(matches) < limit and scanned < max_scan:
            fetch = min(chunk, max_scan - scanned)
            win = _get_window(cur, fetch)
            if not win or win.get('ok') is not True:
                return jsonify(win or _geodat_error_payload('xk_geodat_failed', kind=k, path=rp, details='cache_empty')), 200

            if isinstance(win.get('total'), int):
                total = int(win.get('total'))

            items_any = win.get('items') or []
            items_list = list(items_any) if isinstance(items_any, list) else []
            if not items_list:
                reached_end = True
                break

            for it in items_list:
                if len(matches) >= limit:
                    break
                try:
                    t, v = _extract_tv(it)
                    if mode == 'ipin':
                        if ip_q is not None and _ip_in_item(ip_q, it):
                            matches.append({'t': t, 'v': v})
                    else:
                        hay = (t + ' ' + v).lower()
                        if q_norm in hay:
                            matches.append({'t': t, 'v': v})
                except Exception:
                    continue

            scanned += len(items_list)
            cur += len(items_list)

            # End conditions.
            if len(items_list) < fetch:
                reached_end = True
                break
            if total is not None and cur >= total:
                reached_end = True
                break

        # If we likely haven't reached the end, allow continuing.
        next_cursor = None
        if reached_end:
            next_cursor = None
        elif scanned >= max_scan:
            next_cursor = cur
        else:
            if total is None:
                next_cursor = cur
            else:
                next_cursor = cur if cur < total else None

        payload: Dict[str, Any] = {
            'ok': True,
            'kind': k,
            'path': rp,
            'meta': meta,
            'tag': tag,
            'q': q_raw,
            'mode': mode,
            'cursor': cursor,
            'viewed': cur,
            'scanned': scanned,
            'max_scan': max_scan,
            'items': matches,
            'next_cursor': next_cursor,
        }
        if mode == 'ipin' and ip_q is not None:
            payload['ip'] = str(ip_q)
        if total is not None:
            payload['total'] = total
        return jsonify(payload), 200

    @bp.post('/api/routing/dat/lookup')
    def api_dat_lookup() -> Any:
        """Lookup tags by domain/IP inside geoip/geosite DAT via xk-geodat.

        Input JSON:
          {kind:'geosite'|'geoip', path:'/path/file.dat', value:'example.com'|'1.2.3.4'}

        Output:
          {ok:true, matches:[{tag:'...',count:null}]}
        """
        data = request.get_json(silent=True) or {}
        kind = str(data.get('kind') or request.args.get('kind') or '').strip()
        path = str(data.get('path') or request.args.get('path') or '').strip()
        value_raw = str(data.get('value') or data.get('q') or request.args.get('value') or '').strip()

        if not value_raw:
            return error_response('value_required', 400, ok=False)
        if len(value_raw) > 2048:
            return error_response('value_too_long', 400, ok=False)

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

        def _norm_value(kind_: str, v: str) -> str:
            s = (v or '').strip()
            if not s:
                return ''
            # Accept full URLs like https://example.com/path
            try:
                if '://' in s:
                    u = urllib.parse.urlparse(s)
                    if u.hostname:
                        s = u.hostname
            except Exception:
                pass
            # host:port
            try:
                if ':' in s and kind_ == 'geosite':
                    # if it's not an IPv6, keep only host part
                    if not s.startswith('['):
                        s2 = s.split('/', 1)[0]
                        s2 = s2.split(':', 1)[0]
                        if s2:
                            s = s2
            except Exception:
                pass
            s = s.strip().strip('.').lower()
            # For geoip, normalize to a canonical IP if possible.
            if kind_ == 'geoip':
                try:
                    # allow inputs like "1.2.3.4/32" or "[2001:db8::1]:443"
                    s2 = s
                    if s2.startswith('[') and ']' in s2:
                        s2 = s2[1:s2.index(']')]
                    s2 = s2.split('/', 1)[0]
                    s2 = s2.split(':', 1)[0] if (':' in s2 and '.' in s2) else s2
                    s = str(ipaddress.ip_address(s2))
                except Exception:
                    # keep best-effort raw
                    pass
            return s

        value = _norm_value(k, value_raw)
        if not value:
            return error_response('value_required', 400, ok=False)

        ttl_s = _geodat_cache_ttl_s()
        key = ('lookup', k, rp, meta.get('size'), meta.get('mtime'), value)
        cached = _geodat_cache_get(key, ttl_s)
        if cached is not None:
            return jsonify(cached), 200

        bin_path = _geodat_bin_path()
        if not os.path.isfile(bin_path):
            payload, status = _geodat_missing_bin_payload()
            payload = _geodat_error_payload(payload.get('error', 'missing_xk_geodat'), kind=k, path=rp)
            _geodat_cache_set(key, payload, min(ttl_s, 10))
            return jsonify(payload), status
        if not _is_elf_binary(bin_path):
            payload, status = _geodat_missing_bin_payload()
            payload["hint"] = "xk-geodat установлен некорректно (файл не ELF). Проверьте доступ к GitHub или установите правильный бинарник вручную."
            _geodat_cache_set(key, payload, min(ttl_s, 10))
            return jsonify(payload), status

        # Prevent cache stampede
        ev, is_leader = _geodat_inflight_acquire(key)
        if not is_leader:
            try:
                ev.wait(timeout=2.0)
            except Exception:
                pass
            cached2 = _geodat_cache_get(key, ttl_s)
            if cached2 is not None:
                return jsonify(cached2), 200
            ev, is_leader = _geodat_inflight_acquire(key)

        timeout_s = _geodat_timeout_s()

        def _try_lookup() -> Any:
            # Primary: lookup --value
            argv1 = [bin_path, 'lookup', '--kind', k, '--path', rp, '--value', value]
            try:
                return _run_xk_geodat_json(argv1, timeout_s=timeout_s)
            except RuntimeError as e:
                msg = (str(e) or '').lower()
                if 'unknown command' in msg or 'unknown subcommand' in msg:
                    raise
                # Some builds may use --q/--query instead of --value
                argv2 = [bin_path, 'lookup', '--kind', k, '--path', rp, '--q', value]
                try:
                    return _run_xk_geodat_json(argv2, timeout_s=timeout_s)
                except Exception:
                    argv3 = [bin_path, 'lookup', '--kind', k, '--path', rp, '--query', value]
                    return _run_xk_geodat_json(argv3, timeout_s=timeout_s)

        try:
            data_out = _try_lookup()
        except subprocess.TimeoutExpired:
            payload_err = _geodat_error_payload('xk_geodat_timeout', kind=k, path=rp)
            _geodat_cache_set(key, payload_err, min(ttl_s, 10))
            return jsonify(payload_err), 200
        except RuntimeError as e:
            msg = (str(e) or '').lower()
            if 'unknown command' in msg or 'unknown subcommand' in msg:
                payload_err = _geodat_error_payload('lookup_not_supported', kind=k, path=rp)
                payload_err['hint'] = 'Ваша версия xk-geodat не поддерживает lookup. Обновите xk-geodat (кнопка ⬇︎ в модалке) и попробуйте снова.'
                _geodat_cache_set(key, payload_err, min(ttl_s, 10))
                return jsonify(payload_err), 200
            payload_err = _geodat_error_payload('xk_geodat_failed', kind=k, path=rp, details=str(e))
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

        matches: list[dict[str, Any]] = []

        def _norm_tag_item(x: Any) -> dict[str, Any] | None:
            if x is None:
                return None
            if isinstance(x, str):
                t = x.strip()
                return {"tag": t, "count": None} if t else None
            if isinstance(x, dict):
                t = x.get('tag') if 'tag' in x else (x.get('t') if 't' in x else x.get('name'))
                c = x.get('count') if 'count' in x else (x.get('c') if 'c' in x else None)
                t = str(t or '').strip()
                if not t:
                    return None
                try:
                    c = int(c) if c is not None else None
                except Exception:
                    c = None
                return {"tag": t, "count": c}
            s = str(x).strip()
            return {"tag": s, "count": None} if s else None

        raw_matches: Any = None
        if isinstance(data_out, dict):
            if isinstance(data_out.get('matches'), list):
                raw_matches = data_out.get('matches')
            elif isinstance(data_out.get('tags'), list):
                raw_matches = data_out.get('tags')
            elif isinstance(data_out.get('result'), list):
                raw_matches = data_out.get('result')
        elif isinstance(data_out, list):
            raw_matches = data_out

        if isinstance(raw_matches, list):
            seen = set()
            for it in raw_matches:
                v = _norm_tag_item(it)
                if not v:
                    continue
                low = str(v.get('tag') or '').lower()
                if not low or low in seen:
                    continue
                seen.add(low)
                matches.append(v)

        payload: Dict[str, Any] = {
            'ok': True,
            'kind': k,
            'path': rp,
            'meta': meta,
            'value': value,
            'matches': matches,
        }
        _geodat_cache_set(key, payload, ttl_s)
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
        if not path.lower().endswith(".dat"):
            return error_response("path_must_end_with_dat", 400, ok=False)

        policy = _dat_url_policy()
        ok_url, reason = is_url_allowed_for_policy(url, policy)
        if not ok_url:
            return _dat_url_block_response(reason)

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
            size = download_to_file_with_policy(url, tmp_path, max_bytes, policy=policy)
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
            if msg.startswith("url_blocked:"):
                return _dat_url_block_response(msg.split(":", 1)[1])
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
