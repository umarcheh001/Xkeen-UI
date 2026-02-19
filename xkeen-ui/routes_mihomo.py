"""Mihomo endpoints.

Extracted from legacy app.py.

Endpoints:
 - GET  /api/mihomo-config
 - POST /api/mihomo-config
 - POST /api/mihomo/preview
 - GET  /api/mihomo/profile_defaults
 - GET  /api/mihomo-config/template
 - GET  /api/mihomo-templates
 - GET  /api/mihomo-template
 - POST /api/mihomo-template
 - POST /api/mihomo/generate
 - POST /api/mihomo/download
 - POST /api/mihomo/save
 - POST /api/mihomo/restart
 - POST /api/mihomo/generate_apply
 - POST /api/mihomo/save_raw
 - POST /api/mihomo/restart_raw
 - POST /api/mihomo/validate_raw
 - GET  /api/mihomo/profiles
 - GET  /api/mihomo/profiles/<name>
 - PUT  /api/mihomo/profiles/<name>
 - DELETE /api/mihomo/profiles/<name>
 - POST /api/mihomo/profiles/<name>/activate
 - POST /api/mihomo/backups/clean
 - GET  /api/mihomo/backups
 - GET  /api/mihomo/backups/<filename>
 - DELETE /api/mihomo/backups/<filename>
 - POST /api/mihomo/backups/<filename>/restore
"""

from __future__ import annotations

import os
import re
from typing import Any, Dict

from flask import Blueprint, jsonify, request, current_app

from mihomo_server_core import (
    ensure_mihomo_layout,
    get_active_profile_name,
    save_config,
    restart_mihomo_and_get_log,
    validate_config,
)

import xkeen_mihomo_service as mihomo_svc

from services.mihomo import (
    parse_state_from_payload as _mihomo_parse_state,
    list_profiles_for_api as _mh_list_profiles_for_api,
    get_profile_content_for_api as _mh_get_profile_content_for_api,
    create_profile_from_content as _mh_create_profile_from_content,
    delete_profile_by_name as _mh_delete_profile_by_name,
    activate_profile as _mh_activate_profile,
)

from services.mihomo_backups import (
    list_backups_for_profile as _mh_list_backups_for_profile,
    get_backup_content as _mh_get_backup_content,
    restore_backup_file as _mh_restore_backup_file,
    delete_backup_file as _mh_delete_backup_file,
    clean_backups_for_api as _mh_clean_backups_for_api,
)

from services.mihomo_yaml import validate_yaml_syntax
from utils.fs import load_text, save_text


def _api_error(message: str, status: int = 400, *, ok: bool | None = None):
    payload: Dict[str, Any] = {"error": message}
    if ok is not None:
        payload["ok"] = ok
    return jsonify(payload), status


def _safe_template_path(templates_dir: str, name: str) -> str | None:
    # не даём уходить вверх по дереву и использовать подкаталоги
    if not name or "/" in name or "\\" in name or ".." in name:
        return None
    if not name.endswith(".yaml") and not name.endswith(".yml"):
        name = name + ".yaml"
    return os.path.join(templates_dir, name)


def _mihomo_get_state_from_request() -> Dict[str, Any]:
    """Obtain Mihomo state from the current HTTP request via service parser."""
    data = request.get_json(silent=True) or {}
    return _mihomo_parse_state(data)


def create_mihomo_blueprint(
    *,
    MIHOMO_CONFIG_FILE: str,
    MIHOMO_TEMPLATES_DIR: str,
    MIHOMO_DEFAULT_TEMPLATE: str,
    restart_xkeen: Any,
) -> Blueprint:
    bp = Blueprint("mihomo", __name__)

    # ---------- API: mihomo config.yaml ----------

    @bp.get("/api/mihomo-config")
    def api_get_mihomo_config():
        content = load_text(MIHOMO_CONFIG_FILE, default=None)
        if content is None:
            return _api_error(f"Файл {MIHOMO_CONFIG_FILE} не найден", 404, ok=False)
        return jsonify({"ok": True, "content": content}), 200

    @bp.post("/api/mihomo-config")
    def api_set_mihomo_config():
        data = request.get_json(silent=True) or {}
        content = data.get("content", "")

        try:
            # Сохраняем конфиг через mihomo_server_core, чтобы перед записью делался бэкап
            ensure_mihomo_layout()
            save_config(content)
        except Exception as e:
            return _api_error(str(e), 400, ok=False)

        restart_flag = bool(data.get("restart", True))
        restarted = restart_flag and restart_xkeen(source="mihomo-config")

        return jsonify({"ok": True, "restarted": restarted}), 200

    @bp.post("/api/mihomo/preview")
    def api_mihomo_preview():
        """Generate Mihomo config preview from UI state without saving or restart."""
        data = request.get_json(silent=True) or {}
        try:
            cfg, warnings = mihomo_svc.generate_preview(data)
        except Exception as exc:  # pragma: no cover - defensive
            return _api_error(f"Ошибка генерации предпросмотра: {exc}", 400, ok=False)
        return jsonify({"ok": True, "content": cfg, "warnings": warnings}), 200

    @bp.get("/api/mihomo/profile_defaults")
    def api_mihomo_profile_defaults():
        """Return profile-specific presets for the Mihomo generator UI."""
        profile = request.args.get("profile")
        try:
            data = mihomo_svc.get_profile_defaults(profile)
        except Exception as exc:  # pragma: no cover - defensive
            return _api_error(
                f"Ошибка получения пресета профиля Mihomo: {exc}", 400, ok=False
            )

        resp = {"ok": True}
        resp.update(data)
        return jsonify(resp), 200

    @bp.get("/api/mihomo-config/template")
    def api_get_mihomo_default_template():
        content = load_text(MIHOMO_DEFAULT_TEMPLATE, default=None)
        if content is None:
            return _api_error(
                f"Файл шаблона {MIHOMO_DEFAULT_TEMPLATE} не найден", 404, ok=False
            )
        return jsonify({"ok": True, "content": content}), 200

    # ---------- API: mihomo templates directory ----------

    @bp.get("/api/mihomo-templates")
    def api_list_mihomo_templates():
        if not os.path.isdir(MIHOMO_TEMPLATES_DIR):
            os.makedirs(MIHOMO_TEMPLATES_DIR, exist_ok=True)

        items = []
        for fname in sorted(os.listdir(MIHOMO_TEMPLATES_DIR)):
            if not (fname.endswith(".yaml") or fname.endswith(".yml")):
                continue
            items.append({"name": fname})

        return jsonify({"ok": True, "templates": items}), 200

    @bp.get("/api/mihomo-template")
    def api_get_mihomo_template():
        name = request.args.get("name", "").strip()
        path = _safe_template_path(MIHOMO_TEMPLATES_DIR, name)
        if not path:
            return _api_error("invalid template name", 400, ok=False)

        content = load_text(path, default=None)
        if content is None:
            return _api_error("template not found", 404, ok=False)

        return (
            jsonify({"ok": True, "content": content, "name": os.path.basename(path)}),
            200,
        )

    @bp.post("/api/mihomo-template")
    def api_save_mihomo_template():
        data = request.get_json(silent=True) or {}
        name = (data.get("name") or "").strip()
        content = data.get("content", "")

        path = _safe_template_path(MIHOMO_TEMPLATES_DIR, name)
        if not path:
            return _api_error("invalid template name", 400, ok=False)

        d = os.path.dirname(path)
        if not os.path.isdir(d):
            os.makedirs(d, exist_ok=True)

        save_text(path, content)
        return jsonify({"ok": True, "name": os.path.basename(path)}), 200

    # ---------- API: mihomo universal generator backend ----------

    @bp.post("/api/mihomo/generate")
    def api_mihomo_generate():
        try:
            state = _mihomo_get_state_from_request()
            cfg = mihomo_svc.generate_config_from_state(state)
            return current_app.response_class(cfg, mimetype="text/plain; charset=utf-8")
        except Exception as e:
            return _api_error(str(e), 400, ok=False)

    @bp.post("/api/mihomo/download")
    def api_mihomo_download():
        try:
            state = _mihomo_get_state_from_request()
            cfg = mihomo_svc.generate_config_from_state(state)
            return current_app.response_class(
                cfg,
                mimetype="application/x-yaml",
                headers={"Content-Disposition": "attachment; filename=config.yaml"},
            )
        except Exception as e:
            return _api_error(str(e), 400, ok=False)

    @bp.post("/api/mihomo/save")
    def api_mihomo_save():
        try:
            state = _mihomo_get_state_from_request()
            cfg, active_profile, warnings = mihomo_svc.generate_and_save_config(state)
            return (
                jsonify(
                    {
                        "ok": True,
                        "active_profile": active_profile,
                        "config_length": len(cfg),
                        "warnings": warnings,
                    }
                ),
                200,
            )
        except Exception as e:
            return _api_error(str(e), 400, ok=False)

    @bp.post("/api/mihomo/restart")
    def api_mihomo_restart():
        try:
            state = _mihomo_get_state_from_request()
            cfg, log, warnings = mihomo_svc.generate_save_and_restart(state)
            return (
                jsonify({"ok": True, "config_length": len(cfg), "log": log, "warnings": warnings}),
                200,
            )
        except Exception as e:
            return _api_error(str(e), 400, ok=False)

    @bp.post("/api/mihomo/generate_apply")
    def api_mihomo_generate_apply():
        """Endpoint used by mihomo_generator.html to generate+apply config."""
        data = request.get_json(silent=True) or {}
        try:
            # Если есть configOverride из редактора – предварительно проверим синтаксис YAML.
            cfg_override = (data.get("configOverride") or "")
            if cfg_override.strip():
                ok_yaml, yaml_err = validate_yaml_syntax(cfg_override)
                if not ok_yaml:
                    return _api_error(f"Invalid YAML syntax: {yaml_err}", 400, ok=False)

            cfg, log, warnings = mihomo_svc.generate_save_and_restart(data)
            return (
                jsonify(
                    {
                        "ok": True,
                        "config_length": len(cfg),
                        "log": log,
                        "warnings": warnings,
                    }
                ),
                200,
            )
        except FileNotFoundError as e:
            return _api_error(str(e), 404, ok=False)
        except ValueError as e:
            return _api_error(str(e), 400, ok=False)
        except Exception as e:
            return _api_error(str(e), 500, ok=False)

    @bp.post("/api/mihomo/save_raw")
    def api_mihomo_save_raw():
        """Save arbitrary YAML as active profile mihomo (with backup)."""
        data = request.get_json(silent=True) or {}
        cfg = (data.get("config") or "").rstrip()
        if not cfg:
            return _api_error("config is required", 400, ok=False)

        ok_yaml, yaml_err = validate_yaml_syntax(cfg)
        if not ok_yaml:
            return _api_error(f"Invalid YAML syntax: {yaml_err}", 400, ok=False)

        try:
            ensure_mihomo_layout()
            save_config(cfg)
            active = get_active_profile_name()
            return (
                jsonify({"ok": True, "active_profile": active, "config_length": len(cfg)}),
                200,
            )
        except Exception as e:
            return _api_error(str(e), 400, ok=False)

    @bp.post("/api/mihomo/restart_raw")
    def api_mihomo_restart_raw():
        """Save arbitrary YAML and restart mihomo (xkeen -restart)."""
        data = request.get_json(silent=True) or {}
        cfg = (data.get("config") or "").rstrip()
        if not cfg:
            return _api_error("config is required", 400, ok=False)

        ok_yaml, yaml_err = validate_yaml_syntax(cfg)
        if not ok_yaml:
            return _api_error(f"Invalid YAML syntax: {yaml_err}", 400, ok=False)

        try:
            ensure_mihomo_layout()
            log = restart_mihomo_and_get_log(cfg)
            return (
                jsonify({"ok": True, "config_length": len(cfg), "log": log}),
                200,
            )
        except Exception as e:
            return _api_error(str(e), 400, ok=False)

    @bp.post("/api/mihomo/validate_raw")
    def api_mihomo_validate_raw():
        """Validate YAML config with external Mihomo core (mihomo -t), without restart."""
        data = request.get_json(silent=True) or {}
        cfg = (data.get("config") or "").rstrip()

        try:
            ensure_mihomo_layout()

            # Если конфиг не прислали – читаем активный config.yaml
            if not cfg:
                try:
                    with open(MIHOMO_CONFIG_FILE, "r", encoding="utf-8") as f:
                        cfg = f.read()
                except FileNotFoundError:
                    return _api_error("active config.yaml not found", 404, ok=False)

            # Проверяем конфиг только через внешнее ядро Mihomo (mihomo -t)
            log_lines = []
            rc = 0

            try:
                mh_log = validate_config(new_content=cfg)
            except Exception as e:
                mh_log = f"Failed to run mihomo validate: {e}"

            if mh_log:
                log_lines.append(mh_log)
                m = re.search(r"\[exit code:\s*(\d+)\]", mh_log)
                if m:
                    rc = int(m.group(1))

            log = "\n".join(log_lines)
            return jsonify({"ok": rc == 0, "log": log})
        except Exception as e:
            return _api_error(str(e), 400, ok=False)

    # ---------- Profiles ----------

    @bp.get("/api/mihomo/profiles")
    def api_mihomo_profiles_list():
        """List Mihomo profiles (name + is_active) via service layer."""
        try:
            infos = _mh_list_profiles_for_api()
            return jsonify(infos)
        except Exception as e:
            return _api_error(str(e), 400, ok=False)

    @bp.get("/api/mihomo/profiles/<name>")
    def api_mihomo_profiles_get(name: str):
        """Return raw YAML content of the given Mihomo profile."""
        try:
            content = _mh_get_profile_content_for_api(name)
            return current_app.response_class(content, mimetype="text/plain; charset=utf-8")
        except FileNotFoundError:
            return _api_error("profile not found", 404, ok=False)
        except Exception as e:
            return _api_error(str(e), 400, ok=False)

    @bp.put("/api/mihomo/profiles/<name>")
    def api_mihomo_profiles_put(name: str):
        """Create a new Mihomo profile with given YAML content."""
        content = request.data.decode("utf-8", errors="ignore")
        if not content.strip():
            return _api_error("empty content", 400, ok=False)
        try:
            _mh_create_profile_from_content(name, content)
            return jsonify({"ok": True})
        except FileExistsError:
            return _api_error("profile already exists", 409, ok=False)
        except Exception as e:
            return _api_error(str(e), 400, ok=False)

    @bp.delete("/api/mihomo/profiles/<name>")
    def api_mihomo_profiles_delete(name: str):
        """Delete Mihomo profile."""
        try:
            _mh_delete_profile_by_name(name)
            return jsonify({"ok": True})
        except RuntimeError as e:
            # For example: attempt to delete active profile.
            return _api_error(str(e), 400, ok=False)
        except Exception as e:
            return _api_error(str(e), 400, ok=False)

    @bp.post("/api/mihomo/profiles/<name>/activate")
    def api_mihomo_profiles_activate(name: str):
        "Activate given Mihomo profile and restart xkeen."
        try:
            _mh_activate_profile(name)
            restarted = restart_xkeen(source="mihomo-profile-activate")
            return jsonify({"ok": True, "restarted": restarted})
        except FileNotFoundError:
            return _api_error("profile not found", 404, ok=False)
        except Exception as e:
            return _api_error(str(e), 400, ok=False)

    # ---------- Backups ----------

    @bp.post("/api/mihomo/backups/clean")
    def api_mihomo_backups_clean():
        """Remove old Mihomo config backups, keeping at most `limit` newest ones."""
        data = request.get_json(silent=True) or {}
        limit = data.get("limit", 5)
        profile = (data.get("profile") or "").strip() or None

        try:
            limit = int(limit)
        except Exception:
            return _api_error("limit must be an integer", 400, ok=False)
        if limit < 0:
            return _api_error("limit must be >= 0", 400, ok=False)

        try:
            result = _mh_clean_backups_for_api(limit, profile)
            return jsonify(result)
        except Exception as e:
            return _api_error(str(e), 400, ok=False)

    @bp.get("/api/mihomo/backups")
    def api_mihomo_backups_list():
        profile = request.args.get("profile") or None
        infos = _mh_list_backups_for_profile(profile)
        return jsonify(infos)

    @bp.get("/api/mihomo/backups/<filename>")
    def api_mihomo_backup_get(filename: str):
        try:
            content = _mh_get_backup_content(filename)
            return current_app.response_class(content, mimetype="text/plain; charset=utf-8")
        except FileNotFoundError:
            return _api_error("backup not found", 404, ok=False)

    @bp.delete("/api/mihomo/backups/<filename>")
    def api_mihomo_backup_delete(filename: str):
        try:
            _mh_delete_backup_file(filename)
            return jsonify({"ok": True})
        except Exception as e:
            return _api_error(str(e), 400, ok=False)

    @bp.post("/api/mihomo/backups/<filename>/restore")
    def api_mihomo_backup_restore(filename: str):
        try:
            _mh_restore_backup_file(filename)
            # Перезапуск после восстановления бэкапа, чтобы конфиг применился
            restarted = restart_xkeen(source="mihomo-backup-restore")
            return jsonify({"ok": True, "restarted": restarted})
        except FileNotFoundError:
            return _api_error("backup not found", 404, ok=False)
        except Exception as e:
            return _api_error(str(e), 400, ok=False)

    return bp
