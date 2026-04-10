"""/api/routing/geodat/* endpoints.

Moved from routes_routing.py as part of refactor checklist (B3 step 6).
"""

from __future__ import annotations

import os
import subprocess
from typing import Any

from flask import Blueprint, current_app, request, jsonify
from werkzeug.exceptions import RequestEntityTooLarge

from services.geodat.runner import _geodat_bin_path
from services.geodat.install import _geodat_install_script_path, _geodat_run_help, _geodat_stat_meta, geodat_platform_info
from services.request_limits import (
    PayloadTooLargeError,
    get_geodat_upload_max_bytes,
    read_uploaded_file_bytes_limited,
)
from services.url_policy import (
    blocked_url_hint,
    download_to_file_with_policy,
    get_policy_from_env,
    is_url_allowed as is_url_allowed_for_policy,
)


def _short_reason(text: str, *, limit: int = 240) -> str:
    """Make stderr/stdout snippets UI-friendly (single line, truncated).

    We keep it short to fit toast notifications and avoid leaking long dumps.
    """
    s = (text or '').replace('\r', '').strip()
    if not s:
        return ''
    # Keep first non-empty lines, join with separators.
    lines = [ln.strip() for ln in s.split('\n') if ln.strip()]
    if not lines:
        return ''
    out = ' | '.join(lines[:3])
    if len(out) > limit:
        out = out[: max(0, limit - 3)] + '...'
    return out


def _log_exception(tag: str, exc: Exception, **extra) -> None:
    try:
        if extra:
            current_app.logger.exception("routing.geodat.%s | %r", tag, extra)
        else:
            current_app.logger.exception("routing.geodat.%s", tag)
    except Exception:
        pass


def _geodat_url_policy():
    return get_policy_from_env("XKEEN_GEODAT")


def _geodat_url_blocked_payload(reason: str) -> dict[str, Any]:
    policy = _geodat_url_policy()
    return {
        "ok": False,
        "error": "url_blocked",
        "reason": str(reason or "").strip() or "blocked",
        "hint": blocked_url_hint(
            policy,
            env_prefix="XKEEN_GEODAT",
            feature_label="Установка xk-geodat по URL",
        ),
    }


def register_geodat_routes(bp: Blueprint) -> None:
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
            "platform": geodat_platform_info(),
            "installed": bool(exists and ok_help),
            "path": bin_path,
            "meta": meta,
            "help": help_text,
            "reason": (_short_reason(help_text) if (exists and not ok_help) else ''),
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
            try:
                current_app.logger.error("routing.geodat.install_script_missing | path=%s", script_path)
            except Exception:
                pass
            return jsonify({
                "ok": False,
                "error": "install_script_missing",
                "hint": "Не найден скрипт установки xk-geodat на роутере.",
            }), 200

        bin_path = _geodat_bin_path()
        env = os.environ.copy()
        env["XKEEN_GEODAT_BIN"] = bin_path
        env["XKEEN_GEODAT_INSTALL"] = "1"  # non-interactive
        env.setdefault("XKEEN_GEODAT_TIMEOUT", os.getenv("XKEEN_GEODAT_TIMEOUT", "25") or "25")

        tmp_uploaded = None
        tmp_downloaded = None

        # multipart upload mode
        try:
            if request.files and "file" in request.files:
                f = request.files.get("file")
                if f and getattr(f, "filename", ""):
                    import tempfile
                    import uuid
                    tmpdir = tempfile.gettempdir()
                    tmp_uploaded = os.path.join(tmpdir, f"xk-geodat-upload-{uuid.uuid4().hex}")
                    raw_uploaded = read_uploaded_file_bytes_limited(
                        f,
                        max_bytes=get_geodat_upload_max_bytes(),
                    )
                    with open(tmp_uploaded, "wb") as fp:
                        fp.write(raw_uploaded)
                    try:
                        os.chmod(tmp_uploaded, 0o755)
                    except Exception:
                        pass
                    env["XKEEN_GEODAT_LOCAL"] = tmp_uploaded
        except PayloadTooLargeError as e:
            return jsonify({"ok": False, "error": "payload too large", "max_bytes": int(e.max_bytes)}), 413
        except RequestEntityTooLarge:
            max_bytes = get_geodat_upload_max_bytes()
            return jsonify({"ok": False, "error": "payload too large", "max_bytes": int(max_bytes)}), 413
        except Exception as e:
            _log_exception("upload_prepare_failed", e)
            return jsonify({
                "ok": False,
                "error": "upload_failed",
                "hint": "Не удалось подготовить загруженный бинарник xk-geodat. Подробности смотрите в server logs.",
            }), 200

        # JSON overrides (URL install)
        try:
            data = request.get_json(silent=True) or {}
            url = str(data.get("url") or "").strip()
            if url:
                policy = _geodat_url_policy()
                ok, reason = is_url_allowed_for_policy(url, policy)
                if not ok:
                    return jsonify(_geodat_url_blocked_payload(reason)), 200

                import tempfile
                import uuid

                tmpdir = tempfile.gettempdir()
                tmp_downloaded = os.path.join(tmpdir, f"xk-geodat-url-{uuid.uuid4().hex}")
                try:
                    download_to_file_with_policy(
                        url,
                        tmp_downloaded,
                        None,
                        policy=policy,
                        user_agent="Xkeen-UI geodat",
                    )
                    try:
                        os.chmod(tmp_downloaded, 0o755)
                    except Exception:
                        pass
                    env["XKEEN_GEODAT_LOCAL"] = tmp_downloaded
                except RuntimeError as e:
                    msg = str(e or "").strip()
                    try:
                        if tmp_downloaded and os.path.exists(tmp_downloaded):
                            os.remove(tmp_downloaded)
                    except Exception:
                        pass
                    if msg.startswith("url_blocked:"):
                        return jsonify(_geodat_url_blocked_payload(msg.split(":", 1)[1])), 200
                    hint = "Не удалось безопасно скачать xk-geodat по указанному URL."
                    if msg == "size_limit":
                        hint = "Файл xk-geodat по URL превысил допустимый размер."
                    return jsonify({
                        "ok": False,
                        "error": "download_failed",
                        "reason": msg or "download_failed",
                        "hint": hint,
                    }), 200
                except Exception as e:
                    try:
                        if tmp_downloaded and os.path.exists(tmp_downloaded):
                            os.remove(tmp_downloaded)
                    except Exception:
                        pass
                    _log_exception("download_failed", e, url=url)
                    return jsonify({
                        "ok": False,
                        "error": "download_failed",
                        "hint": "Не удалось скачать xk-geodat по указанному URL. Подробности смотрите в server logs.",
                    }), 200
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
            return jsonify({
                "ok": False,
                "error": "install_timeout",
                "hint": "Скрипт установки не завершился вовремя.",
            }), 200
        except Exception as e:
            _log_exception("install_failed", e, script_path=script_path)
            return jsonify({
                "ok": False,
                "error": "install_failed",
                "hint": "Не удалось запустить установку xk-geodat. Подробности смотрите в server logs.",
            }), 200
        finally:
            # cleanup uploaded tmp file
            try:
                if tmp_uploaded and os.path.exists(tmp_uploaded):
                    os.remove(tmp_uploaded)
            except Exception:
                pass
            try:
                if tmp_downloaded and os.path.exists(tmp_downloaded):
                    os.remove(tmp_downloaded)
            except Exception:
                pass

        exists = bool(bin_path and os.path.isfile(bin_path))
        ok_help, help_text = (False, "")
        if exists:
            ok_help, help_text = _geodat_run_help(bin_path)

        installed = bool(exists and ok_help)
        platform = geodat_platform_info()
        payload = {
            "ok": True,
            "platform": platform,
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
            reason = _short_reason(help_text) or _short_reason(err) or _short_reason(out)
            if reason:
                payload["reason"] = reason
            hint = "xk-geodat не установлен. Проверьте архитектуру роутера/доступ к GitHub или установите бинарник из файла."
            if reason:
                hint += " Причина: " + reason
            payload["hint"] = hint

        return jsonify(payload), 200
