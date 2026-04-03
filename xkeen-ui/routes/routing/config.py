"""/api/routing (get/set) endpoints.

Moved from routes_routing.py as part of refactor checklist (B3 step 6).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from typing import Any, Callable, Dict, Optional

from flask import Blueprint, request, jsonify, current_app

from services.command_jobs import create_command_job

from services.io.atomic import _atomic_write_json, _atomic_write_text

from services.routing.templates import _paths_for_routing

from services.xray_config_files import ensure_xray_jsonc_dir, XRAY_JSONC_DIR_REAL

from .errors import _no_cache

# Optional: auto-snapshot Xray config fragments on overwrite.
try:
    from services.xray_backups import snapshot_before_overwrite as _snapshot_before_overwrite
except Exception:
    _snapshot_before_overwrite = None


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


def _shorten_text(s: str, limit: int = 4000) -> str:
    s = str(s or '').strip()
    if len(s) <= limit:
        return s
    return s[:limit] + "\n... [truncated]"


def _run_xray_preflight(*, xray_configs_dir_real: str, sel_main: str, obj: Any) -> Dict[str, Any]:
    """Validate Xray configs with edited fragment injected into a temp confdir."""
    xray_bin = '/opt/sbin/xray' if os.path.exists('/opt/sbin/xray') else 'xray'
    confdir = xray_configs_dir_real or os.environ.get('XRAY_CONFDIR') or '/opt/etc/xray/configs'
    test_timeout = max(5, int(os.environ.get('XKEEN_XRAY_TEST_TIMEOUT', '15') or '15'))
    base_cmd = f'{xray_bin} -test -confdir {confdir}'

    if not os.path.isdir(confdir):
        return {
            'ok': False,
            'error': 'xray config dir not found',
            'phase': 'xray_test',
            'cmd': base_cmd,
            'timeout_s': test_timeout,
            'timed_out': False,
            'hint': 'Не найден каталог конфигурации Xray.',
        }

    try:
        with tempfile.TemporaryDirectory(prefix='xkeen-xray-test-') as tmpdir:
            for name in os.listdir(confdir):
                src = os.path.join(confdir, name)
                dst = os.path.join(tmpdir, name)
                try:
                    if os.path.isdir(src) and not os.path.islink(src):
                        shutil.copytree(src, dst, symlinks=True)
                    else:
                        shutil.copy2(src, dst, follow_symlinks=False)
                except FileNotFoundError:
                    continue

            target = os.path.join(tmpdir, os.path.basename(sel_main))
            d = os.path.dirname(target)
            if d and not os.path.isdir(d):
                os.makedirs(d, exist_ok=True)
            with open(target, 'w', encoding='utf-8') as f:
                json.dump(obj, f, ensure_ascii=False, indent=2)
                f.write('\n')

            cmd = [xray_bin, '-test', '-confdir', tmpdir]
            cmd_text = ' '.join(cmd)
            try:
                proc = subprocess.run(cmd, capture_output=True, text=True, timeout=test_timeout, check=False)
            except subprocess.TimeoutExpired as exc:
                return {
                    'ok': False,
                    'error': 'xray test timeout',
                    'phase': 'xray_test',
                    'cmd': cmd_text,
                    'timeout_s': test_timeout,
                    'timed_out': True,
                    'stdout': _shorten_text(getattr(exc, 'stdout', '') or ''),
                    'stderr': _shorten_text(getattr(exc, 'stderr', '') or ''),
                    'hint': 'Таймаут проверки конфигурации Xray.',
                }
            stdout = _shorten_text(proc.stdout or '')
            stderr = _shorten_text(proc.stderr or '')
            if proc.returncode == 0:
                return {
                    'ok': True,
                    'phase': 'xray_test',
                    'cmd': cmd_text,
                    'timeout_s': test_timeout,
                    'timed_out': False,
                    'stdout': stdout,
                    'stderr': stderr,
                }
            return {
                'ok': False,
                'error': 'xray test failed',
                'phase': 'xray_test',
                'cmd': cmd_text,
                'returncode': proc.returncode,
                'timeout_s': test_timeout,
                'timed_out': False,
                'stdout': stdout,
                'stderr': stderr,
                'hint': 'Xray не принял конфиг. Исправьте ошибку и повторите сохранение.',
            }
    except FileNotFoundError:
        return {
            'ok': False,
            'error': 'xray binary not found',
            'phase': 'xray_test',
            'cmd': base_cmd,
            'timeout_s': test_timeout,
            'timed_out': False,
            'hint': 'Не найден бинарник Xray для preflight-проверки.',
        }
    except Exception as exc:
        return {
            'ok': False,
            'error': f'preflight exception: {exc}',
            'phase': 'xray_test',
            'cmd': base_cmd,
            'timeout_s': test_timeout,
            'timed_out': False,
            'hint': 'Не удалось выполнить preflight-проверку Xray.',
        }


def register_config_routes(
    bp: Blueprint,
    *,
    routing_file: str,
    routing_file_raw: str,
    xray_configs_dir: str,
    xray_configs_dir_real: str,
    backup_dir: str,
    backup_dir_real: str,
    load_json: Callable[[str, Dict[str, Any]], Optional[Dict[str, Any]]],
    strip_json_comments_text: Callable[[str], str],
    restart_xkeen: Callable[..., bool],
) -> None:
    @bp.get("/api/routing")
    def api_get_routing() -> Any:
        """Return routing config as raw text with comments if available.

        Supports optional query param ``?file=<name>`` to choose a fragment file
        inside ``XRAY_CONFIGS_DIR``.
        """
        file_arg = request.args.get("file", "")
        try:
            sel_main, sel_raw, sel_raw_legacy = _paths_for_routing(
                routing_file,
                routing_file_raw,
                xray_configs_dir,
                xray_configs_dir_real,
                file_arg,
            )
        except Exception:
            # Fall back to default routing fragment; keep JSONC sidecar outside configs dir.
            try:
                sel_main, sel_raw, sel_raw_legacy = _paths_for_routing(
                    routing_file,
                    routing_file_raw,
                    xray_configs_dir,
                    xray_configs_dir_real,
                    None,
                )
            except Exception:
                sel_main = routing_file
                sel_raw = routing_file_raw
                sel_raw_legacy = ""

        # Prefer JSONC sidecar in the dedicated JSONC dir.
        # For backward compatibility, if legacy sidecar exists next to main JSON
        # (inside XRAY_CONFIGS_DIR), we can read/migrate it.
        raw_exists = os.path.exists(sel_raw)
        legacy_exists = bool(sel_raw_legacy) and (sel_raw_legacy != sel_raw) and os.path.exists(sel_raw_legacy)
        main_exists = os.path.exists(sel_main)

        def _wrap(text: str, *, found: bool, using_raw: bool, notice: Optional[str] = None, kind: str = "info"):
            """Build response with JSONC sidecar status in headers.

            UI can use these headers to show a small status badge without exposing absolute paths.
            """
            resp = current_app.response_class(text, mimetype="application/json")
            try:
                resp.headers["X-XKeen-JSONC"] = "1" if found else "0"
                resp.headers["X-XKeen-JSONC-Using"] = "1" if using_raw else "0"
                if found:
                    bn = ""
                    try:
                        if raw_exists:
                            bn = os.path.basename(sel_raw)
                        elif legacy_exists:
                            bn = os.path.basename(sel_raw_legacy)
                    except Exception:
                        bn = ""
                    if bn:
                        resp.headers["X-XKeen-JSONC-File"] = bn
            except Exception:
                pass
            return _no_cache(resp, notice=notice, kind=kind)

        # Best-effort migrate legacy raw into JSONC dir so Xray stops parsing it.
        if (not raw_exists) and legacy_exists:
            try:
                ensure_xray_jsonc_dir()
                with open(sel_raw_legacy, "r", encoding="utf-8") as f:
                    legacy_text = f.read()
                # Write canonical raw and remove legacy file.
                _atomic_write_text(sel_raw, legacy_text.rstrip("\n") + "\n")
                try:
                    os.remove(sel_raw_legacy)
                except Exception:
                    pass
                raw_exists = os.path.exists(sel_raw)
                legacy_exists = False
                _core_log(
                    "info",
                    "routing: migrated legacy jsonc out of configs dir",
                    legacy=sel_raw_legacy,
                    raw=sel_raw,
                )
            except Exception as e:
                _core_log(
                    "warning",
                    "routing: failed to migrate legacy jsonc",
                    legacy=sel_raw_legacy,
                    raw=sel_raw,
                    err=str(e),
                )

        # If legacy exists (and canonical does not), fall back to legacy for read.
        raw_for_read = sel_raw if raw_exists else (sel_raw_legacy if legacy_exists else "")

        if raw_for_read and main_exists:
            try:
                st_raw = os.stat(raw_for_read)
                st_main = os.stat(sel_main)
                raw_mtime_ns = getattr(st_raw, "st_mtime_ns", int(st_raw.st_mtime * 1_000_000_000))
                main_mtime_ns = getattr(st_main, "st_mtime_ns", int(st_main.st_mtime * 1_000_000_000))
                if main_mtime_ns > raw_mtime_ns:
                    with open(sel_main, "r", encoding="utf-8") as f:
                        text = f.read()
                    return _wrap(text, found=(raw_exists or legacy_exists), using_raw=False)
            except Exception:
                pass

        if raw_for_read:
            try:
                with open(raw_for_read, "r", encoding="utf-8") as f:
                    raw = f.read()
                return _wrap(raw, found=True, using_raw=True)
            except FileNotFoundError:
                pass

        # One-time auto-migration if main JSON contains comments.
        if main_exists and (not raw_exists) and (not legacy_exists):
            try:
                with open(sel_main, "r", encoding="utf-8") as f:
                    main_text = f.read()

                cleaned_main = strip_json_comments_text(main_text)

                if main_text != cleaned_main:
                    obj = json.loads(cleaned_main or "{}")
                    pretty_clean = json.dumps(obj, ensure_ascii=False, indent=2)

                    try:
                        ensure_xray_jsonc_dir()
                    except Exception:
                        pass

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
                        # We return the commented text, but from now on the canonical source is JSONC sidecar.
                        return _wrap(main_text, found=True, using_raw=True, notice=notice, kind="info")

                    return _wrap(main_text, found=False, using_raw=False)
            except Exception as e:
                _core_log("warning", "routing: automigrate: unexpected error", err=str(e))

        data = load_json(sel_main, default={})
        if data is None:
            text = ""
        else:
            text = json.dumps(data, ensure_ascii=False, indent=2)
        return _wrap(text, found=(raw_exists or legacy_exists), using_raw=False)

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

        file_arg = request.args.get("file", "")
        try:
            sel_main, sel_raw, sel_raw_legacy = _paths_for_routing(
                routing_file,
                routing_file_raw,
                xray_configs_dir,
                xray_configs_dir_real,
                file_arg,
            )
        except Exception:
            try:
                sel_main, sel_raw, sel_raw_legacy = _paths_for_routing(
                    routing_file,
                    routing_file_raw,
                    xray_configs_dir,
                    xray_configs_dir_real,
                    None,
                )
            except Exception:
                sel_main = routing_file
                sel_raw = routing_file_raw
                sel_raw_legacy = ""

        cleaned = strip_json_comments_text(raw_text)
        try:
            obj = json.loads(cleaned)
        except Exception as e:
            return jsonify({"ok": False, "error": f"invalid json: {e}"}), 400

        preflight = _run_xray_preflight(
            xray_configs_dir_real=xray_configs_dir_real,
            sel_main=sel_main,
            obj=obj,
        )
        if not preflight.get("ok"):
            _core_log(
                "warning",
                "routing.save.preflight_failed",
                file=os.path.basename(str(sel_main or "")),
                returncode=preflight.get("returncode"),
                error=str(preflight.get("error") or ""),
            )
            return jsonify({
                "ok": False,
                "error": "xray preflight failed",
                "phase": preflight.get("phase"),
                "cmd": preflight.get("cmd"),
                "returncode": preflight.get("returncode"),
                "timeout_s": preflight.get("timeout_s"),
                "timed_out": preflight.get("timed_out"),
                "stdout": preflight.get("stdout"),
                "stderr": preflight.get("stderr"),
                "hint": preflight.get("hint"),
            }), 400

        try:
            if _snapshot_before_overwrite and backup_dir and backup_dir_real:
                _snapshot_before_overwrite(
                    sel_main,
                    backup_dir=backup_dir,
                    xray_configs_dir_real=xray_configs_dir_real,
                    backup_dir_real=backup_dir_real,
                    xray_jsonc_dir_real=XRAY_JSONC_DIR_REAL,
                )
                _snapshot_before_overwrite(
                    sel_raw,
                    backup_dir=backup_dir,
                    xray_configs_dir_real=xray_configs_dir_real,
                    backup_dir_real=backup_dir_real,
                    xray_jsonc_dir_real=XRAY_JSONC_DIR_REAL,
                )
        except Exception:
            pass

        try:
            d = os.path.dirname(sel_main)
            if d and not os.path.isdir(d):
                os.makedirs(d, exist_ok=True)
            _atomic_write_json(sel_main, obj)
        except Exception as e:
            return jsonify({"ok": False, "error": f"failed to write routing file: {e}"}), 500

        try:
            d_raw = os.path.dirname(sel_raw)
            if d_raw and not os.path.isdir(d_raw):
                os.makedirs(d_raw, exist_ok=True)
            _atomic_write_text(sel_raw, raw_text)
        except Exception as e:
            return jsonify({"ok": False, "error": f"failed to write raw file: {e}"}), 500

        # After saving canonical raw JSONC outside configs dir, remove any legacy
        # sidecar next to main JSON so Xray won't parse it.
        try:
            if sel_raw_legacy and (sel_raw_legacy != sel_raw) and os.path.exists(sel_raw_legacy):
                os.remove(sel_raw_legacy)
        except Exception:
            pass

        restart_arg = request.args.get("restart", None)
        restart_flag = True
        if restart_arg is not None:
            restart_arg = restart_arg.strip().lower()
            restart_flag = restart_arg in ("1", "true", "yes", "on", "y")

        async_arg = request.args.get("async", None)
        async_flag = False
        if async_arg is not None:
            async_arg = str(async_arg).strip().lower()
            async_flag = async_arg in ("1", "true", "yes", "on", "y")

        # Restart xkeen: legacy sync mode or async job mode (?async=1).
        if restart_flag and async_flag:
            try:
                job = create_command_job(flag="-restart", stdin_data=None, cmd=None, use_pty=True)
                _core_log(
                    "info",
                    "routing.save.async_restart",
                    restart_job_id=str(job.id),
                    remote_addr=str(request.remote_addr or ""),
                )
                return (
                    jsonify(
                        {
                            "ok": True,
                            "restarted": False,
                            "restart_queued": True,
                            "restart_job_id": job.id,
                        }
                    ),
                    202,
                )
            except Exception as e:
                _core_log("warning", "routing.save.async_restart_failed", err=str(e))
                return jsonify({"ok": False, "error": f"failed to schedule restart job: {e}"}), 500

        restarted = restart_flag and restart_xkeen(source="routing")
        _core_log(
            "info",
            "routing.save",
            restarted=bool(restarted),
            restart_flag=bool(restart_flag),
            remote_addr=str(request.remote_addr or ""),
        )

        return jsonify({"ok": True, "restarted": restarted}), 200
