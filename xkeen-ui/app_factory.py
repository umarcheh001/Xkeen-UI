"""Application factory.

PR18: move Flask app construction and blueprint registration out of app.py.

The goal is to keep app.py a thin compatibility layer (re-exports for
run_server.py) while centralizing initialization here.
"""

from __future__ import annotations

import os
import time
from typing import Any, Dict


def create_app(*, ws_runtime: bool = False):
    """Create and configure the Flask application.

    Args:
        ws_runtime: Whether WebSocket runtime is *actually* active. In practice,
            run_server.py sets this later via app.set_ws_runtime(True), but we
            still accept the flag for testability.
    """

    # Local imports to reduce side-effects on module import.
    from flask import Flask, send_from_directory

    from bootstrap_mihomo_env import ensure_mihomo_root_env

    ensure_mihomo_root_env()

    from mihomo_server_core import CONFIG_PATH

    from core.paths import UI_STATE_DIR, BASE_ETC_DIR, BASE_VAR_DIR
    from core.logging import init_logging, core_log as _core_log

    UI_LOG_DIR, UI_CORE_LOG, UI_ACCESS_LOG, UI_WS_LOG = init_logging(BASE_VAR_DIR)

    _core_log(
        "info",
        "xkeen-ui init",
        pid=os.getpid(),
        ui_state_dir=UI_STATE_DIR,
        ui_log_dir=UI_LOG_DIR,
        base_etc_dir=BASE_ETC_DIR,
        base_var_dir=BASE_VAR_DIR,
        ws_runtime=bool(ws_runtime),
    )

    # ---- Xray config files (auto-mode + env overrides)
    from services.xray_config_files import (
        XRAY_CONFIGS_DIR,
        XRAY_CONFIGS_DIR_REAL,
        XRAY_JSONC_DIR,
        XRAY_JSONC_DIR_REAL,
        ROUTING_FILE,
        ROUTING_FILE_RAW,
        INBOUNDS_FILE,
        OUTBOUNDS_FILE,
        ensure_xray_jsonc_dir,
        migrate_jsonc_sidecars_from_configs,
    )

    # Stage 6: migrate legacy *.jsonc files out of XRAY_CONFIGS_DIR on startup.
    try:
        ensure_xray_jsonc_dir()
        mig = migrate_jsonc_sidecars_from_configs()
        if int(mig.get("found") or 0) > 0:
            _core_log(
                "info",
                "xray jsonc migration",
                xray_configs_dir=XRAY_CONFIGS_DIR,
                xray_jsonc_dir=XRAY_JSONC_DIR,
                **mig,
            )
    except Exception:
        # Never block UI startup.
        pass

    BACKUP_DIR = os.path.join(BASE_ETC_DIR, "xray", "configs", "backups")
    try:
        BACKUP_DIR_REAL = os.path.realpath(BACKUP_DIR)
    except Exception:
        BACKUP_DIR_REAL = BACKUP_DIR

    from services.xray_backups import (
        is_history_backup_filename as _is_history_backup_filename,
        snapshot_before_overwrite as _snapshot_before_overwrite,
    )

    def snapshot_xray_config_before_overwrite(abs_path: str) -> None:
        """Save snapshot for an Xray fragment before overwrite. Never raises."""
        try:
            _snapshot_before_overwrite(
                abs_path,
                backup_dir=BACKUP_DIR,
                xray_configs_dir_real=XRAY_CONFIGS_DIR_REAL,
                backup_dir_real=BACKUP_DIR_REAL,
                xray_jsonc_dir_real=XRAY_JSONC_DIR_REAL,
            )
        except Exception:
            return

    XKEEN_RESTART_CMD = ["xkeen", "-restart"]
    RESTART_LOG_FILE = os.environ.get(
        "XKEEN_RESTART_LOG_FILE", os.path.join(UI_STATE_DIR, "restart.log")
    )
    XRAY_LOG_CONFIG_FILE = os.path.join(BASE_ETC_DIR, "xray", "configs", "01_log.json")
    XRAY_ACCESS_LOG = os.path.join(BASE_VAR_DIR, "log", "xray", "access.log")
    XRAY_ERROR_LOG = os.path.join(BASE_VAR_DIR, "log", "xray", "error.log")
    XRAY_ACCESS_LOG_SAVED = XRAY_ACCESS_LOG + ".saved"
    XRAY_ERROR_LOG_SAVED = XRAY_ERROR_LOG + ".saved"

    # Timezone offset for Xray/Mihomo logs.
    _XRAY_LOG_TZ_ENV = os.environ.get("XKEEN_XRAY_LOG_TZ_OFFSET", "3")
    try:
        XRAY_LOG_TZ_OFFSET_HOURS = int(_XRAY_LOG_TZ_ENV)
    except ValueError:
        XRAY_LOG_TZ_OFFSET_HOURS = 3

    from core.mihomo_paths import init_mihomo_paths

    MIHOMO_CONFIG_FILE, MIHOMO_ROOT_DIR, MIHOMO_TEMPLATES_DIR, MIHOMO_DEFAULT_TEMPLATE = (
        init_mihomo_paths(CONFIG_PATH)
    )

    from services.xkeen_lists import PORT_PROXYING_FILE

    XRAY_CONFIG_DIR = os.path.dirname(ROUTING_FILE)
    XKEEN_CONFIG_DIR = os.path.dirname(PORT_PROXYING_FILE)

    GITHUB_OWNER = os.environ.get("XKEEN_GITHUB_OWNER", "umarcheh001")
    GITHUB_REPO = os.environ.get("XKEEN_GITHUB_REPO", "xkeen-community-configs")
    GITHUB_BRANCH = os.environ.get("XKEEN_GITHUB_BRANCH", "main")

    CONFIG_SERVER_BASE = os.environ.get(
        "XKEEN_CONFIG_SERVER_BASE", "http://144.31.17.58:8000"
    )

    GITHUB_REPO_URL = os.environ.get(
        "XKEEN_GITHUB_REPO_URL", f"https://github.com/{GITHUB_OWNER}/{GITHUB_REPO}"
    )

    # -------- Command catalog + background jobs
    from services.xkeen_commands_catalog import COMMAND_GROUPS

    # -------- Core utilities
    from utils.jsonc import strip_json_comments_text
    from utils.jsonio import load_json, save_json

    # Bind Xray log helpers (cache + config) for WS and UI.
    from services.xray_log_api import init_xray_log_api

    init_xray_log_api(
        load_json,
        save_json,
        XRAY_LOG_CONFIG_FILE,
        XRAY_ACCESS_LOG,
        XRAY_ERROR_LOG,
        tz_offset_hours=XRAY_LOG_TZ_OFFSET_HOURS,
    )

    # -------- Flask app
    app = Flask(__name__, static_folder="static", template_folder="templates")

    # Make UI updates visible without requiring Ctrl+F5.
    # With max_age=0 browsers revalidate static JS/CSS on reload and will fetch
    # the new version after an update.
    try:
        app.config.setdefault("SEND_FILE_MAX_AGE_DEFAULT", 0)
    except Exception:
        pass

    @app.route("/favicon.ico")
    def favicon():
        return send_from_directory(
            app.static_folder, "favicon.ico", mimetype="image/vnd.microsoft.icon"
        )

    # -------- Auth / first-run setup
    from services.auth_setup import init_auth

    init_auth(app)

    # --- UI assets / auth / pages
    from routes_ui_assets import register_ui_assets_routes
    from routes_auth import register_auth_routes
    from routes_pages import register_pages_routes

    from services import devtools as _svc_devtools

    register_ui_assets_routes(app, UI_STATE_DIR=UI_STATE_DIR, devtools_service=_svc_devtools)
    register_auth_routes(app)
    register_pages_routes(
        app,
        ROUTING_FILE=ROUTING_FILE,
        MIHOMO_CONFIG_FILE=MIHOMO_CONFIG_FILE,
        INBOUNDS_FILE=INBOUNDS_FILE,
        OUTBOUNDS_FILE=OUTBOUNDS_FILE,
        BACKUP_DIR=BACKUP_DIR,
        COMMAND_GROUPS=COMMAND_GROUPS,
        GITHUB_REPO_URL=GITHUB_REPO_URL,
    )

    # --- WS debug logger
    from services.ws_debug import init_ws_debug, ws_debug

    try:
        init_ws_debug(UI_WS_LOG)
    except Exception:
        pass

    # --- Access log middleware
    from services.logging_setup import access_enabled as _access_enabled, access_logger as _get_access_logger
    from middleware.access_log import init_access_log as _init_access_log

    _init_access_log(app, _access_enabled, _get_access_logger, skip_prefixes=("/static/", "/ws/"))

    # -------- helpers for blueprints
    from services.xkeen import (
        append_restart_log as _svc_append_restart_log,
        read_restart_log as _svc_read_restart_log,
        restart_xkeen as _svc_restart_xkeen,
    )
    from services.restart_log import clear_restart_log as _svc_clear_restart_log
    from services.xray import restart_xray_core as _svc_restart_xray_core

    def append_restart_log(ok, source: str = "api"):
        return _svc_append_restart_log(RESTART_LOG_FILE, ok, source=source)

    def read_restart_log(limit: int = 100):
        return _svc_read_restart_log(RESTART_LOG_FILE, limit=limit)

    def clear_restart_log():
        return _svc_clear_restart_log(RESTART_LOG_FILE)

    def restart_xkeen(source: str = "api"):
        return _svc_restart_xkeen(XKEEN_RESTART_CMD, RESTART_LOG_FILE, source=source)

    def restart_xray_core() -> tuple[bool, str]:
        try:
            return _svc_restart_xray_core()
        except Exception as e:  # noqa: BLE001
            return False, str(e)

    def _detect_backup_target_file(filename: str):
        name = str(filename or "")
        prefix = name.split("-", 1)[0] if "-" in name else name

        try:
            cand = os.path.join(XRAY_CONFIGS_DIR, prefix + ".json")
            cand_real = os.path.realpath(cand)
            if cand_real.startswith(XRAY_CONFIGS_DIR_REAL + os.sep) and os.path.isfile(cand_real):
                return cand_real
        except Exception:
            pass

        if prefix.startswith("03_inbounds"):
            return INBOUNDS_FILE
        if prefix.startswith("04_outbounds"):
            return OUTBOUNDS_FILE
        return ROUTING_FILE

    def _find_latest_auto_backup_for(config_path: str):
        base = os.path.basename(config_path)
        if not os.path.isdir(BACKUP_DIR):
            return None, None
        latest = None
        latest_mtime = None
        prefix = base + ".auto-backup-"
        for name in os.listdir(BACKUP_DIR):
            if not name.startswith(prefix):
                continue
            full = os.path.join(BACKUP_DIR, name)
            try:
                st = os.stat(full)
            except OSError:
                continue
            if latest is None or st.st_mtime > latest_mtime:
                latest = full
                latest_mtime = st.st_mtime
        return latest, latest_mtime

    def list_backups():
        items = []
        if not os.path.isdir(BACKUP_DIR):
            return items
        for name in os.listdir(BACKUP_DIR):
            if not _is_history_backup_filename(name):
                continue
            full = os.path.join(BACKUP_DIR, name)
            try:
                st = os.stat(full)
            except OSError:
                continue
            items.append(
                {
                    "name": name,
                    "size": st.st_size,
                    "mtime": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(st.st_mtime)),
                }
            )
        items.sort(key=lambda x: x["mtime"], reverse=True)
        return items

    # -------- Blueprint registration
    from routes_utils import create_utils_blueprint
    from routes_ui_settings import create_ui_settings_blueprint
    from routes_ws_support import create_ws_support_blueprint
    from routes_ws_streams import create_ws_streams_blueprint
    from routes_capabilities import create_capabilities_blueprint
    from routes_xkeen_lists import create_xkeen_lists_blueprint
    from routes_config_exchange import create_config_exchange_blueprint
    from routes_routing import create_routing_blueprint
    from routes_xray_configs import create_xray_configs_blueprint
    from routes_mihomo import create_mihomo_blueprint
    from routes_backup import create_backups_blueprint
    from routes_service import create_service_blueprint
    from routes_xray_logs import create_xray_logs_blueprint
    from routes_commands import create_commands_blueprint
    from routes_devtools import create_devtools_blueprint
    from routes_fs import create_fs_blueprint
    from routes_remotefs import create_remotefs_blueprint
    from routes_fileops import create_fileops_blueprint

    app.register_blueprint(create_utils_blueprint())
    app.register_blueprint(create_ui_settings_blueprint())
    app.register_blueprint(create_ws_support_blueprint())
    app.register_blueprint(create_ws_streams_blueprint())
    app.register_blueprint(create_capabilities_blueprint())

    app.register_blueprint(create_xkeen_lists_blueprint(restart_xkeen=restart_xkeen))
    app.register_blueprint(create_config_exchange_blueprint(github_owner=GITHUB_OWNER, github_repo=GITHUB_REPO))

    app.register_blueprint(
        create_routing_blueprint(
            ROUTING_FILE=ROUTING_FILE,
            ROUTING_FILE_RAW=ROUTING_FILE_RAW,
            XRAY_CONFIGS_DIR=XRAY_CONFIGS_DIR,
            XRAY_CONFIGS_DIR_REAL=XRAY_CONFIGS_DIR_REAL,
            BACKUP_DIR=BACKUP_DIR,
            BACKUP_DIR_REAL=BACKUP_DIR_REAL,
            load_json=load_json,
            strip_json_comments_text=strip_json_comments_text,
            restart_xkeen=restart_xkeen,
        )
    )

    app.register_blueprint(
        create_xray_configs_blueprint(
            restart_xkeen=restart_xkeen,
            load_json=load_json,
            save_json=save_json,
            strip_json_comments_text=strip_json_comments_text,
            snapshot_xray_config_before_overwrite=snapshot_xray_config_before_overwrite,
        )
    )

    app.register_blueprint(
        create_mihomo_blueprint(
            MIHOMO_CONFIG_FILE=MIHOMO_CONFIG_FILE,
            MIHOMO_TEMPLATES_DIR=MIHOMO_TEMPLATES_DIR,
            MIHOMO_DEFAULT_TEMPLATE=MIHOMO_DEFAULT_TEMPLATE,
            restart_xkeen=restart_xkeen,
        )
    )

    app.register_blueprint(
        create_backups_blueprint(
            BACKUP_DIR=BACKUP_DIR,
            ROUTING_FILE=ROUTING_FILE,
            ROUTING_FILE_RAW=ROUTING_FILE_RAW,
            INBOUNDS_FILE=INBOUNDS_FILE,
            OUTBOUNDS_FILE=OUTBOUNDS_FILE,
            load_json=load_json,
            save_json=save_json,
            list_backups=list_backups,
            _detect_backup_target_file=_detect_backup_target_file,
            _find_latest_auto_backup_for=_find_latest_auto_backup_for,
            strip_json_comments_text=strip_json_comments_text,
            restart_xkeen=restart_xkeen,
        )
    )

    from services.events import broadcast_event

    app.register_blueprint(
        create_service_blueprint(
            restart_xkeen=restart_xkeen,
            append_restart_log=append_restart_log,
            XRAY_ERROR_LOG=XRAY_ERROR_LOG,
            broadcast_event=broadcast_event,
            read_restart_log=read_restart_log,
            clear_restart_log=clear_restart_log,
        )
    )

    app.register_blueprint(create_xray_logs_blueprint(ws_debug=ws_debug, restart_xray_core=restart_xray_core))
    app.register_blueprint(create_commands_blueprint())
    app.register_blueprint(create_devtools_blueprint(UI_STATE_DIR))

    # Local filesystem facade (always enabled).
    remotefs_mgr = None
    try:
        fs_bp = create_fs_blueprint(
            tmp_dir=str(os.getenv("XKEEN_REMOTEFM_TMP_DIR", "/tmp") or "/tmp"),
            max_upload_mb=int(os.getenv("XKEEN_REMOTEFM_MAX_UPLOAD_MB", "200") or "200"),
            xray_configs_dir=XRAY_CONFIGS_DIR,
            backup_dir=BACKUP_DIR,
        )
        app.register_blueprint(fs_bp)
    except Exception as _e:
        try:
            ws_debug("fs blueprint init failed", error=str(_e))
        except Exception:
            pass

    # RemoteFS blueprint (optional; disabled on MIPS and when lftp is missing)
    from services.capabilities import detect_capabilities, detect_remotefs_state

    try:
        _caps = detect_capabilities(dict(os.environ))
        app.extensions["xkeen.capabilities"] = _caps
    except Exception:
        _caps = None

    _remote_enabled = bool((_caps or {}).get("remoteFs", {}).get("enabled"))
    if _remote_enabled:
        try:
            _r = detect_remotefs_state(dict(os.environ))
            _lftp_bin = _r.get("lftp_bin") or "lftp"
            remotefs_bp, remotefs_mgr = create_remotefs_blueprint(
                enabled=True,
                lftp_bin=_lftp_bin,
                max_sessions=int(os.getenv("XKEEN_REMOTEFM_MAX_SESSIONS", "6")),
                ttl_seconds=int(os.getenv("XKEEN_REMOTEFM_SESSION_TTL", "900")),
                max_upload_mb=int(os.getenv("XKEEN_REMOTEFM_MAX_UPLOAD_MB", "200")),
                tmp_dir=str(os.getenv("XKEEN_REMOTEFM_TMP_DIR", "/tmp") or "/tmp"),
                return_mgr=True,
            )
            app.extensions["xkeen.remotefs_mgr"] = remotefs_mgr
            app.register_blueprint(remotefs_bp)
        except Exception as _e:
            try:
                ws_debug("remotefs init failed", error=str(_e))
            except Exception:
                pass

    # FileOps blueprint (copy/move/delete; supports RemoteFS if enabled)
    try:
        fileops_bp = create_fileops_blueprint(
            remotefs_mgr=remotefs_mgr,
            tmp_dir=str(os.getenv("XKEEN_REMOTEFM_TMP_DIR", "/tmp") or "/tmp"),
            max_upload_mb=int(os.getenv("XKEEN_REMOTEFM_MAX_UPLOAD_MB", "200")),
        )
        app.register_blueprint(fileops_bp)
    except Exception as _e:
        try:
            ws_debug("fileops init failed", error=str(_e))
        except Exception:
            pass

    return app
