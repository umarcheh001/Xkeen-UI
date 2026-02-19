"""/api/routing/geodat/* endpoints.

Moved from routes_routing.py as part of refactor checklist (B3 step 6).
"""

from __future__ import annotations

import os
import subprocess
from typing import Any

from flask import Blueprint, request, jsonify

from services.geodat.runner import _geodat_bin_path
from services.geodat.install import _geodat_install_script_path, _geodat_run_help, _geodat_stat_meta


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
            return jsonify({
                "ok": False,
                "error": "install_script_missing",
                "hint": f"Не найден скрипт установки: {script_path}",
            }), 200

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
            return jsonify({
                "ok": False,
                "error": "install_timeout",
                "hint": "Скрипт установки не завершился вовремя.",
            }), 200
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
        payload = {
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
            reason = _short_reason(help_text) or _short_reason(err) or _short_reason(out)
            if reason:
                payload["reason"] = reason
            hint = "xk-geodat не установлен. Проверьте архитектуру роутера/доступ к GitHub или установите бинарник из файла."
            if reason:
                hint += " Причина: " + reason
            payload["hint"] = hint

        return jsonify(payload), 200
