from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_routes_use_stable_error_codes_instead_of_raw_exception_text():
    config_exchange = (ROOT / "xkeen-ui" / "routes" / "config_exchange.py").read_text(encoding="utf-8")
    devtools = (ROOT / "xkeen-ui" / "routes" / "devtools.py").read_text(encoding="utf-8")
    geodat = (ROOT / "xkeen-ui" / "routes" / "routing" / "geodat.py").read_text(encoding="utf-8")
    service = (ROOT / "xkeen-ui" / "routes" / "service.py").read_text(encoding="utf-8")
    xray_configs = (ROOT / "xkeen-ui" / "routes" / "xray_configs.py").read_text(encoding="utf-8")
    mihomo = (ROOT / "xkeen-ui" / "routes" / "mihomo.py").read_text(encoding="utf-8")
    ui_settings = (ROOT / "xkeen-ui" / "routes" / "ui_settings.py").read_text(encoding="utf-8")
    storage_usb = (ROOT / "xkeen-ui" / "routes" / "storage_usb.py").read_text(encoding="utf-8")
    routing_templates = (ROOT / "xkeen-ui" / "routes" / "routing" / "templates.py").read_text(encoding="utf-8")
    routing_config = (ROOT / "xkeen-ui" / "routes" / "routing" / "config.py").read_text(encoding="utf-8")
    routing_errors = (ROOT / "xkeen-ui" / "routes" / "routing" / "errors.py").read_text(encoding="utf-8")

    assert 'f"read failed: {e}"' not in config_exchange
    assert 'f"invalid json: {e}"' not in config_exchange
    assert 'f"apply failed: {e}"' not in config_exchange
    assert '"meta": {"message": str(e)[:200]}' not in devtools
    assert '"details": str(e)' not in geodat
    assert '{"ok": False, "error": str(e)}' not in service
    assert '"details": e.details' not in service
    assert 'f"invalid json: {e}"' not in xray_configs
    assert 'f"failed to write file: {e}"' not in xray_configs
    assert 'f"failed to write raw file: {e}"' not in xray_configs
    assert '_api_error(str(e),' not in mihomo
    assert 'f"apply failed: {e}"' not in mihomo
    assert 'Failed to run mihomo validate: {e}' not in mihomo
    assert 'f"failed to load settings: {e}"' not in ui_settings
    assert 'f"failed to save settings: {e}"' not in ui_settings
    assert 'f"storage list failed: {e}"' not in storage_usb
    assert 'f"mount failed: {e}"' not in storage_usb
    assert 'f"unmount failed: {e}"' not in storage_usb
    assert 'f"failed to read template: {e}"' not in routing_templates
    assert 'f"invalid json/jsonc: {e}"' not in routing_templates
    assert 'f"failed to write template: {e}"' not in routing_templates
    assert 'f"failed to write routing file: {e}"' not in routing_config
    assert 'f"failed to write raw file: {e}"' not in routing_config
    assert 'f"failed to schedule restart job: {e}"' not in routing_config
    assert 'payload["details"] = str(details)' not in routing_errors
    assert '" Причина: "' not in routing_errors

    # --- PR-15 wave 2: archive, xray_configs, perms, cores_status, mihomo generate ---
    archive = (ROOT / "xkeen-ui" / "routes" / "fs" / "endpoints_archive.py").read_text(encoding="utf-8")
    transfer = (ROOT / "xkeen-ui" / "routes" / "fs" / "endpoints_transfer.py").read_text(encoding="utf-8")
    list_routes = (ROOT / "xkeen-ui" / "routes" / "fs" / "endpoints_list.py").read_text(encoding="utf-8")
    manage = (ROOT / "xkeen-ui" / "routes" / "fs" / "endpoints_manage.py").read_text(encoding="utf-8")
    perms = (ROOT / "xkeen-ui" / "routes" / "fs" / "endpoints_perms.py").read_text(encoding="utf-8")
    readwrite = (ROOT / "xkeen-ui" / "routes" / "fs" / "endpoints_readwrite.py").read_text(encoding="utf-8")
    trash = (ROOT / "xkeen-ui" / "routes" / "fs" / "endpoints_trash.py").read_text(encoding="utf-8")
    cores_status = (ROOT / "xkeen-ui" / "routes" / "cores_status.py").read_text(encoding="utf-8")
    remotefs_ops = (ROOT / "xkeen-ui" / "routes" / "remotefs" / "ops.py").read_text(encoding="utf-8")
    remotefs_sessions = (ROOT / "xkeen-ui" / "routes" / "remotefs" / "sessions.py").read_text(encoding="utf-8")
    remotefs_transfer = (ROOT / "xkeen-ui" / "routes" / "remotefs" / "transfer.py").read_text(encoding="utf-8")

    assert "details=msg" not in archive
    assert "details=det" not in archive
    assert "error_response(msg," not in archive
    assert "details=det" not in transfer
    assert "details=tail" not in transfer
    assert "details=tail" not in list_routes
    assert "details=tail" not in manage
    assert "error_response(str(e)" not in perms
    assert "details=tail" not in perms
    assert "details=tail" not in readwrite
    assert "details=tail" not in trash
    assert 'str(e)[:200]' not in cores_status
    assert "_mihomo_error(str(e)" not in mihomo
    assert "Invalid YAML syntax" not in mihomo
    assert "error_response(msg," not in xray_configs
    assert "details=tail" not in remotefs_ops
    assert "details=tail" not in remotefs_sessions
    assert "details=tail" not in remotefs_transfer

    assert '"read_failed"' in config_exchange
    assert '"invalid_json"' in config_exchange
    assert '"apply_failed"' in config_exchange
    assert '"spawn_failed"' in devtools
    assert '"install_failed"' in geodat
    assert '"core_switch_failed"' in service
    assert '"write_failed"' in xray_configs
    assert '"preview_failed"' in mihomo
    assert '"settings_load_failed"' in ui_settings
    assert '"storage_list_failed"' in storage_usb
    assert '"template_write_failed"' in routing_templates
    assert '"restart_schedule_failed"' in routing_config


def test_frontend_prefers_server_hint_over_raw_error_code_for_sanitized_responses():
    github_js = (ROOT / "xkeen-ui" / "static" / "js" / "features" / "github.js").read_text(encoding="utf-8")
    update_js = (ROOT / "xkeen-ui" / "static" / "js" / "features" / "devtools" / "update.js").read_text(encoding="utf-8")

    assert "(data && (data.hint || data.error))" in github_js
    assert "const hint = data && data.hint ? String(data.hint) : '';" in update_js
    assert "const err = data && (data.hint || data.error) ? String(data.hint || data.error) : 'run_failed';" in update_js
    assert "const err = data && (data.hint || data.error) ? String(data.hint || data.error) : 'rollback_failed';" in update_js
    assert "backup_tar_unsupported" in update_js
    assert "{ skip_backup: true }" in update_js
