"""Enable subscription hot apply from the UI with a checked local Xray API."""

from __future__ import annotations

import json
import os
import socket
import tempfile
from pathlib import Path

from services import xray_handler_service as hot
from services import xray_transactions
from services.devtools import env
from services.io.atomic import _atomic_write_json, _atomic_write_text
from services.url_policy import env_flag
from services.xkeen import detect_xkeen_runtime_core
from services.xray_config_files import jsonc_path_for
from utils.jsonc import strip_json_comments_text

KEY = "XKEEN_SUBSCRIPTIONS_HOT_APPLY"


def _documents(configs_dir):
    documents = {}
    try:
        for path in sorted(Path(configs_dir).iterdir()):
            if not path.is_file():
                continue
            if path.suffix in {".yaml", ".yml", ".toml"}:
                raise ValueError("Для настройки HandlerService нужны конфиги Xray в JSON/JSONC.")
            if path.suffix in {".json", ".jsonc"}:
                obj = json.loads(strip_json_comments_text(path.read_text(encoding="utf-8-sig")))
                if not isinstance(obj, dict):
                    raise ValueError("Конфиг Xray должен быть JSON-объектом.")
                documents[path] = obj
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError("Не удалось прочитать конфигурацию Xray. Проверьте файлы.") from exc
    candidates = [(path, obj) for path, obj in documents.items() if "api" in obj]
    if len(candidates) > 1:
        raise ValueError("API задан в нескольких файлах Xray. Оставьте один раздел api.")
    target = Path(configs_dir) / "99_xkeen_subscription_api.json"
    path, obj = candidates[0] if candidates else (target, documents.get(target, {}))
    api = obj.get("api", {})
    if not isinstance(api, dict):
        raise ValueError("Раздел api в конфигурации Xray должен быть объектом.")
    if not isinstance(api.get("services", []), list):
        raise ValueError("api.services должен быть списком сервисов Xray.")
    if api.get("tag") and not api.get("listen"):
        # api.listen disables Commander's legacy outbound listener; changing
        # it here would disconnect clients of an existing routing-based API.
        raise ValueError("API Xray использует старую схему через маршрутизацию. Переведите его на локальный api.listen вручную, чтобы сохранить доступ другим клиентам.")
    if api.get("listen") and not hot.loopback_server(api["listen"]):
        raise ValueError("API Xray должен слушать локальный адрес, например 127.0.0.1:10085. Внешний адрес автоматически не меняется.")
    return path, obj, api


def status(configs_dir):
    result = {"enabled": env_flag(KEY, False), "ready": False, "restart_required": True}
    try:
        _path, _obj, api = _documents(configs_dir)
        server = hot.loopback_server(api.get("listen"))
        binary = xray_transactions.xray_binary()
        if binary and server and "HandlerService" in api.get("services", []):
            try:
                hot._runtime(binary, server)
                result.update(ready=True, restart_required=False)
            except Exception:
                pass
        result["message"] = (
            "Включено для всех подписок Xray." if result["ready"] and result["enabled"] else
            "Локальный API готов. Можно включить без перезапуска." if result["ready"] else
            "При включении панель настроит локальный API и один раз перезапустит Xray."
        )
    except ValueError as exc:
        result["message"] = str(exc)
    return result


def configure(configs_dir, ui_state_dir, enabled, restart_xkeen, snapshot=None):
    from services import xray_subscriptions as subs

    with hot._LOCK:
        if not enabled:
            # The API may serve other clients; switching this feature off
            # deliberately leaves their API configuration in place.
            previous = os.environ.get(KEY)
            guard = xray_transactions.MemoryGuard(paths=[env._env_file_path(ui_state_dir)])
            try:
                env.set_env(ui_state_dir, {KEY: "0"})
            except Exception:
                _restore_env(previous)
                guard.restore()
                raise ValueError("Не удалось сохранить настройку. Повторите попытку.") from None
            return {**status(configs_dir), "restarted": False, "message": "Обновление без перезапуска выключено для всех подписок."}
        if detect_xkeen_runtime_core() != "xray":
            raise ValueError("Сначала запустите Xray. Настройка не переключает работающее ядро.")
        path, obj, api = _documents(configs_dir)
        updated = json.loads(json.dumps(obj))
        updated_api = updated.setdefault("api", {})
        if not api.get("listen"):
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                updated_api["listen"] = f"127.0.0.1:{sock.getsockname()[1]}"
        if not updated_api.get("tag"):
            updated_api["tag"] = "xkeen-subscription-api"
        services = updated_api.setdefault("services", [])
        if not isinstance(services, list):
            raise ValueError("api.services должен быть списком сервисов Xray.")
        if "HandlerService" not in services:
            services.append("HandlerService")
        binary = xray_transactions.xray_binary()
        if not binary or xray_transactions.check_staged(configs_dir, {path.name: updated}).get("ok") is not True:
            raise ValueError("Xray не подтвердил конфигурацию локального API. Файлы не изменены.")
        before = status(configs_dir)
        raw_path = jsonc_path_for(str(path))
        guard = xray_transactions.MemoryGuard(paths=[str(path), raw_path, env._env_file_path(ui_state_dir)])
        previous = os.environ.get(KEY)
        restarted = False
        try:
            if updated != obj:
                if snapshot:
                    for target in (str(path), raw_path):
                        if Path(target).is_file():
                            snapshot(target)
                source = Path(raw_path).read_text(encoding="utf-8") if Path(raw_path).is_file() else path.read_text(encoding="utf-8-sig") if path.exists() else "{}"
                comments = subs._collect_jsonc_comments_by_semantic_key(source, obj, header="")
                rendered = subs._render_jsonc_with_comments(updated, comments, header="")
                _atomic_write_text(raw_path, rendered)
                if path.suffix == ".jsonc":
                    _atomic_write_text(str(path), rendered)
                else:
                    _atomic_write_json(str(path), updated)
            if updated != obj or not before["ready"]:
                applied = subs._restart_subscription_update(restart_xkeen, guard, configs_dir, "xray-handler-setup")
                if not applied["restarted"]:
                    raise ValueError(applied["error"])
                restarted = True
            files = {p.name: p.read_bytes() for p in Path(configs_dir).iterdir() if p.is_file()}
            with tempfile.TemporaryDirectory(prefix="xkeen-handler-setup-") as temp:
                expected, _default = hot._compiled(binary, files, Path(temp) / "compiled")
            if hot._runtime(binary, updated_api["listen"]) != expected:
                raise ValueError("API Xray не подтвердил конфигурацию outbound.")
            env.set_env(ui_state_dir, {KEY: "1"})
        except Exception as exc:
            _restore_env(previous)
            try:
                guard.restore()
            except Exception:
                raise ValueError("Ошибка настройки API; не удалось вернуть файлы. Проверьте конфигурацию Xray.") from exc
            if restarted:
                recovery = subs._restart_subscription_update(restart_xkeen, guard, configs_dir, "xray-handler-setup-recovery")
                if not recovery["restarted"]:
                    raise ValueError("Настройка отменена, но восстановительный запуск Xray не подтверждён. Проверьте ядро.") from exc
            if isinstance(exc, ValueError):
                raise
            raise ValueError("Не удалось проверить или сохранить настройку API. Прежняя конфигурация восстановлена.") from exc
        return {"enabled": True, "ready": True, "restart_required": False, "restarted": restarted,
                "message": "Включено для всех подписок Xray." + (" Локальный API настроен, Xray перезапущен." if restarted else " Перезапуск не потребовался.")}


def _restore_env(previous):
    if previous is None:
        os.environ.pop(KEY, None)
    else:
        os.environ[KEY] = previous
