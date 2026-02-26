"""DevTools API routes (UI logs, UI service control, env editor).

Blueprint endpoints are protected by the global auth_guard in app.py.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import time

from flask import Blueprint, jsonify, request, send_file

from typing import Any, Dict

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


def _redact_env_updates(updates: dict) -> dict:
    """Return a safe-to-log version of env updates (keys only, values redacted)."""
    out = {}
    try:
        for k in list(updates.keys())[:50]:
            key = str(k)
            lk = key.upper()
            sensitive = any(s in lk for s in ("PASS", "PASSWORD", "SECRET", "TOKEN", "KEY", "COOKIE"))
            out[key] = "***" if sensitive else "(set)"
    except Exception:
        return {"_error": "redact_failed"}
    return out


from services import devtools as dt
from services import branding as br
from services import get_build_info
from services.self_update.state import (
    ensure_update_dir,
    get_update_paths,
    get_backup_dir,
    list_backups,
    read_lock,
    read_status,
    read_update_log_tail,
    release_lock,
    try_acquire_lock,
    write_status,
)
from services.self_update.github import github_get_latest_release, github_get_latest_main
from services.self_update.security import is_url_allowed, security_snapshot

try:
    from services.logging_setup import refresh_runtime_from_env as _refresh_logging
except Exception:  # logging is optional
    _refresh_logging = None



def create_devtools_blueprint(ui_state_dir: str) -> Blueprint:
    bp = Blueprint("devtools", __name__)

    def _find_update_runner() -> str:
        """Return absolute path to update runner script (best-effort)."""
        # This module was moved under routes/. Keep script lookup stable by
        # resolving relative to the project root (one level up).
        project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
        cand = os.path.join(project_root, "scripts", "update_xkeen_ui.sh")
        if os.path.isfile(cand):
            return cand
        cand2 = "/opt/etc/xkeen-ui/scripts/update_xkeen_ui.sh"
        if os.path.isfile(cand2):
            return cand2
        return cand  # default (will fail later with a clear error)

    @bp.get("/api/devtools/update/info")
    def api_devtools_update_info() -> Any:
        """Return local build/update information.

        PR/Commit 1 (self-update): expose current build metadata written by install.sh.
        This endpoint performs *no* network calls.
        """

        build = get_build_info(ui_state_dir)
        caps = {
            "curl": bool(shutil.which("curl")),
            "tar": bool(shutil.which("tar")),
            "sha256sum": bool(shutil.which("sha256sum")),
        }
        settings = {
            "repo": str(os.environ.get("XKEEN_UI_UPDATE_REPO") or build.get("repo") or "umarcheh001/Xkeen-UI"),
            "channel": str(os.environ.get("XKEEN_UI_UPDATE_CHANNEL") or build.get("channel") or "stable"),
            "branch": str(os.environ.get("XKEEN_UI_UPDATE_BRANCH") or "main"),
        }
        return jsonify({"ok": True, "build": build, "capabilities": caps, "settings": settings, "security": security_snapshot()})

    @bp.get("/api/devtools/update/status")
    def api_devtools_update_status() -> Any:
        """Return local self-update status/lock/log tail.

        PR/Commit 2 (self-update): provides stable state storage for later update runs.
        This endpoint performs *no* network calls.
        """

        try:
            ensure_update_dir(ui_state_dir)
        except Exception:
            # Non-critical; we can still report "idle".
            pass

        paths = get_update_paths(ui_state_dir)

        status = read_status(paths["status_file"])
        lock_info = read_lock(paths["lock_file"])

        try:
            tail = int(request.args.get("tail") or 200)
        except Exception:
            tail = 200
        tail = max(0, min(2000, tail))

        backup_dir = get_backup_dir(ui_state_dir)
        backups = list_backups(backup_dir, limit=5)


        log_tail = read_update_log_tail(paths["log_file"], lines=tail) if tail else []

        # Keep response compact and UI-friendly.
        return jsonify({"ok": True, "status": status, "lock": lock_info, "log_tail": log_tail, "backup_dir": backup_dir, "backups": backups, "has_backup": bool(backups)})

    @bp.post("/api/devtools/update/check")
    def api_devtools_update_check() -> Any:
        """Check GitHub for the latest stable release (no install).

        PR/Commit 3 (self-update): query GitHub Releases API and compare with current BUILD.json.
        Network is performed with a short wait and safe caching; the UI must not freeze.
        """
        payload = request.get_json(silent=True) or {}
        force_refresh = bool(payload.get("force_refresh") or payload.get("force") or False)
        try:
            wait_seconds = float(payload.get("wait_seconds") or 2.5)
        except Exception:
            wait_seconds = 2.5
        wait_seconds = max(0.2, min(10.0, wait_seconds))

        # Use services facade to avoid deep imports / refactor fallout.
        repo_env = os.environ.get("XKEEN_UI_UPDATE_REPO")
        channel_env = os.environ.get("XKEEN_UI_UPDATE_CHANNEL")
        branch_env = os.environ.get("XKEEN_UI_UPDATE_BRANCH")

        # Default settings (may be overridden by BUILD.json if env is not set).
        repo = str(repo_env or "umarcheh001/Xkeen-UI")
        channel = str(channel_env or "stable")
        branch = str(branch_env or "main")

        # Hard safety: never let BUILD.json issues bubble up into a 500.
        try:
            build = get_build_info(ui_state_dir)
            if not isinstance(build, dict):
                raise TypeError("build_info_not_dict")
        except Exception as e:
            _core_log("error", "self_update: build_info_failed", error=str(e)[:200])
            return jsonify(
                {
                    "ok": False,
                    "error": "build_info_failed",
                    "repo": repo,
                    "channel": channel,
                    "branch": branch,
                    "current": {"ok": False, "exists": False, "path": "", "repo": repo, "channel": channel, "version": None, "commit": None, "built_utc": None, "source": None, "artifact": None},
                    "latest": None,
                    "update_available": False,
                }
            )

        # Allow BUILD.json to fill defaults when env isn't set.
        repo = str(repo_env or build.get("repo") or repo)
        channel = str(channel_env or build.get("channel") or channel)
        branch = str(branch_env or branch)
        ch = channel.strip().lower() or "stable"

        try:
            if ch == "stable":
                gh_res, stale = github_get_latest_release(repo, wait_seconds=wait_seconds, force_refresh=force_refresh)
            elif ch == "main":
                gh_res, stale = github_get_latest_main(repo, branch=branch, wait_seconds=wait_seconds, force_refresh=force_refresh)
            else:
                return jsonify({"ok": False, "error": "channel_not_supported", "repo": repo, "channel": channel, "branch": branch, "current": build, "latest": None, "update_available": False})
        except TimeoutError:
            return jsonify(
                {
                    "ok": False,
                    "error": "timeout",
                    "repo": repo,
                    "channel": channel,
                "branch": branch,
                    "current": build,
                    "latest": None,
                    "update_available": False,
                }
            )
        except Exception as e:
            return jsonify(
                {
                    "ok": False,
                    "error": "check_failed",
                    "repo": repo,
                    "channel": channel,
                "branch": branch,
                    "current": build,
                    "latest": None,
                    "update_available": False,
                    "meta": {"message": str(e)[:200]},
                }
            )

        latest = gh_res.get("latest") if isinstance(gh_res, dict) else None
        ok = bool(gh_res.get("ok")) if isinstance(gh_res, dict) else False
        err = gh_res.get("error") if isinstance(gh_res, dict) else "bad_response"
        meta = gh_res.get("meta") if isinstance(gh_res, dict) else None

        # Compare by tag/version (stable) or commit (main).
        update_available = False
        if ok and isinstance(latest, dict):
            if ch == "stable":
                current_ver = build.get("version")
                latest_tag = latest.get("tag")

                def _norm_ver(v: Any) -> str:
                    s = str(v or "").strip()
                    if s.lower().startswith("v"):
                        s = s[1:].strip()
                    return s

                if latest_tag:
                    if current_ver:
                        update_available = _norm_ver(current_ver) != _norm_ver(latest_tag)
                    else:
                        update_available = True
            elif ch == "main":
                current_commit = build.get("commit")
                latest_sha = latest.get("sha")
                if latest_sha:
                    if current_commit:
                        update_available = str(current_commit) != str(latest_sha)
                    else:
                        update_available = True

        # Security/limits diagnostics for UI (runner enforces separately).
        sec = {
            "settings": security_snapshot(),
            "download": None,
            "checksum": None,
            "warnings": [],
            "will_block_run": False,
        }
        try:
            if isinstance(latest, dict):
                if ch == "stable":
                    asset = latest.get("asset") if isinstance(latest.get("asset"), dict) else {}
                    durl = str(asset.get("download_url") or "")
                    if durl:
                        d_ok, d_reason = is_url_allowed(durl)
                    else:
                        d_ok, d_reason = False, "missing"
                    sec["download"] = {"url": durl or None, "ok": bool(d_ok), "reason": d_reason}
                    if not d_ok:
                        sec["warnings"].append("download_url_blocked:" + d_reason)

                    sha = latest.get("sha256_asset") if isinstance(latest.get("sha256_asset"), dict) else {}
                    surl = str(sha.get("download_url") or "")
                    if surl:
                        s_ok, s_reason = is_url_allowed(surl)
                        sec["checksum"] = {
                            "present": True,
                            "kind": sha.get("kind"),
                            "url": surl,
                            "ok": bool(s_ok),
                            "reason": s_reason,
                        }
                        if not s_ok:
                            sec["warnings"].append("checksum_url_blocked:" + s_reason)
                    else:
                        sec["checksum"] = {"present": False, "kind": sha.get("kind"), "url": None}
                        if str(os.environ.get("XKEEN_UI_UPDATE_REQUIRE_SHA") or "0").strip() == "1":
                            sec["warnings"].append("checksum_required_missing")
                elif ch == "main":
                    durl = str(latest.get("tarball_url") or "")
                    if durl:
                        d_ok, d_reason = is_url_allowed(durl)
                    else:
                        d_ok, d_reason = False, "missing"
                    sec["download"] = {"url": durl or None, "ok": bool(d_ok), "reason": d_reason}
                    if not d_ok:
                        sec["warnings"].append("download_url_blocked:" + d_reason)
        except Exception:
            pass

        # Will the runner likely refuse to run with current policy?
        try:
            sec["will_block_run"] = bool(
                any(str(w).startswith("download_url_blocked") for w in (sec.get("warnings") or []))
                or any(str(w).startswith("checksum_url_blocked") for w in (sec.get("warnings") or []))
                or "checksum_required_missing" in (sec.get("warnings") or [])
            )
        except Exception:
            sec["will_block_run"] = False

        return jsonify(
            {
                "ok": ok,
                "error": err,
                "repo": repo,
                "channel": channel,
                "branch": branch,
                "current": build,
                "latest": latest,
                "update_available": bool(update_available),
                "stale": bool(stale),
                "meta": meta,
                "security": sec,
            }
        )

    @bp.post("/api/devtools/update/run")
    def api_devtools_update_run() -> Any:
        """Start self-update runner in background.

        PR/Commit 5 (self-update): spawn update runner via subprocess.Popen.
        The runner performs backup/download/extract/install and writes status/log.
        """

        payload = request.get_json(silent=True) or {}
        # Optional "preflight" data from /api/devtools/update/check so runner can skip network check_latest.
        resolved = payload.get("resolved") if isinstance(payload, dict) else None
        if not isinstance(resolved, dict):
            resolved = {}

        def _s(v: Any) -> str:
            try:
                return str(v or "").strip()
            except Exception:
                return ""

        # Ensure storage exists.
        try:
            ensure_update_dir(ui_state_dir)
        except Exception:
            pass

        paths = get_update_paths(ui_state_dir)

        # Preconditions (avoid starting a job that will instantly fail without status).
        have_python = bool(shutil.which("python3") or shutil.which("python") or os.path.isfile("/opt/bin/python3"))
        have_tar = bool(shutil.which("tar"))
        have_downloader = bool(shutil.which("curl") or shutil.which("wget"))
        runner = _find_update_runner()
        if not os.path.isfile(runner):
            return jsonify({"ok": False, "error": "runner_not_found", "runner": runner})
        if not have_python or not have_tar or not have_downloader:
            return jsonify(
                {
                    "ok": False,
                    "error": "missing_dependencies",
                    "capabilities": {
                        "python": have_python,
                        "tar": have_tar,
                        "curl_or_wget": have_downloader,
                    },
                }
            )

        # Acquire lock for this run (runner will adopt it using XKEEN_UI_LOCK_PRECREATED=1).
        acquired, lock_info = try_acquire_lock(paths["lock_file"])
        if not acquired:
            status = read_status(paths["status_file"])
            return jsonify({"ok": True, "started": False, "reason": "locked", "lock": lock_info, "status": status})

        # Reset status for a clean run (keep previous log file).
        try:
            if os.path.isfile(paths["status_file"]):
                os.replace(paths["status_file"], paths["status_file"] + ".prev")
        except Exception:
            # Not critical.
            pass

        now = time.time()
        base_status: Dict[str, Any] = {
            "state": "running",
            "step": "spawn",
            "progress": {"runner": os.path.basename(runner)},
            "created_ts": now,
            "started_ts": now,
            "finished_ts": None,
            "error": None,
            "pid": None,
            "op": "update",
            "message": "Starting update runner",
            "updated_ts": now,
        }
        write_status(paths["status_file"], base_status)

        env = os.environ.copy()
        env["XKEEN_UI_LOCK_PRECREATED"] = "1"
        env["XKEEN_UI_UPDATE_DIR"] = paths["update_dir"]
        env["XKEEN_UI_UPDATE_ACTION"] = "update"

        # Pass effective update settings to runner (so it works without restarting UI).
        build_eff = get_build_info(ui_state_dir)
        repo_eff = str(os.environ.get("XKEEN_UI_UPDATE_REPO") or build_eff.get("repo") or "umarcheh001/Xkeen-UI")
        channel_eff = str(os.environ.get("XKEEN_UI_UPDATE_CHANNEL") or build_eff.get("channel") or "stable")
        branch_eff = str(os.environ.get("XKEEN_UI_UPDATE_BRANCH") or "main")
        env["XKEEN_UI_UPDATE_REPO"] = repo_eff
        env["XKEEN_UI_UPDATE_CHANNEL"] = channel_eff
        env["XKEEN_UI_UPDATE_BRANCH"] = branch_eff

        # If UI provides a resolved URL/tag/sha from /check, pass it to runner as overrides.
        # Runner will then skip its own GitHub API calls in check_latest.
        asset_url = _s(resolved.get("asset_url"))
        if asset_url:
            env["XKEEN_UI_UPDATE_ASSET_URL"] = asset_url
            tag = _s(resolved.get("tag"))
            if tag:
                env["XKEEN_UI_UPDATE_TAG"] = tag
            sha_url = _s(resolved.get("sha_url"))
            if sha_url:
                env["XKEEN_UI_UPDATE_SHA_URL"] = sha_url
            sha_kind = _s(resolved.get("sha_kind"))
            if sha_kind:
                env["XKEEN_UI_UPDATE_SHA_KIND"] = sha_kind
            asset_name = _s(resolved.get("asset_name"))
            if asset_name:
                env["XKEEN_UI_UPDATE_ASSET_NAME"] = asset_name

        try:
            # Don't redirect stdout to update.log, because runner already writes update.log
            # and uses tee; redirecting would duplicate lines.
            p = subprocess.Popen(
                ["sh", runner],
                cwd=os.path.dirname(runner) or None,
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.STDOUT,
                close_fds=True,
                start_new_session=True,
            )
            base_status["pid"] = p.pid
            base_status["progress"] = {"runner": os.path.basename(runner), "spawned_pid": p.pid}
            base_status["message"] = "Runner started"
            base_status["updated_ts"] = time.time()
            write_status(paths["status_file"], base_status)
            _core_log("info", "self_update: started runner", pid=p.pid, runner=runner)
            return jsonify({"ok": True, "started": True, "pid": p.pid, "lock": lock_info, "status": base_status})
        except Exception as e:
            # Best-effort rollback of lock and status.
            release_lock(paths["lock_file"])
            base_status["state"] = "failed"
            base_status["step"] = "spawn"
            base_status["error"] = "spawn_failed"
            base_status["message"] = str(e)[:200]
            base_status["finished_ts"] = time.time()
            base_status["updated_ts"] = time.time()
            write_status(paths["status_file"], base_status)
            _core_log("error", "self_update: failed to start runner", error=str(e)[:200])
            return jsonify({"ok": False, "error": "spawn_failed", "meta": {"message": str(e)[:200]}})


    @bp.post("/api/devtools/update/rollback")
    def api_devtools_update_rollback() -> Any:
        """Start rollback runner in background.

        PR/Commit 7 (self-update): restore the latest backup created by the updater.
        """

        # Ensure storage exists.
        try:
            ensure_update_dir(ui_state_dir)
        except Exception:
            pass

        paths = get_update_paths(ui_state_dir)

        # Check that a backup exists (UI should hide the button otherwise).
        backup_dir = get_backup_dir(ui_state_dir)
        backups = list_backups(backup_dir, limit=1)
        if not backups:
            return jsonify({"ok": False, "error": "no_backup", "backup_dir": backup_dir})

        # Preconditions for rollback: python + tar + runner script.
        have_python = bool(shutil.which("python3") or shutil.which("python") or os.path.isfile("/opt/bin/python3"))
        have_tar = bool(shutil.which("tar"))
        runner = _find_update_runner()
        if not os.path.isfile(runner):
            return jsonify({"ok": False, "error": "runner_not_found", "runner": runner})
        if not have_python or not have_tar:
            return jsonify(
                {
                    "ok": False,
                    "error": "missing_dependencies",
                    "capabilities": {
                        "python": have_python,
                        "tar": have_tar,
                    },
                }
            )

        # Acquire lock for this run (runner will adopt it using XKEEN_UI_LOCK_PRECREATED=1).
        acquired, lock_info = try_acquire_lock(paths["lock_file"])
        if not acquired:
            status = read_status(paths["status_file"])
            return jsonify({"ok": True, "started": False, "reason": "locked", "lock": lock_info, "status": status})

        # Reset status for a clean run (keep previous log file).
        try:
            if os.path.isfile(paths["status_file"]):
                os.replace(paths["status_file"], paths["status_file"] + ".prev")
        except Exception:
            pass

        now = time.time()
        base_status: Dict[str, Any] = {
            "state": "running",
            "step": "spawn",
            "progress": {"runner": os.path.basename(runner), "action": "rollback"},
            "created_ts": now,
            "started_ts": now,
            "finished_ts": None,
            "error": None,
            "pid": None,
            "op": "rollback",
            "message": "Starting rollback runner",
            "updated_ts": now,
        }
        write_status(paths["status_file"], base_status)

        env = os.environ.copy()
        env["XKEEN_UI_LOCK_PRECREATED"] = "1"
        env["XKEEN_UI_UPDATE_DIR"] = paths["update_dir"]
        env["XKEEN_UI_UPDATE_ACTION"] = "rollback"

        build_eff = get_build_info(ui_state_dir)
        repo_eff = str(os.environ.get("XKEEN_UI_UPDATE_REPO") or build_eff.get("repo") or "umarcheh001/Xkeen-UI")
        channel_eff = str(os.environ.get("XKEEN_UI_UPDATE_CHANNEL") or build_eff.get("channel") or "stable")
        branch_eff = str(os.environ.get("XKEEN_UI_UPDATE_BRANCH") or "main")
        env["XKEEN_UI_UPDATE_REPO"] = repo_eff
        env["XKEEN_UI_UPDATE_CHANNEL"] = channel_eff
        env["XKEEN_UI_UPDATE_BRANCH"] = branch_eff

        try:
            p = subprocess.Popen(
                ["sh", runner],
                cwd=os.path.dirname(runner) or None,
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.STDOUT,
                close_fds=True,
                start_new_session=True,
            )
            base_status["pid"] = p.pid
            base_status["progress"] = {"runner": os.path.basename(runner), "spawned_pid": p.pid, "action": "rollback"}
            base_status["message"] = "Rollback runner started"
            base_status["updated_ts"] = time.time()
            write_status(paths["status_file"], base_status)
            _core_log("info", "self_update: started rollback runner", pid=p.pid, runner=runner)
            return jsonify({"ok": True, "started": True, "pid": p.pid, "lock": lock_info, "status": base_status})
        except Exception as e:
            release_lock(paths["lock_file"])
            base_status["state"] = "failed"
            base_status["step"] = "spawn"
            base_status["error"] = "spawn_failed"
            base_status["message"] = str(e)[:200]
            base_status["finished_ts"] = time.time()
            base_status["updated_ts"] = time.time()
            write_status(paths["status_file"], base_status)
            _core_log("error", "self_update: failed to start rollback runner", error=str(e)[:200])
            return jsonify({"ok": False, "error": "spawn_failed", "meta": {"message": str(e)[:200]}})


    @bp.get("/api/devtools/env")
    def api_devtools_env_get() -> Any:
        items = dt.get_env_items(ui_state_dir)
        return jsonify(
            {
                "ok": True,
                "env_file": dt._env_file_path(ui_state_dir),  # type: ignore[attr-defined]
                "items": [
                    {
                        "key": it.key,
                        "current": it.current,
                        "configured": it.configured,
                        "effective": it.effective,
                        "is_sensitive": bool(it.is_sensitive),
                        "readonly": bool(getattr(it, "readonly", False)),
                    }
                    for it in items
                ],
            }
        )

    @bp.post("/api/devtools/env")
    def api_devtools_env_set() -> Any:
        payload = request.get_json(silent=True) or {}

        updates: Dict[str, Any] = {}
        if isinstance(payload.get("updates"), dict):
            updates = dict(payload.get("updates") or {})
        else:
            # Single-key format
            k = payload.get("key")
            if isinstance(k, str) and k.strip():
                updates[k.strip()] = payload.get("value")

        _core_log("info", "devtools.env_set", updates=_redact_env_updates(updates), remote_addr=str(request.remote_addr or ""))
        items = dt.set_env(ui_state_dir, updates)

        try:
            if _refresh_logging:
                _refresh_logging()
        except Exception:
            pass
        return jsonify(
            {
                "ok": True,
                "env_file": dt._env_file_path(ui_state_dir),  # type: ignore[attr-defined]
                "items": [
                    {
                        "key": it.key,
                        "current": it.current,
                        "configured": it.configured,
                        "effective": it.effective,
                        "is_sensitive": bool(it.is_sensitive),
                        "readonly": bool(getattr(it, "readonly", False)),
                    }
                    for it in items
                ],
            }
        )

    

    # --- Theme editor (global custom theme stored in UI_STATE_DIR) ---

    @bp.get("/api/devtools/theme")
    def api_devtools_theme_get() -> Any:
        data = dt.theme_get(ui_state_dir)
        return jsonify({"ok": True, **data})

    @bp.post("/api/devtools/theme")
    def api_devtools_theme_set() -> Any:
        payload = request.get_json(silent=True) or {}
        cfg_in = payload.get("config") if isinstance(payload, dict) else None
        if cfg_in is None:
            cfg_in = payload
        data = dt.theme_set(ui_state_dir, cfg_in)
        return jsonify({"ok": True, **data})

    @bp.post("/api/devtools/theme/reset")
    def api_devtools_theme_reset() -> Any:
        data = dt.theme_reset(ui_state_dir)
        return jsonify({"ok": True, **data})


    # --- Independent themes (Terminal / CodeMirror) ---

    @bp.get("/api/devtools/terminal_theme")
    def api_devtools_terminal_theme_get() -> Any:
        data = dt.terminal_theme_get(ui_state_dir)
        return jsonify({"ok": True, **data})

    @bp.post("/api/devtools/terminal_theme")
    def api_devtools_terminal_theme_set() -> Any:
        payload = request.get_json(silent=True) or {}
        cfg_in = payload.get("config") if isinstance(payload, dict) else None
        if cfg_in is None:
            cfg_in = payload
        data = dt.terminal_theme_set(ui_state_dir, cfg_in)
        return jsonify({"ok": True, **data})

    @bp.post("/api/devtools/terminal_theme/reset")
    def api_devtools_terminal_theme_reset() -> Any:
        data = dt.terminal_theme_reset(ui_state_dir)
        return jsonify({"ok": True, **data})

    @bp.get("/api/devtools/codemirror_theme")
    def api_devtools_codemirror_theme_get() -> Any:
        data = dt.codemirror_theme_get(ui_state_dir)
        return jsonify({"ok": True, **data})

    @bp.post("/api/devtools/codemirror_theme")
    def api_devtools_codemirror_theme_set() -> Any:
        payload = request.get_json(silent=True) or {}
        cfg_in = payload.get("config") if isinstance(payload, dict) else None
        if cfg_in is None:
            cfg_in = payload
        data = dt.codemirror_theme_set(ui_state_dir, cfg_in)
        return jsonify({"ok": True, **data})

    @bp.post("/api/devtools/codemirror_theme/reset")
    def api_devtools_codemirror_theme_reset() -> Any:
        data = dt.codemirror_theme_reset(ui_state_dir)
        return jsonify({"ok": True, **data})


    # --- Branding (global, stored in UI_STATE_DIR/branding.json) ---

    @bp.get("/api/devtools/branding")
    def api_devtools_branding_get() -> Any:
        data = br.branding_get(ui_state_dir)
        return jsonify({"ok": True, **data})

    @bp.post("/api/devtools/branding")
    def api_devtools_branding_set() -> Any:
        payload = request.get_json(silent=True) or {}
        cfg_in = payload.get("config") if isinstance(payload, dict) else None
        if cfg_in is None:
            cfg_in = payload
        data = br.branding_set(ui_state_dir, cfg_in)
        return jsonify({"ok": True, **data})

    @bp.post("/api/devtools/branding/reset")
    def api_devtools_branding_reset() -> Any:
        data = br.branding_reset(ui_state_dir)
        return jsonify({"ok": True, **data})


    # --- Custom CSS editor (global custom.css stored in UI_STATE_DIR) ---

    @bp.get("/api/devtools/custom_css")
    def api_devtools_custom_css_get() -> Any:
        data = dt.custom_css_get(ui_state_dir)
        return jsonify({"ok": True, **data})

    @bp.post("/api/devtools/custom_css/save")
    def api_devtools_custom_css_save() -> Any:
        payload = request.get_json(silent=True) or {}
        css = None
        if isinstance(payload, dict):
            css = payload.get("css")
            if css is None:
                css = payload.get("content")
        try:
            data = dt.custom_css_set(ui_state_dir, css)
        except ValueError as e:
            return jsonify({"ok": False, "error": str(e) or "invalid"}), 400
        return jsonify({"ok": True, **data})

    @bp.post("/api/devtools/custom_css/disable")
    def api_devtools_custom_css_disable() -> Any:
        data = dt.custom_css_disable(ui_state_dir)
        return jsonify({"ok": True, **data})

    @bp.post("/api/devtools/custom_css/reset")
    def api_devtools_custom_css_reset() -> Any:
        data = dt.custom_css_reset(ui_state_dir)
        return jsonify({"ok": True, **data})

    @bp.get("/api/devtools/logs")
    def api_devtools_logs_list() -> Any:
        return jsonify({"ok": True, "logs": dt.list_logs()})

    @bp.get("/api/devtools/logs/<name>")
    def api_devtools_logs_tail(name: str) -> Any:
        cursor = request.args.get("cursor")
        try:
            lines = int(request.args.get("lines", "400") or "400")
        except Exception:
            lines = 400
        try:
            path, lns, new_cursor, mode = dt.tail_log(name, lines=lines, cursor=cursor)
        except ValueError:
            return jsonify({"ok": False, "error": "unknown_log"}), 404

        # Include lightweight metadata for UI (size/mtime/ino), so the sidebar can update
        # without an extra stat call.
        meta = {"size": 0, "mtime": 0.0, "ino": 0, "exists": False}
        try:
            st = os.stat(path)
            meta = {
                "size": int(getattr(st, "st_size", 0) or 0),
                "mtime": float(getattr(st, "st_mtime", 0.0) or 0.0),
                "ino": int(getattr(st, "st_ino", 0) or 0),
                "exists": True,
            }
        except Exception:
            pass

        return jsonify({"ok": True, "name": name, "path": path, "lines": lns, "cursor": new_cursor, "mode": mode, **meta})


    @bp.get("/api/devtools/logs/<name>/download")
    def api_devtools_logs_download(name: str) -> Any:
        path = dt._resolve_log_path(name)  # type: ignore[attr-defined]
        if not path:
            return jsonify({"ok": False, "error": "unknown_log"}), 404
        if not os.path.isfile(path):
            return jsonify({"ok": False, "error": "not_found"}), 404
        try:
            return send_file(path, as_attachment=True, download_name=f"{name}.log")
        except TypeError:
            # Flask < 2.0
            return send_file(path, as_attachment=True, attachment_filename=f"{name}.log")

    @bp.post("/api/devtools/logs/<name>/truncate")
    def api_devtools_logs_truncate(name: str) -> Any:
        _core_log("info", "devtools.log_truncate", name=name, remote_addr=str(request.remote_addr or ""))
        try:
            path = dt.truncate_log(name)
        except ValueError:
            return jsonify({"ok": False, "error": "unknown_log"}), 404
        return jsonify({"ok": True, "name": name, "path": path})

    @bp.get("/api/devtools/ui/status")
    def api_devtools_ui_status() -> Any:
        st = dt.ui_status()
        return jsonify({"ok": True, **st})

    @bp.post("/api/devtools/ui/<action>")
    def api_devtools_ui_action(action: str) -> Any:
        try:
            res = dt.ui_action(action)
        except ValueError:
            return jsonify({"ok": False, "error": "bad_action"}), 400
        code = 200 if res.get("ok") else 500
        return jsonify(res), code

    return bp
