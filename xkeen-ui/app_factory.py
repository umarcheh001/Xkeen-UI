"""Application factory.

PR18: move Flask app construction and blueprint registration out of app.py.

The goal is to keep app.py a thin compatibility layer (re-exports for
run_server.py) while centralizing initialization here.
"""

from __future__ import annotations

import os
import time
from typing import Any, Dict, Tuple


def _ensure_runtime_env() -> str:
    """Prepare process environment (mihomo root env, etc.).

    Returns:
        CONFIG_PATH from mihomo_server_core.
    """

    from bootstrap_mihomo_env import ensure_mihomo_root_env

    ensure_mihomo_root_env()

    from mihomo_server_core import CONFIG_PATH

    return CONFIG_PATH


def _init_settings_and_logging(*, ws_runtime: bool) -> Tuple["Settings", Dict[str, str]]:
    """Initialize Settings and core logging. No behavior changes."""

    from core.settings import Settings
    from core.logging import init_logging, core_log as _core_log

    settings = Settings.from_env()
    ui_state_dir = settings.ui_state_dir
    base_etc_dir = settings.base_etc_dir
    base_var_dir = settings.base_var_dir

    ui_log_dir, ui_core_log, ui_access_log, ui_ws_log = init_logging(base_var_dir)

    _core_log(
        "info",
        "xkeen-ui init",
        pid=os.getpid(),
        ui_state_dir=ui_state_dir,
        ui_log_dir=ui_log_dir,
        base_etc_dir=base_etc_dir,
        base_var_dir=base_var_dir,
        ws_runtime=bool(ws_runtime),
    )

    return settings, {
        "UI_STATE_DIR": ui_state_dir,
        "BASE_ETC_DIR": base_etc_dir,
        "BASE_VAR_DIR": base_var_dir,
        "UI_LOG_DIR": ui_log_dir,
        "UI_CORE_LOG": ui_core_log,
        "UI_ACCESS_LOG": ui_access_log,
        "UI_WS_LOG": ui_ws_log,
    }


def _init_xray_startup_migrations(*, base_etc_dir: str, base_var_dir: str, ui_state_dir: str) -> Dict[str, Any]:
    """Init Xray paths, backups, and jsonc migration. Never blocks startup."""

    from core.logging import core_log as _core_log

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
    except Exception as e:  # noqa: BLE001
        # Best-effort migration must never block startup, but we should leave a trace.
        _core_log(
            "warning",
            "xray jsonc migration failed",
            error=str(e),
            xray_configs_dir=XRAY_CONFIGS_DIR,
            xray_jsonc_dir=XRAY_JSONC_DIR,
        )

    backup_dir = os.path.join(base_etc_dir, "xray", "configs", "backups")
    try:
        backup_dir_real = os.path.realpath(backup_dir)
    except Exception as e:  # noqa: BLE001
        backup_dir_real = backup_dir
        _core_log(
            "warning",
            "backup_dir realpath failed",
            error=str(e),
            backup_dir=backup_dir,
        )

    from services.xray_backups import (
        is_history_backup_filename as _is_history_backup_filename,
        snapshot_before_overwrite as _snapshot_before_overwrite,
    )

    def snapshot_xray_config_before_overwrite(abs_path: str) -> None:
        try:
            _snapshot_before_overwrite(
                abs_path,
                backup_dir=backup_dir,
                xray_configs_dir_real=XRAY_CONFIGS_DIR_REAL,
                backup_dir_real=backup_dir_real,
                xray_jsonc_dir_real=XRAY_JSONC_DIR_REAL,
            )
        except Exception as e:  # noqa: BLE001
            # Snapshot is best-effort; never break save flow.
            _core_log(
                "warning",
                "snapshot before overwrite failed",
                error=str(e),
                abs_path=abs_path,
                backup_dir=backup_dir,
            )
            return

    from services.xkeen_commands_catalog import build_xkeen_cmd

    xkeen_restart_cmd = build_xkeen_cmd("-restart")
    restart_log_file = os.environ.get(
        "XKEEN_RESTART_LOG_FILE", os.path.join(ui_state_dir, "restart.log")
    )
    xray_log_config_file = os.path.join(base_etc_dir, "xray", "configs", "01_log.json")
    xray_access_log = os.path.join(base_var_dir, "log", "xray", "access.log")
    xray_error_log = os.path.join(base_var_dir, "log", "xray", "error.log")
    xray_access_log_saved = xray_access_log + ".saved"
    xray_error_log_saved = xray_error_log + ".saved"

    _xray_log_tz_env = os.environ.get("XKEEN_XRAY_LOG_TZ_OFFSET", "3")
    try:
        xray_log_tz_offset_hours = int(_xray_log_tz_env)
    except ValueError:
        xray_log_tz_offset_hours = 3

    return {
        "XRAY_CONFIGS_DIR": XRAY_CONFIGS_DIR,
        "XRAY_CONFIGS_DIR_REAL": XRAY_CONFIGS_DIR_REAL,
        "XRAY_JSONC_DIR": XRAY_JSONC_DIR,
        "XRAY_JSONC_DIR_REAL": XRAY_JSONC_DIR_REAL,
        "ROUTING_FILE": ROUTING_FILE,
        "ROUTING_FILE_RAW": ROUTING_FILE_RAW,
        "INBOUNDS_FILE": INBOUNDS_FILE,
        "OUTBOUNDS_FILE": OUTBOUNDS_FILE,
        "BACKUP_DIR": backup_dir,
        "BACKUP_DIR_REAL": backup_dir_real,
        "is_history_backup_filename": _is_history_backup_filename,
        "snapshot_xray_config_before_overwrite": snapshot_xray_config_before_overwrite,
        "XKEEN_RESTART_CMD": xkeen_restart_cmd,
        "RESTART_LOG_FILE": restart_log_file,
        "XRAY_LOG_CONFIG_FILE": xray_log_config_file,
        "XRAY_ACCESS_LOG": xray_access_log,
        "XRAY_ERROR_LOG": xray_error_log,
        "XRAY_ACCESS_LOG_SAVED": xray_access_log_saved,
        "XRAY_ERROR_LOG_SAVED": xray_error_log_saved,
        "XRAY_LOG_TZ_OFFSET_HOURS": xray_log_tz_offset_hours,
    }


def _create_flask_app():
    from flask import Flask
    from routes.ui_assets import apply_response_cache_policy, get_static_asset_max_age

    class XkeenFlask(Flask):
        def get_send_file_max_age(self, filename):  # type: ignore[override]
            try:
                return get_static_asset_max_age(filename)
            except Exception:
                return super().get_send_file_max_age(filename)

    app = XkeenFlask(__name__, static_folder="static", template_folder="templates")
    try:
        app.config.setdefault("SEND_FILE_MAX_AGE_DEFAULT", 0)
    except Exception as e:  # noqa: BLE001
        # Non-fatal: only affects cache headers for static send_file.
        try:
            from core.logging import core_log_once
            core_log_once(
                "debug",
                "flask_send_file_cache_disable_failed",
                "flask config setdefault failed (non-fatal)",
                error=str(e),
            )
        except Exception:
            pass

    @app.after_request
    def _apply_ui_cache_policy(response):
        return apply_response_cache_policy(response)

    return app


def _register_favicon(app):
    from flask import send_from_directory

    @app.route("/favicon.ico")
    def favicon():
        return send_from_directory(
            app.static_folder, "favicon.ico", mimetype="image/vnd.microsoft.icon"
        )


def _init_auth_and_pages(
    app,
    *,
    ui_state_dir: str,
    routing_file: str,
    mihomo_config_file: str,
    inbounds_file: str,
    outbounds_file: str,
    backup_dir: str,
    command_groups,
    github_repo_url: str,
):
    from services.auth_setup import init_auth

    init_auth(app)

    from services import devtools as _svc_devtools
    from routes.ui_assets import init_ui_assets_helpers, register_ui_assets_routes
    from routes.auth import register_auth_routes
    from routes.pages import register_pages_routes

    init_ui_assets_helpers(app)
    register_ui_assets_routes(app, UI_STATE_DIR=ui_state_dir, devtools_service=_svc_devtools)
    register_auth_routes(app)
    register_pages_routes(
        app,
        ROUTING_FILE=routing_file,
        MIHOMO_CONFIG_FILE=mihomo_config_file,
        INBOUNDS_FILE=inbounds_file,
        OUTBOUNDS_FILE=outbounds_file,
        BACKUP_DIR=backup_dir,
        COMMAND_GROUPS=command_groups,
        GITHUB_REPO_URL=github_repo_url,
    )


def _init_ws_debug_logger(*, ui_ws_log: str):
    from services.ws_debug import init_ws_debug

    try:
        init_ws_debug(ui_ws_log)
    except Exception as e:  # noqa: BLE001
        # WS debug logger is optional; never block startup.
        try:
            from core.logging import core_log_once
            core_log_once(
                "warning",
                "ws_debug_init_failed",
                "ws_debug init failed (non-fatal)",
                error=str(e),
                ui_ws_log=ui_ws_log,
            )
        except Exception:
            pass


def _init_access_log_middleware(app):
    from services.logging_setup import (
        access_enabled as _access_enabled,
        access_logger as _get_access_logger,
    )
    from middleware.access_log import init_access_log as _init_access_log

    _init_access_log(app, _access_enabled, _get_access_logger, skip_prefixes=("/static/", "/ws/"))


def _register_api_blueprints(app, ctx: "AppContext"):
    # Centralized blueprint registration (see routes.register_blueprints).
    from routes import register_blueprints

    register_blueprints(app, ctx)


def create_app(*, ws_runtime: bool = False):
    """Create and configure the Flask application.

    Args:
        ws_runtime: Whether WebSocket runtime is *actually* active. In practice,
            run_server.py sets this later via app.set_ws_runtime(True), but we
            still accept the flag for testability.
    """

    # Local imports to reduce side-effects on module import.
    settings, env = _init_settings_and_logging(ws_runtime=ws_runtime)

    # Importing mihomo_server_core can be early; do it after logging is ready so best-effort
    # failures leave a trace.
    CONFIG_PATH = _ensure_runtime_env()
    UI_STATE_DIR = env["UI_STATE_DIR"]
    BASE_ETC_DIR = env["BASE_ETC_DIR"]
    BASE_VAR_DIR = env["BASE_VAR_DIR"]
    UI_WS_LOG = env["UI_WS_LOG"]

    xray_ctx = _init_xray_startup_migrations(
        base_etc_dir=BASE_ETC_DIR,
        base_var_dir=BASE_VAR_DIR,
        ui_state_dir=UI_STATE_DIR,
    )

    XRAY_CONFIGS_DIR = xray_ctx["XRAY_CONFIGS_DIR"]
    XRAY_CONFIGS_DIR_REAL = xray_ctx["XRAY_CONFIGS_DIR_REAL"]
    XRAY_JSONC_DIR_REAL = xray_ctx["XRAY_JSONC_DIR_REAL"]
    ROUTING_FILE = xray_ctx["ROUTING_FILE"]
    ROUTING_FILE_RAW = xray_ctx["ROUTING_FILE_RAW"]
    INBOUNDS_FILE = xray_ctx["INBOUNDS_FILE"]
    OUTBOUNDS_FILE = xray_ctx["OUTBOUNDS_FILE"]
    BACKUP_DIR = xray_ctx["BACKUP_DIR"]
    BACKUP_DIR_REAL = xray_ctx["BACKUP_DIR_REAL"]
    snapshot_xray_config_before_overwrite = xray_ctx["snapshot_xray_config_before_overwrite"]
    is_history_backup_filename = xray_ctx["is_history_backup_filename"]
    XKEEN_RESTART_CMD = xray_ctx["XKEEN_RESTART_CMD"]
    RESTART_LOG_FILE = xray_ctx["RESTART_LOG_FILE"]
    XRAY_LOG_CONFIG_FILE = xray_ctx["XRAY_LOG_CONFIG_FILE"]
    XRAY_ACCESS_LOG = xray_ctx["XRAY_ACCESS_LOG"]
    XRAY_ERROR_LOG = xray_ctx["XRAY_ERROR_LOG"]
    XRAY_LOG_TZ_OFFSET_HOURS = xray_ctx["XRAY_LOG_TZ_OFFSET_HOURS"]

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
    app = _create_flask_app()
    _register_favicon(app)

    _init_auth_and_pages(
        app,
        ui_state_dir=UI_STATE_DIR,
        routing_file=ROUTING_FILE,
        mihomo_config_file=MIHOMO_CONFIG_FILE,
        inbounds_file=INBOUNDS_FILE,
        outbounds_file=OUTBOUNDS_FILE,
        backup_dir=BACKUP_DIR,
        command_groups=COMMAND_GROUPS,
        github_repo_url=GITHUB_REPO_URL,
    )

    _init_ws_debug_logger(ui_ws_log=UI_WS_LOG)

    from services.ws_debug import ws_debug

    _init_access_log_middleware(app)

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
        except Exception as e:  # noqa: BLE001
            # Best-effort: failure shouldn't block backup operations, but leave a trace.
            try:
                from core.logging import core_warn_budget
                core_warn_budget(
                    "backup_target_detect_failed",
                    "backup target detect failed (non-fatal)",
                    error=str(e),
                    filename=name,
                    prefix=prefix,
                )
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
            if not is_history_backup_filename(name):
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

    from core.context import AppContext
    from services.logging_setup import core_logger

    ctx = AppContext(
        settings=settings,
        logger=core_logger(),
        ui_state_dir=UI_STATE_DIR,
        github_owner=GITHUB_OWNER,
        github_repo=GITHUB_REPO,
        mihomo_config_file=MIHOMO_CONFIG_FILE,
        mihomo_templates_dir=MIHOMO_TEMPLATES_DIR,
        mihomo_default_template=MIHOMO_DEFAULT_TEMPLATE,
        xray_configs_dir=XRAY_CONFIGS_DIR,
        xray_configs_dir_real=XRAY_CONFIGS_DIR_REAL,
        routing_file=ROUTING_FILE,
        routing_file_raw=ROUTING_FILE_RAW,
        inbounds_file=INBOUNDS_FILE,
        outbounds_file=OUTBOUNDS_FILE,
        backup_dir=BACKUP_DIR,
        backup_dir_real=BACKUP_DIR_REAL,
        xray_error_log=XRAY_ERROR_LOG,
        load_json=load_json,
        save_json=save_json,
        strip_json_comments_text=strip_json_comments_text,
        snapshot_xray_config_before_overwrite=snapshot_xray_config_before_overwrite,
        list_backups=list_backups,
        detect_backup_target_file=_detect_backup_target_file,
        find_latest_auto_backup_for=_find_latest_auto_backup_for,
        restart_xkeen=restart_xkeen,
        append_restart_log=append_restart_log,
        read_restart_log=read_restart_log,
        clear_restart_log=clear_restart_log,
        ws_debug=ws_debug,
        restart_xray_core=restart_xray_core,
    )

    _register_api_blueprints(app, ctx)

    return app
