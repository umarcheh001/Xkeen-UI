"""Routes package.

Historically the project used flat modules like `routes_fs.py`.
We introduce `routes.*` packages gradually for refactoring without
changing public URLs or blueprint names.
"""

from __future__ import annotations

import os
from typing import Optional

from core.context import AppContext


def register_blueprints(app, ctx: Optional[AppContext] = None):
    """Register all Flask blueprints.

    Single entry-point for blueprint registration.
    Keeps behavior compatible with the historical registration code in `app_factory.py`.
    """
    if ctx is None:
        raise ValueError("ctx is required for blueprint registration during refactor")

    # Controlled init warnings: avoid silent failures for optional blueprints.
    def _warn_init(key: str, msg: str, exc: Exception) -> None:
        err = str(exc)
        try:
            if callable(ctx.ws_debug):
                ctx.ws_debug(msg, error=err)
        except Exception:
            pass
        try:
            from core.logging import core_warn_budget
            core_warn_budget(key, msg, error=err)
        except Exception:
            pass

    from .utils import create_utils_blueprint
    from .ui_settings import create_ui_settings_blueprint
    from .ws_support import create_ws_support_blueprint
    from .ws_streams import create_ws_streams_blueprint
    from .capabilities import create_capabilities_blueprint
    from .xkeen_lists import create_xkeen_lists_blueprint
    from .config_exchange import create_config_exchange_blueprint
    from .routing import create_routing_blueprint
    from .xray_configs import create_xray_configs_blueprint
    from .xray_subscriptions import create_xray_subscriptions_blueprint
    from .mihomo import create_mihomo_blueprint
    from .backups import create_backups_blueprint
    from .service import create_service_blueprint
    from .xray_logs import create_xray_logs_blueprint
    from .commands import create_commands_blueprint
    from .cores_status import create_cores_status_blueprint
    from .devtools import create_devtools_blueprint
    from .fs import create_fs_blueprint
    from .remotefs.blueprint import create_remotefs_blueprint
    from .fileops import create_fileops_blueprint
    from .storage_usb import create_storage_usb_blueprint

    # Keep registration order stable.
    app.register_blueprint(create_utils_blueprint())
    app.register_blueprint(create_ui_settings_blueprint())
    app.register_blueprint(create_ws_support_blueprint())
    app.register_blueprint(create_ws_streams_blueprint())
    app.register_blueprint(create_capabilities_blueprint())

    app.register_blueprint(create_xkeen_lists_blueprint(restart_xkeen=ctx.restart_xkeen))
    app.register_blueprint(
        create_config_exchange_blueprint(
            github_owner=ctx.github_owner,
            github_repo=ctx.github_repo,
        )
    )

    app.register_blueprint(
        create_routing_blueprint(
            ROUTING_FILE=ctx.routing_file,
            ROUTING_FILE_RAW=ctx.routing_file_raw,
            XRAY_CONFIGS_DIR=ctx.xray_configs_dir,
            XRAY_CONFIGS_DIR_REAL=ctx.xray_configs_dir_real,
            BACKUP_DIR=ctx.backup_dir,
            BACKUP_DIR_REAL=ctx.backup_dir_real,
            load_json=ctx.load_json,
            strip_json_comments_text=ctx.strip_json_comments_text,
            restart_xkeen=ctx.restart_xkeen,
        )
    )

    app.register_blueprint(
        create_xray_configs_blueprint(
            restart_xkeen=ctx.restart_xkeen,
            load_json=ctx.load_json,
            save_json=ctx.save_json,
            strip_json_comments_text=ctx.strip_json_comments_text,
            snapshot_xray_config_before_overwrite=ctx.snapshot_xray_config_before_overwrite,
        )
    )

    app.register_blueprint(
        create_xray_subscriptions_blueprint(
            ui_state_dir=ctx.ui_state_dir,
            xray_configs_dir=ctx.xray_configs_dir,
            restart_xkeen=ctx.restart_xkeen,
            snapshot_xray_config_before_overwrite=ctx.snapshot_xray_config_before_overwrite,
        )
    )

    app.register_blueprint(
        create_mihomo_blueprint(
            MIHOMO_CONFIG_FILE=ctx.mihomo_config_file,
            MIHOMO_TEMPLATES_DIR=ctx.mihomo_templates_dir,
            MIHOMO_DEFAULT_TEMPLATE=ctx.mihomo_default_template,
            restart_xkeen=ctx.restart_xkeen,
        )
    )

    app.register_blueprint(
        create_backups_blueprint(
            BACKUP_DIR=ctx.backup_dir,
            ROUTING_FILE=ctx.routing_file,
            ROUTING_FILE_RAW=ctx.routing_file_raw,
            INBOUNDS_FILE=ctx.inbounds_file,
            OUTBOUNDS_FILE=ctx.outbounds_file,
            load_json=ctx.load_json,
            save_json=ctx.save_json,
            list_backups=ctx.list_backups,
            _detect_backup_target_file=ctx.detect_backup_target_file,
            _find_latest_auto_backup_for=ctx.find_latest_auto_backup_for,
            strip_json_comments_text=ctx.strip_json_comments_text,
            restart_xkeen=ctx.restart_xkeen,
        )
    )

    app.register_blueprint(
        create_service_blueprint(
            restart_xkeen=ctx.restart_xkeen,
            append_restart_log=ctx.append_restart_log,
            XRAY_ERROR_LOG=ctx.xray_error_log,
            read_restart_log=ctx.read_restart_log,
            clear_restart_log=ctx.clear_restart_log,
        )
    )

    app.register_blueprint(
        create_xray_logs_blueprint(
            ws_debug=ctx.ws_debug,
            restart_xray_core=ctx.restart_xray_core,
        )
    )

    app.register_blueprint(create_commands_blueprint())
    # Cores version/update hints (Commands tab header)
    app.register_blueprint(create_cores_status_blueprint(ctx.ui_state_dir))
    # USB storage helper API (list + mount/unmount). Safe to register even if ndmc is missing.
    app.register_blueprint(create_storage_usb_blueprint())
    app.register_blueprint(create_devtools_blueprint(ctx.ui_state_dir))

    # FS / RemoteFS / FileOps are optional and should never block UI start.
    remotefs_mgr = None
    try:
        fs_bp = create_fs_blueprint(
            tmp_dir=str(os.getenv("XKEEN_REMOTEFM_TMP_DIR", "/tmp") or "/tmp"),
            max_upload_mb=int(os.getenv("XKEEN_REMOTEFM_MAX_UPLOAD_MB", "200") or "200"),
            xray_configs_dir=ctx.xray_configs_dir,
            backup_dir=ctx.backup_dir,
        )
        app.register_blueprint(fs_bp)
    except Exception as _e:  # noqa: BLE001
        _warn_init("fs_blueprint_init_failed", "fs blueprint init failed", _e)

    from services import get_capabilities, get_remotefs_state

    try:
        _caps = get_capabilities(dict(os.environ))
        app.extensions["xkeen.capabilities"] = _caps
    except Exception as _e:  # noqa: BLE001
        _caps = None
        _warn_init("capabilities_detect_failed", "capabilities detect failed (non-fatal)", _e)

    _remote_enabled = bool((_caps or {}).get("remoteFs", {}).get("enabled"))
    if _remote_enabled:
        try:
            _r = get_remotefs_state(dict(os.environ))
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
        except Exception as _e:  # noqa: BLE001
            _warn_init("remotefs_init_failed", "remotefs init failed (non-fatal)", _e)

    try:
        fileops_bp = create_fileops_blueprint(
            remotefs_mgr=remotefs_mgr,
            tmp_dir=str(os.getenv("XKEEN_REMOTEFM_TMP_DIR", "/tmp") or "/tmp"),
            max_upload_mb=int(os.getenv("XKEEN_REMOTEFM_MAX_UPLOAD_MB", "200")),
        )
        app.register_blueprint(fileops_bp)
    except Exception as _e:  # noqa: BLE001
        _warn_init("fileops_init_failed", "fileops init failed (non-fatal)", _e)
