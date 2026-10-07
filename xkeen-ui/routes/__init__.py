"""Blueprint composition for the modular Xkeen UI backend."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from core.context import AppContext


def _lifecycle_port() -> int:
    raw = str(os.environ.get("XKEEN_UI_PORT") or "8088").strip()
    try:
        port = int(raw)
    except (TypeError, ValueError):
        return 8088
    return port if 0 < port <= 65535 else 8088


def register_blueprints(app, ctx: Optional[AppContext] = None):
    """Register only the blueprints owned by active backend modules.

    The registry resolves the active set before this function is called.
    Imports stay inside their ownership gates so an inactive module neither
    registers routes nor imports its optional backend implementation.
    """

    if ctx is None:
        raise ValueError("ctx is required for blueprint registration during refactor")

    active_modules = {
        str(module_id)
        for module_id in (ctx.module_activation or {}).get("active_module_ids", [])
    }
    app.extensions["xkeen.module_activation"] = dict(ctx.module_activation or {})

    def module_active(module_id: str) -> bool:
        return module_id in active_modules

    def module_change_guard(module_id: str, enabled: bool) -> dict[str, object] | None:
        if enabled or module_id not in {"engine.xray", "engine.mihomo"}:
            return None
        try:
            from services.cores import detect_running_core

            running_core = detect_running_core()
        except Exception:
            running_core = None
        running_module = {
            "xray": "engine.xray",
            "mihomo": "engine.mihomo",
        }.get(running_core or "")
        if running_module != module_id:
            return None
        try:
            from services.dns_service_lifecycle import get_stop_protection

            protection = get_stop_protection(
                ui_state_dir=ctx.ui_state_dir,
                mihomo_config_file=ctx.mihomo_config_file,
            )
            owner_module = {
                "dns-over-vless": "engine.xray",
                "mihomo-dns": "engine.mihomo",
            }.get(str(protection.get("owner") or ""))
            if protection.get("active") and owner_module == module_id:
                return {
                    "status": 409,
                    "code": "dns_protection_active",
                    "message": "Сначала безопасно снимите активную DNS-защиту.",
                    "owner": protection.get("owner"),
                    "module_id": module_id,
                }
        except Exception as exc:
            return {
                "status": 409,
                "code": "dns_protection_state_unknown",
                "message": "Нельзя отключить ядро: состояние DNS-защиты неизвестно.",
                "error": str(exc),
                "module_id": module_id,
            }
        if module_id in active_modules:
            return {
                "status": 409,
                "code": "active_core_module",
                "message": "Нельзя отключить активное ядро до безопасного переключения.",
                "module_id": module_id,
            }
        return None

    def publish_blueprint_owner_diagnostic() -> None:
        from services.module_registry import BLUEPRINT_OWNERS, WS_HANDLER_OWNERS

        owner_map = BLUEPRINT_OWNERS
        registered = sorted(app.blueprints)
        unknown = sorted(set(registered) - set(owner_map))
        app.extensions["xkeen.module_owner_map"] = {
            name: owner_map[name] for name in registered if name in owner_map
        }
        app.extensions["xkeen.module_owner_errors"] = unknown
        app.extensions["xkeen.ws_owner_map"] = dict(WS_HANDLER_OWNERS)

    def _warn_init(key: str, msg: str, exc: Exception) -> None:
        err = str(exc)
        owner_by_error = {
            "fs_blueprint_init_failed": "tool.files",
            "remotefs_init_failed": "tool.files",
            "fileops_init_failed": "tool.files",
        }
        owner = owner_by_error.get(key)
        if owner:
            try:
                ctx.module_registry.record_initialization_failure(owner, exc)
            except Exception:
                pass
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

    def fail_module(module_id: str, key: str, exc: Exception) -> None:
        try:
            ctx.module_registry.record_initialization_failure(module_id, exc)
        except Exception:
            pass
        _warn_init(key, f"{module_id} init failed (non-fatal)", exc)

    def register_module_blueprints(module_id: str, key: str, build) -> bool:
        """Build every blueprint of a module, then register them together.

        ``build`` imports and creates the blueprints.  Flask cannot unregister
        a blueprint, so nothing is registered unless all of them were created:
        a failing optional module never stays half-registered or stops core.
        """

        try:
            blueprints = list(build())
        except Exception as exc:  # noqa: BLE001
            fail_module(module_id, key, exc)
            return False
        for blueprint in blueprints:
            app.register_blueprint(blueprint)
        return True

    # Core routes always remain available.
    from .capabilities import create_capabilities_blueprint
    from .config_exchange import create_config_exchange_blueprint
    from .cores_status import create_cores_status_blueprint
    from .modules import create_modules_blueprint
    from .service import create_service_blueprint
    from .ui_settings import create_ui_settings_blueprint
    from .utils import create_utils_blueprint
    from .xkeen_lists import create_xkeen_lists_blueprint
    from services import panel_service
    from services.module_lifecycle import ModuleLifecycleService

    def lifecycle_active_engines() -> frozenset[str]:
        from services.cores import detect_running_core

        module_id = {
            "xray": "engine.xray",
            "mihomo": "engine.mihomo",
        }.get(detect_running_core() or "")
        return frozenset({module_id}) if module_id else frozenset()

    lifecycle_root = Path(ctx.ui_state_dir)
    lifecycle_service = ModuleLifecycleService(
        ctx.module_registry,
        panel_root=lifecycle_root,
        state_dir=lifecycle_root,
        active_engines=lifecycle_active_engines,
        health_url=f"http://127.0.0.1:{_lifecycle_port()}/login",
        # Служба самой панели: перезапуск XKeen оставил бы работать прежний
        # процесс панели и оборвал бы клиентам интернет.
        restart_cmd=panel_service.panel_restart_command(),
        restart_panel=lambda source: panel_service.restart_panel(source),
    )
    app.extensions["xkeen.module_lifecycle"] = lifecycle_service

    app.register_blueprint(create_utils_blueprint())
    app.register_blueprint(create_ui_settings_blueprint())
    app.register_blueprint(create_capabilities_blueprint(ctx.module_registry))
    app.register_blueprint(
        create_modules_blueprint(
            ctx.module_registry,
            before_change=module_change_guard,
            lifecycle_service=lifecycle_service,
        )
    )
    app.register_blueprint(create_cores_status_blueprint(ctx.ui_state_dir))
    app.register_blueprint(create_xkeen_lists_blueprint(restart_xkeen=ctx.restart_xkeen))
    app.register_blueprint(
        create_config_exchange_blueprint(
            github_owner=ctx.github_owner,
            github_repo=ctx.github_repo,
        )
    )

    # WebSocket token issuance is needed by every active WS-owning module.
    if (
        module_active("tool.terminal")
        or module_active("engine.xray")
        or module_active("tool.advanced-diagnostics")
        or module_active("engine.mihomo")
    ):
        from .ws_support import create_ws_support_blueprint

        app.register_blueprint(create_ws_support_blueprint())

    if module_active("engine.xray") or module_active("tool.advanced-diagnostics"):
        from .ws_streams import create_ws_streams_blueprint

        app.register_blueprint(create_ws_streams_blueprint())

    # Xray: routing/config APIs, subscriptions and logs.
    if module_active("engine.xray"):
        def _build_xray():
            from .core_profiles import create_core_profiles_blueprint
            from .routing import create_routing_blueprint
            from .xray_configs import create_xray_configs_blueprint
            from .xray_logs import create_xray_logs_blueprint
            from .xray_subscriptions import create_xray_subscriptions_blueprint
            from services.core_installer import CoreInstaller
            from services.core_profile_state import CoreProfileStateStore
            from services.cores import detect_running_core

            core_installer = app.extensions.get("xkeen.core_installer")
            if core_installer is None:
                core_installer = CoreInstaller(
                    state_store=CoreProfileStateStore(ctx.ui_state_dir),
                    binary_paths={"xray": "/opt/sbin/xray", "mihomo": "/opt/sbin/mihomo"},
                    xray_configs_dir=ctx.xray_configs_dir,
                    mihomo_config_file=ctx.mihomo_config_file,
                    restart=ctx.restart_xkeen,
                    running_core=detect_running_core,
                )
                app.extensions["xkeen.core_installer"] = core_installer

            return (
                create_core_profiles_blueprint("xray", core_installer),
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
                    UI_STATE_DIR=ctx.ui_state_dir,
                    MIHOMO_CONFIG_FILE=ctx.mihomo_config_file,
                    append_restart_log=ctx.append_restart_log,
                    save_operation_diagnostic=ctx.save_operation_diagnostic,
                ),
                create_xray_configs_blueprint(
                    restart_xkeen=ctx.restart_xkeen,
                    load_json=ctx.load_json,
                    save_json=ctx.save_json,
                    strip_json_comments_text=ctx.strip_json_comments_text,
                    snapshot_xray_config_before_overwrite=ctx.snapshot_xray_config_before_overwrite,
                    ui_state_dir=ctx.ui_state_dir,
                ),
                create_xray_subscriptions_blueprint(
                    ui_state_dir=ctx.ui_state_dir,
                    xray_configs_dir=ctx.xray_configs_dir,
                    restart_xkeen=ctx.restart_xkeen,
                    snapshot_xray_config_before_overwrite=ctx.snapshot_xray_config_before_overwrite,
                ),
                create_xray_logs_blueprint(
                    ws_debug=ctx.ws_debug,
                    restart_xray_core=ctx.restart_xray_core,
                    ui_state_dir=ctx.ui_state_dir,
                    append_restart_log=ctx.append_restart_log,
                ),
            )

        register_module_blueprints("engine.xray", "xray_blueprint_init_failed", _build_xray)

    # Mihomo: config, Clash API/cache/telemetry and optional Happ integration.
    if module_active("engine.mihomo"):
        def _build_mihomo():
            from .core_profiles import create_core_profiles_blueprint
            from .mihomo import create_mihomo_blueprint
            from .mihomo_clash import create_mihomo_clash_blueprint
            from services.core_installer import CoreInstaller
            from services.core_profile_state import CoreProfileStateStore
            from services.cores import detect_running_core
            from services.mihomo_clash_cache import get_shared_mihomo_clash_cache

            core_installer = app.extensions.get("xkeen.core_installer")
            if core_installer is None:
                core_installer = CoreInstaller(
                    state_store=CoreProfileStateStore(ctx.ui_state_dir),
                    binary_paths={"xray": "/opt/sbin/xray", "mihomo": "/opt/sbin/mihomo"},
                    xray_configs_dir=ctx.xray_configs_dir,
                    mihomo_config_file=ctx.mihomo_config_file,
                    restart=ctx.restart_xkeen,
                    running_core=detect_running_core,
                )
                app.extensions["xkeen.core_installer"] = core_installer

            return (
                create_core_profiles_blueprint("mihomo", core_installer),
                create_mihomo_blueprint(
                    MIHOMO_CONFIG_FILE=ctx.mihomo_config_file,
                    MIHOMO_TEMPLATES_DIR=ctx.mihomo_templates_dir,
                    MIHOMO_DEFAULT_TEMPLATE=ctx.mihomo_default_template,
                    ui_state_dir=ctx.ui_state_dir,
                    restart_xkeen=ctx.restart_xkeen,
                ),
                create_mihomo_clash_blueprint(
                    mihomo_config_file=ctx.mihomo_config_file,
                    mihomo_root=os.path.dirname(ctx.mihomo_config_file),
                    ui_state_dir=ctx.ui_state_dir,
                    audit_logger=ctx.append_restart_log,
                    cache=get_shared_mihomo_clash_cache(),
                ),
            )

        register_module_blueprints("engine.mihomo", "mihomo_blueprint_init_failed", _build_mihomo)

    if module_active("integration.happ"):
        def _build_happ():
            from .happ_decryptor import create_happ_decryptor_blueprint

            return (create_happ_decryptor_blueprint(),)

        register_module_blueprints("integration.happ", "happ_blueprint_init_failed", _build_happ)

    if module_active("tool.backups"):
        def _build_backups():
            from .backups import create_backups_blueprint

            return (
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
                ),
            )

        register_module_blueprints("tool.backups", "backups_blueprint_init_failed", _build_backups)

    if module_active("engine.xray") or module_active("engine.mihomo"):
        from services.dns_service_lifecycle import get_stop_protection, release_for_service_stop

        def dns_stop_status():
            return get_stop_protection(
                ui_state_dir=ctx.ui_state_dir,
                mihomo_config_file=ctx.mihomo_config_file,
            )

        def dns_stop_release(owner):
            return release_for_service_stop(
                expected_owner=owner,
                configs_dir=ctx.xray_configs_dir,
                routing_file=ctx.routing_file,
                ui_state_dir=ctx.ui_state_dir,
                mihomo_config_file=ctx.mihomo_config_file,
                restart_xkeen=ctx.restart_xkeen,
            )

    else:
        def dns_stop_status():
            return {"active": False, "owner": None}

        def dns_stop_release(_owner):
            return {"ok": False, "reason": "module_not_enabled"}

    app.register_blueprint(
        create_service_blueprint(
            restart_xkeen=ctx.restart_xkeen,
            append_restart_log=ctx.append_restart_log,
            append_restart_log_text=ctx.append_restart_log_text,
            XRAY_ERROR_LOG=ctx.xray_error_log,
            read_restart_log=ctx.read_restart_log,
            clear_restart_log=ctx.clear_restart_log,
            read_operation_diagnostic=ctx.read_operation_diagnostic,
            dns_stop_status=dns_stop_status,
            dns_stop_release=dns_stop_release,
        )
    )

    if module_active("tool.terminal"):
        def _build_terminal():
            from .commands import create_commands_blueprint

            return (create_commands_blueprint(),)

        register_module_blueprints("tool.terminal", "terminal_blueprint_init_failed", _build_terminal)

    # Core-owned maintenance APIs (self-update, core.log, recovery and
    # module-control diagnostics) must remain available even when the optional
    # advanced diagnostics UI is disabled.
    from .devtools import create_devtools_blueprint
    app.register_blueprint(
        create_devtools_blueprint(
            ctx.ui_state_dir,
            include_advanced=module_active("tool.advanced-diagnostics"),
            lifecycle_service=lifecycle_service,
        )
    )

    if module_active("tool.advanced-diagnostics"):
        def _build_system_resources():
            from .system_resources import create_system_resources_blueprint

            return (create_system_resources_blueprint(),)

        register_module_blueprints(
            "tool.advanced-diagnostics",
            "system_resources_blueprint_init_failed",
            _build_system_resources,
        )

    if not module_active("tool.files"):
        publish_blueprint_owner_diagnostic()
        return

    # FS / RemoteFS / FileOps are one ownership group and are never imported
    # for installations where the files tool is disabled.
    try:
        from .fileops import create_fileops_blueprint
        from .fs import create_fs_blueprint
        from .remotefs.blueprint import create_remotefs_blueprint
        from .storage_usb import create_storage_usb_blueprint
        from services import get_capabilities, get_remotefs_state
    except Exception as exc:  # noqa: BLE001
        fail_module("tool.files", "files_import_failed", exc)
        publish_blueprint_owner_diagnostic()
        return

    register_module_blueprints(
        "tool.files",
        "storage_usb_blueprint_init_failed",
        lambda: (create_storage_usb_blueprint(),),
    )
    remotefs_mgr = None
    try:
        fs_bp = create_fs_blueprint(
            tmp_dir=str(os.getenv("XKEEN_REMOTEFM_TMP_DIR", "/tmp") or "/tmp"),
            max_upload_mb=int(os.getenv("XKEEN_REMOTEFM_MAX_UPLOAD_MB", "200") or "200"),
            xray_configs_dir=ctx.xray_configs_dir,
            backup_dir=ctx.backup_dir,
        )
        app.register_blueprint(fs_bp)
    except Exception as exc:  # noqa: BLE001
        _warn_init("fs_blueprint_init_failed", "fs blueprint init failed", exc)

    try:
        caps = get_capabilities(dict(os.environ), module_registry=ctx.module_registry)
        app.extensions["xkeen.capabilities"] = caps
    except Exception as exc:  # noqa: BLE001
        caps = None
        _warn_init("capabilities_detect_failed", "capabilities detect failed (non-fatal)", exc)

    if bool((caps or {}).get("remoteFs", {}).get("enabled")):
        try:
            remote = get_remotefs_state(dict(os.environ))
            remotefs_bp, remotefs_mgr = create_remotefs_blueprint(
                enabled=True,
                lftp_bin=remote.get("lftp_bin") or "lftp",
                max_sessions=int(os.getenv("XKEEN_REMOTEFM_MAX_SESSIONS", "6")),
                ttl_seconds=int(os.getenv("XKEEN_REMOTEFM_SESSION_TTL", "900")),
                max_upload_mb=int(os.getenv("XKEEN_REMOTEFM_MAX_UPLOAD_MB", "200")),
                tmp_dir=str(os.getenv("XKEEN_REMOTEFM_TMP_DIR", "/tmp") or "/tmp"),
                return_mgr=True,
            )
            app.extensions["xkeen.remotefs_mgr"] = remotefs_mgr
            app.register_blueprint(remotefs_bp)
        except Exception as exc:  # noqa: BLE001
            _warn_init("remotefs_init_failed", "remotefs init failed (non-fatal)", exc)

    try:
        fileops_bp = create_fileops_blueprint(
            remotefs_mgr=remotefs_mgr,
            tmp_dir=str(os.getenv("XKEEN_REMOTEFM_TMP_DIR", "/tmp") or "/tmp"),
            max_upload_mb=int(os.getenv("XKEEN_REMOTEFM_MAX_UPLOAD_MB", "200")),
        )
        app.register_blueprint(fileops_bp)
    except Exception as exc:  # noqa: BLE001
        _warn_init("fileops_init_failed", "fileops init failed (non-fatal)", exc)

    publish_blueprint_owner_diagnostic()
