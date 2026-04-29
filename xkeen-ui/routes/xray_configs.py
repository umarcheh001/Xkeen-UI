"""Xray inbounds/outbounds API routes as a Flask Blueprint.

PR14: extracted from app.py.

Routes:
- GET/POST /api/inbounds
- GET/POST /api/outbounds
- GET /api/outbounds/fragments
- GET /api/xray/inbound-tags
- GET /api/xray/outbound-tags
- POST /api/xray/observatory/preset
 - GET /api/xray/observatory/config
 - POST /api/xray/observatory/generate

All endpoints preserve historical response formats.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Callable, Dict

from flask import Blueprint, jsonify, request

from services.command_jobs import create_command_job
from services.io.atomic import _atomic_write_json, _atomic_write_text
from utils.fs import load_text

from services.xray_backups import atomic_write_bytes as _atomic_write_bytes
from services.xray_config_files import (
    INBOUNDS_FILE,
    OUTBOUNDS_FILE,
    ROUTING_FILE,
    XRAY_CONFIGS_DIR,
    ensure_xray_jsonc_dir,
    jsonc_path_for,
    legacy_jsonc_path_for,
    list_xray_fragments,
    resolve_xray_fragment_file,
)
from services.xray_inbounds import (
    MIXED_INBOUNDS,
    REDIRECT_INBOUNDS,
    TPROXY_INBOUNDS,
    detect_inbounds_mode,
    merge_inbounds_preset,
)
from services.xray_outbounds import (
    PROXY_OUTBOUND_TAG,
    build_outbounds_config_from_link,
    build_proxy_outbound_from_link,
    build_proxy_url_from_config,
)
from services.xray_subscriptions import (
    build_xray_outbounds_nodes,
    normalize_xray_outbounds_node_latency,
    probe_xray_outbounds_node_latency,
    probe_xray_outbounds_nodes_latency,
)


from routes.common.errors import error_response, exception_response


def create_xray_configs_blueprint(
    *,
    restart_xkeen: Callable[..., bool],
    load_json: Callable[..., Any],
    save_json: Callable[..., Any],
    strip_json_comments_text: Callable[[str], str],
    snapshot_xray_config_before_overwrite: Callable[[str], None],
    ui_state_dir: str = "",
) -> Blueprint:
    bp = Blueprint("xray_configs", __name__)

    # --- helpers ---

    def _xray_error(
        message: str,
        status: int,
        *,
        code: str,
        hint: str | None = None,
        **extra,
    ):
        payload_extra = {"code": code}
        if hint:
            payload_extra["hint"] = hint
        payload_extra.update(extra)
        return error_response(message, status, ok=False, **payload_extra)

    def _xray_exception(
        message: str,
        *,
        code: str,
        hint: str,
        exc: BaseException,
        status: int = 500,
        log_extra: dict[str, Any] | None = None,
    ):
        return exception_response(
            message,
            status,
            ok=False,
            code=code,
            hint=hint,
            exc=exc,
            log_tag=f"xray_configs.{code}",
            log_extra=log_extra,
        )

    def _normalize_main_json_path(p: str) -> str:
        """Normalize selected path to the main *.json fragment in XRAY_CONFIGS_DIR.

        Legacy/compatibility behavior:
          - if a caller passes a *.jsonc file path, treat it as a selection hint
            and map it to the corresponding *.json.
        """
        try:
            v = str(p or "")
        except Exception:
            v = ""
        lv = v.lower()
        if lv.endswith(".jsonc"):
            return v[:-1]  # .jsonc -> .json
        return v

    def _choose_raw_or_main(sel_path: str) -> tuple[str, str, bool]:
        """Return (chosen_path, raw_path, raw_exists).

        Stage 3 behavior:
          - raw JSONC sidecar is mapped into XRAY_JSONC_DIR via jsonc_path_for()
          - legacy raw JSONC next to main file is still read (fallback only)
          - choose raw for UI when it exists and is newer than main JSON
        """

        main_path = _normalize_main_json_path(sel_path)

        raw_path_canon = jsonc_path_for(main_path)
        raw_path_legacy = legacy_jsonc_path_for(main_path)

        raw_path = raw_path_canon
        raw_exists = False
        legacy_exists = False
        main_exists = False
        try:
            raw_exists = os.path.exists(raw_path_canon)
            legacy_exists = bool(raw_path_legacy) and os.path.exists(raw_path_legacy)
            main_exists = os.path.exists(main_path)
        except Exception:
            raw_exists = False
            legacy_exists = False
            main_exists = False

        # Fallback: if canonical sidecar doesn't exist yet, use legacy for read.
        if not raw_exists and legacy_exists:
            raw_path = raw_path_legacy
            raw_exists = True

        chosen_path = main_path

        if raw_exists:
            if main_exists:
                try:
                    st_raw = os.stat(raw_path)
                    st_main = os.stat(main_path)
                    raw_mtime_ns = getattr(st_raw, "st_mtime_ns", int(st_raw.st_mtime * 1_000_000_000))
                    main_mtime_ns = getattr(st_main, "st_mtime_ns", int(st_main.st_mtime * 1_000_000_000))
                    chosen_path = main_path if main_mtime_ns > raw_mtime_ns else raw_path
                except Exception:
                    chosen_path = raw_path
            else:
                chosen_path = raw_path

        return chosen_path, raw_path, bool(raw_exists)

    def _read_text_silent(path: str) -> str:
        try:
            return load_text(path, default="")
        except Exception:
            return ""

    def _load_outbounds_selection(file_arg: str):
        sel_path = resolve_xray_fragment_file(file_arg, kind="outbounds", default_path=OUTBOUNDS_FILE)
        sel_path = _normalize_main_json_path(sel_path)
        chosen_path, raw_path, raw_exists = _choose_raw_or_main(sel_path)
        text = _read_text_silent(chosen_path)

        cfg = None
        try:
            if text.strip():
                cleaned = strip_json_comments_text(text)
                cfg = json.loads(cleaned) if cleaned.strip() else None
            else:
                cfg = load_json(sel_path, default=None)
        except Exception:
            cfg = load_json(sel_path, default=None)

        if not text.strip():
            try:
                text = (json.dumps(cfg, ensure_ascii=False, indent=2) if cfg is not None else "{}") + "\n"
            except Exception:
                text = "{}\n"

        return {
            "path": sel_path,
            "raw_path": raw_path,
            "raw_exists": raw_exists,
            "chosen_path": chosen_path,
            "text": text,
            "config": cfg,
        }

    _ROUTING_SERVICE_OUTBOUND_TAGS = {
        "direct",
        "block",
        "dns",
        "freedom",
        "blackhole",
        "reject",
        "bypass",
        "api",
        "xray-api",
        "metrics",
        "loopback",
    }

    def _routing_proxy_outbound_tags(cfg: Any) -> list[str]:
        root = cfg if isinstance(cfg, dict) else {}
        routing = root.get("routing") if isinstance(root.get("routing"), dict) else root
        rules = routing.get("rules") if isinstance(routing, dict) else []
        tags: list[str] = []
        seen: set[str] = set()
        for rule in rules if isinstance(rules, list) else []:
            if not isinstance(rule, dict):
                continue
            tag = str(rule.get("outboundTag") or "").strip()
            if not tag:
                continue
            if tag.lower() in _ROUTING_SERVICE_OUTBOUND_TAGS:
                continue
            if tag in seen:
                continue
            seen.add(tag)
            tags.append(tag)
        return tags

    def _single_link_outbound_tags_for_current_routing() -> list[str]:
        try:
            routing_cfg = load_json(ROUTING_FILE, default=None)
        except Exception:
            routing_cfg = None
        tags = _routing_proxy_outbound_tags(routing_cfg)
        return tags or [PROXY_OUTBOUND_TAG]

    def _outbounds_node_latency_state_path() -> str:
        root = str(ui_state_dir or "").strip()
        if not root:
            return ""
        return os.path.join(root, "xray_outbounds_node_latency.json")

    def _outbounds_node_latency_fragment_key(sel_path: str) -> str:
        name = os.path.basename(str(sel_path or "")) or os.path.basename(OUTBOUNDS_FILE)
        return name or "04_outbounds.json"

    def _load_outbounds_node_latency(sel_path: str, nodes: list[dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
        state_path = _outbounds_node_latency_state_path()
        if not state_path:
            return {}
        try:
            obj = load_json(state_path, default={})
        except Exception:
            obj = {}
        if not isinstance(obj, dict):
            return {}
        fragments = obj.get("fragments") if isinstance(obj.get("fragments"), dict) else {}
        item = fragments.get(_outbounds_node_latency_fragment_key(sel_path)) if isinstance(fragments, dict) else {}
        raw = item.get("node_latency") if isinstance(item, dict) else {}
        return normalize_xray_outbounds_node_latency(raw, nodes)

    def _save_outbounds_node_latency(sel_path: str, nodes: list[dict[str, Any]], latency: Any) -> Dict[str, Dict[str, Any]]:
        clean = normalize_xray_outbounds_node_latency(latency, nodes)
        state_path = _outbounds_node_latency_state_path()
        if not state_path:
            return clean
        try:
            root = os.path.dirname(state_path)
            if root and not os.path.isdir(root):
                os.makedirs(root, exist_ok=True)
            try:
                obj = load_json(state_path, default={})
            except Exception:
                obj = {}
            if not isinstance(obj, dict):
                obj = {}
            fragments = obj.get("fragments")
            if not isinstance(fragments, dict):
                fragments = {}
            fragments[_outbounds_node_latency_fragment_key(sel_path)] = {
                "node_latency": clean,
            }
            obj["fragments"] = fragments
            _atomic_write_json(state_path, obj)
        except Exception:
            pass
        return clean

    def _is_true_flag(value: Any) -> bool:
        try:
            raw = str(value or "").strip().lower()
        except Exception:
            raw = ""
        return raw in ("1", "true", "yes", "on", "y")

    def _async_restart_requested() -> bool:
        return _is_true_flag(request.args.get("async", None))

    def _collect_fragment_tags(*, kind: str, tag_field: str, default_path: str, all_fragments: bool) -> list[str]:
        tags: list[str] = []
        seen: set[str] = set()

        def _collect_from_path(sel_path: str) -> None:
            chosen_path, _raw_path, _raw_exists = _choose_raw_or_main(sel_path)
            text = _read_text_silent(chosen_path)

            try:
                obj: Any = None
                if text.strip():
                    cleaned = strip_json_comments_text(text)
                    obj = json.loads(cleaned) if cleaned.strip() else None
                else:
                    obj = load_json(sel_path, default=None)

                items = None
                if isinstance(obj, dict):
                    items = obj.get(kind)
                elif isinstance(obj, list):
                    items = obj

                if isinstance(items, list):
                    for item in items:
                        if not isinstance(item, dict):
                            continue
                        value = item.get(tag_field)
                        if not isinstance(value, str):
                            continue
                        value = value.strip()
                        if not value or value in seen:
                            continue
                        seen.add(value)
                        tags.append(value)
            except Exception:
                return

        if all_fragments:
            try:
                for item in list_xray_fragments(kind):
                    name = str((item or {}).get("name") or "")
                    if not name:
                        continue
                    sel_path = resolve_xray_fragment_file(name, kind=kind, default_path=default_path)
                    sel_path = _normalize_main_json_path(sel_path)
                    _collect_from_path(sel_path)
            except Exception:
                return []
        else:
            file_arg = request.args.get("file", "")
            sel_path = resolve_xray_fragment_file(file_arg, kind=kind, default_path=default_path)
            sel_path = _normalize_main_json_path(sel_path)
            _collect_from_path(sel_path)

        return tags

    def _collect_loopback_inbound_tags_from_outbounds(*, default_path: str, all_fragments: bool) -> list[str]:
        tags: list[str] = []
        seen: set[str] = set()

        def _append(value: Any) -> None:
            if not isinstance(value, str):
                return
            tag = value.strip()
            if not tag or tag in seen:
                return
            seen.add(tag)
            tags.append(tag)

        def _collect_from_path(sel_path: str) -> None:
            chosen_path, _raw_path, _raw_exists = _choose_raw_or_main(sel_path)
            text = _read_text_silent(chosen_path)

            try:
                obj: Any = None
                if text.strip():
                    cleaned = strip_json_comments_text(text)
                    obj = json.loads(cleaned) if cleaned.strip() else None
                else:
                    obj = load_json(sel_path, default=None)

                items = None
                if isinstance(obj, dict):
                    items = obj.get("outbounds")
                elif isinstance(obj, list):
                    items = obj

                if not isinstance(items, list):
                    return

                for item in items:
                    if not isinstance(item, dict):
                        continue
                    protocol = str(item.get("protocol") or "").strip().lower()
                    if protocol != "loopback":
                        continue
                    settings = item.get("settings")
                    if not isinstance(settings, dict):
                        continue
                    raw = settings.get("inboundTag")
                    if isinstance(raw, list):
                        for value in raw:
                            _append(value)
                        continue
                    _append(raw)
            except Exception:
                return

        if all_fragments:
            try:
                for item in list_xray_fragments("outbounds"):
                    name = str((item or {}).get("name") or "")
                    if not name:
                        continue
                    sel_path = resolve_xray_fragment_file(name, kind="outbounds", default_path=default_path)
                    sel_path = _normalize_main_json_path(sel_path)
                    _collect_from_path(sel_path)
            except Exception:
                return []
        else:
            file_arg = request.args.get("file", "")
            sel_path = resolve_xray_fragment_file(file_arg, kind="outbounds", default_path=default_path)
            sel_path = _normalize_main_json_path(sel_path)
            _collect_from_path(sel_path)

        return tags

    def _restart_response(*, source: str, restart_flag: bool, extra: dict[str, Any] | None = None):
        payload: dict[str, Any] = {"ok": True}
        if extra:
            payload.update(extra)

        if restart_flag and _async_restart_requested():
            try:
                job = create_command_job(flag="-restart", stdin_data=None, cmd=None, use_pty=True)
                payload.update({
                    "restarted": False,
                    "restart_queued": True,
                    "restart_job_id": job.id,
                })
                return jsonify(payload), 202
            except Exception as e:
                return _xray_exception(
                    "Не удалось поставить перезапуск xkeen в очередь.",
                    code="restart_schedule_failed",
                    hint="Повторите попытку позже. Подробности смотрите в server logs.",
                    exc=e,
                )

        payload["restarted"] = restart_flag and restart_xkeen(source=source)
        return jsonify(payload), 200

    # --- API: inbounds ---

    @bp.get("/api/inbounds")
    def api_get_inbounds():
        file_arg = request.args.get("file", "")
        sel_path = resolve_xray_fragment_file(file_arg, kind="inbounds", default_path=INBOUNDS_FILE)
        sel_path = _normalize_main_json_path(sel_path)

        chosen_path, raw_path, raw_exists = _choose_raw_or_main(sel_path)
        text = _read_text_silent(chosen_path)

        obj: Any = None
        try:
            if text.strip():
                cleaned = strip_json_comments_text(text)
                obj = json.loads(cleaned) if cleaned.strip() else None
            else:
                obj = load_json(sel_path, default=None)
        except Exception:
            obj = load_json(sel_path, default=None)

        if obj is None:
            obj = {"inbounds": []}

        mode = detect_inbounds_mode(data=obj)

        if not text.strip():
            try:
                text = (json.dumps(obj, ensure_ascii=False, indent=2) if obj is not None else "{}") + "\n"
            except Exception:
                text = "{}\n"

        return (
            jsonify(
                {
                    "ok": True,
                    "mode": mode,
                    "config": obj,
                    "text": text,
                    "file": os.path.basename(sel_path),
                    "path": sel_path,
                    "raw_path": raw_path if raw_exists else None,
                    "using_raw": bool(chosen_path == raw_path and raw_exists),
                }
            ),
            200,
        )

    @bp.post("/api/inbounds")
    def api_set_inbounds():
        payload = request.get_json(silent=True) or {}
        file_arg = request.args.get("file", "")
        sel_path = resolve_xray_fragment_file(file_arg, kind="inbounds", default_path=INBOUNDS_FILE)
        sel_path = _normalize_main_json_path(sel_path)

        # Raw JSON/JSONC save mode (keeps comments in *.jsonc)
        if isinstance(payload.get("text"), str):
            raw_text = payload.get("text") or ""
            if not raw_text.strip():
                return error_response("empty text", 400, ok=False)

            cleaned = strip_json_comments_text(raw_text)
            try:
                obj = json.loads(cleaned)
            except Exception:
                return _xray_error(
                    "JSON/JSONC содержит синтаксическую ошибку.",
                    400,
                    code="invalid_json",
                    hint="Исправьте синтаксис и попробуйте снова.",
                )

            if not isinstance(obj, dict):
                return error_response("config must be object", 400, ok=False)

            raw_path = jsonc_path_for(sel_path)
            ensure_xray_jsonc_dir()

            snapshot_xray_config_before_overwrite(sel_path)
            snapshot_xray_config_before_overwrite(raw_path)

            # IMPORTANT: write clean JSON first, then raw JSONC last.
            try:
                d = os.path.dirname(sel_path)
                if d and not os.path.isdir(d):
                    os.makedirs(d, exist_ok=True)
                _atomic_write_json(sel_path, obj)
            except Exception as e:
                return _xray_exception(
                    "Не удалось сохранить основной JSON-файл.",
                    code="write_failed",
                    hint="Подробности смотрите в server logs.",
                    exc=e,
                )

            try:
                d_raw = os.path.dirname(raw_path)
                if d_raw and not os.path.isdir(d_raw):
                    os.makedirs(d_raw, exist_ok=True)
                _atomic_write_text(raw_path, raw_text)
            except Exception as e:
                return _xray_exception(
                    "Не удалось сохранить raw JSONC-файл.",
                    code="write_raw_failed",
                    hint="Подробности смотрите в server logs.",
                    exc=e,
                )

            mode = detect_inbounds_mode(data=obj)
            restart_flag = bool(payload.get("restart", True))
            return _restart_response(
                source="inbounds",
                restart_flag=restart_flag,
                extra={"file": os.path.basename(sel_path), "mode": mode},
            )

        mode = (payload.get("mode") or "").strip().lower()

        # Optional: merge behavior for preset modes.
        preserve_extras = bool(payload.get("preserve_extras", True))
        add_socks = bool(payload.get("add_socks", False))
        socks_port = payload.get("socks_port", None)

        if mode in ("mixed", "tproxy", "redirect"):
            preset = MIXED_INBOUNDS if mode == "mixed" else (TPROXY_INBOUNDS if mode == "tproxy" else REDIRECT_INBOUNDS)
            try:
                current_obj = load_json(sel_path, default=None)
            except Exception:
                current_obj = None

            try:
                data = merge_inbounds_preset(
                    current_obj,
                    preset,
                    preserve_extras=preserve_extras,
                    add_socks=add_socks,
                    socks_port=int(socks_port) if socks_port is not None and str(socks_port).strip() != "" else None,
                )
            except ValueError as e:
                msg = str(e)
                code = "invalid"
                hint = "Проверьте параметры и попробуйте снова."
                if "invalid socks_port" in msg:
                    code = "invalid_port"
                    hint = "Укажите порт 1…65535."
                elif msg.startswith("port conflict"):
                    code = "port_conflict"
                    hint = "Выберите другой порт: текущий конфликтует с другим inbound."
                return error_response(code, 400, ok=False, code=code, hint=hint)
            except Exception as e:
                return _xray_exception(
                    "Не удалось применить выбранный preset к inbounds.",
                    code="merge_failed",
                    hint="Проверьте текущую конфигурацию и попробуйте снова.",
                    exc=e,
                )
        else:
            data = payload.get("config")
            if not isinstance(data, dict):
                return error_response("config must be object", 400, ok=False)

        snapshot_xray_config_before_overwrite(sel_path)
        try:
            save_json(sel_path, data)
        except Exception as e:
            return _xray_exception(
                "Не удалось сохранить конфигурацию inbounds.",
                code="save_failed",
                hint="Подробности смотрите в server logs.",
                exc=e,
            )

        mode2 = detect_inbounds_mode(data=data)
        restart_flag = bool(payload.get("restart", True))
        return _restart_response(
            source="inbounds",
            restart_flag=restart_flag,
            extra={"file": os.path.basename(sel_path), "mode": mode2},
        )

    

    # --- API: inbounds fragments list ---

    @bp.get("/api/inbounds/fragments")
    def api_list_inbounds_fragments():
        items = list_xray_fragments("inbounds")
        current_name = os.path.basename(INBOUNDS_FILE)
        return jsonify({"ok": True, "dir": XRAY_CONFIGS_DIR, "current": current_name, "items": items}), 200

    @bp.get("/api/xray/inbound-tags")
    def api_xray_inbound_tags():
        tags = _collect_fragment_tags(
            kind="inbounds",
            tag_field="tag",
            default_path=INBOUNDS_FILE,
            all_fragments=_is_true_flag(request.args.get("all", None)),
        )
        for tag in _collect_loopback_inbound_tags_from_outbounds(
            default_path=OUTBOUNDS_FILE,
            all_fragments=_is_true_flag(request.args.get("all", None)),
        ):
            if tag not in tags:
                tags.append(tag)
        return jsonify({"ok": True, "tags": tags}), 200

# --- API: outbounds ---

    @bp.get("/api/outbounds")
    def api_get_outbounds():
        file_arg = request.args.get("file", "")
        sel_path = resolve_xray_fragment_file(file_arg, kind="outbounds", default_path=OUTBOUNDS_FILE)
        sel_path = _normalize_main_json_path(sel_path)

        chosen_path, raw_path, raw_exists = _choose_raw_or_main(sel_path)
        text = _read_text_silent(chosen_path)

        cfg = None
        try:
            if text.strip():
                cleaned = strip_json_comments_text(text)
                cfg = json.loads(cleaned) if cleaned.strip() else None
            else:
                cfg = load_json(sel_path, default=None)
        except Exception:
            cfg = load_json(sel_path, default=None)

        url = None
        if cfg:
            try:
                url = build_proxy_url_from_config(cfg)
            except Exception:
                url = None

        if not text.strip():
            try:
                text = (json.dumps(cfg, ensure_ascii=False, indent=2) if cfg is not None else "{}") + "\n"
            except Exception:
                text = "{}\n"

        return (
            jsonify(
                {
                    "ok": True,
                    "url": url,
                    "config": cfg,
                    "text": text,
                    "file": os.path.basename(sel_path),
                    "path": sel_path,
                    "raw_path": raw_path if raw_exists else None,
                    "using_raw": bool(chosen_path == raw_path and raw_exists),
                }
            ),
            200,
        )

    @bp.post("/api/outbounds")
    def api_set_outbounds():
        payload = request.get_json(silent=True) or {}
        file_arg = request.args.get("file", "")
        sel_path = resolve_xray_fragment_file(file_arg, kind="outbounds", default_path=OUTBOUNDS_FILE)
        sel_path = _normalize_main_json_path(sel_path)

        # Raw JSON/JSONC save mode (keeps comments in *.jsonc)
        if isinstance(payload.get("text"), str):
            raw_text = payload.get("text") or ""
            if not raw_text.strip():
                return error_response("empty text", 400, ok=False)

            cleaned = strip_json_comments_text(raw_text)
            try:
                obj = json.loads(cleaned)
            except Exception:
                return _xray_error(
                    "JSON/JSONC содержит синтаксическую ошибку.",
                    400,
                    code="invalid_json",
                    hint="Исправьте синтаксис и попробуйте снова.",
                )

            if not isinstance(obj, dict):
                return error_response("config must be object", 400, ok=False)

            raw_path = jsonc_path_for(sel_path)
            ensure_xray_jsonc_dir()

            snapshot_xray_config_before_overwrite(sel_path)
            snapshot_xray_config_before_overwrite(raw_path)

            # IMPORTANT: write clean JSON first, then raw JSONC last.
            try:
                d = os.path.dirname(sel_path)
                if d and not os.path.isdir(d):
                    os.makedirs(d, exist_ok=True)
                _atomic_write_json(sel_path, obj)
            except Exception as e:
                return _xray_exception(
                    "Не удалось сохранить основной JSON-файл.",
                    code="write_failed",
                    hint="Подробности смотрите в server logs.",
                    exc=e,
                )

            try:
                d_raw = os.path.dirname(raw_path)
                if d_raw and not os.path.isdir(d_raw):
                    os.makedirs(d_raw, exist_ok=True)
                _atomic_write_text(raw_path, raw_text)
            except Exception as e:
                return _xray_exception(
                    "Не удалось сохранить raw JSONC-файл.",
                    code="write_raw_failed",
                    hint="Подробности смотрите в server logs.",
                    exc=e,
                )

            restart_flag = bool(payload.get("restart", True))
            return _restart_response(
                source="outbounds",
                restart_flag=restart_flag,
                extra={"file": os.path.basename(sel_path)},
            )

        # New: direct config save
        if "config" in payload:
            cfg = payload.get("config")
            if not isinstance(cfg, dict):
                return error_response("config must be object", 400, ok=False)
        else:
            # Old: build config from URL
            url = (payload.get("url") or "").strip()
            if not url:
                return error_response("url is required", 400, ok=False)
            try:
                cfg = build_outbounds_config_from_link(
                    url,
                    proxy_tags=_single_link_outbound_tags_for_current_routing(),
                )
            except Exception:
                return _xray_error(
                    "Ссылка прокси имеет некорректный или неподдерживаемый формат.",
                    400,
                    code="invalid_link",
                    hint="Проверьте формат ссылки и попробуйте снова.",
                )

        snapshot_xray_config_before_overwrite(sel_path)
        try:
            save_json(sel_path, cfg)
        except Exception as e:
            return _xray_exception(
                "Не удалось сохранить конфигурацию outbounds.",
                code="save_failed",
                hint="Подробности смотрите в server logs.",
                exc=e,
            )

        restart_flag = bool(payload.get("restart", True))
        return _restart_response(
            source="outbounds",
            restart_flag=restart_flag,
            extra={"file": os.path.basename(sel_path)},
        )

    # --- API: outbounds fragments list ---

    @bp.get("/api/outbounds/fragments")
    def api_list_outbounds_fragments():
        items = list_xray_fragments("outbounds")
        current_name = os.path.basename(OUTBOUNDS_FILE)
        return jsonify({"ok": True, "dir": XRAY_CONFIGS_DIR, "current": current_name, "items": items}), 200

    # --- API: Xray outbound tags (for selector UI) ---

    @bp.get("/api/xray/outbound-tags")
    def api_xray_outbound_tags():
        tags = _collect_fragment_tags(
            kind="outbounds",
            tag_field="tag",
            default_path=OUTBOUNDS_FILE,
            all_fragments=_is_true_flag(request.args.get("all", None)),
        )
        return jsonify({"ok": True, "tags": tags}), 200

    # --- API: current outbounds nodes + latency probes ---

    @bp.get("/api/xray/outbounds/nodes")
    def api_xray_outbounds_nodes():
        file_arg = request.args.get("file", "")
        selection = _load_outbounds_selection(file_arg)
        nodes = build_xray_outbounds_nodes(selection.get("config"))
        latency = _load_outbounds_node_latency(str(selection.get("path") or ""), nodes)
        return (
            jsonify(
                {
                    "ok": True,
                    "file": os.path.basename(str(selection.get("path") or "")),
                    "path": selection.get("path"),
                    "nodes": nodes,
                    "node_latency": latency,
                }
            ),
            200,
        )

    def _outbounds_node_timeout(payload: dict[str, Any]) -> float:
        timeout_raw = payload.get("timeout_s", payload.get("timeoutSec", payload.get("timeout")))
        try:
            return float(timeout_raw) if timeout_raw is not None and str(timeout_raw).strip() != "" else 8.0
        except Exception:
            return 8.0

    @bp.post("/api/xray/outbounds/nodes/ping")
    def api_probe_xray_outbounds_node():
        payload = request.get_json(silent=True) or {}
        node_key = str(
            payload.get("node_key")
            or payload.get("nodeKey")
            or payload.get("key")
            or ""
        ).strip()
        file_arg = request.args.get("file", "")
        selection = _load_outbounds_selection(file_arg)
        nodes = build_xray_outbounds_nodes(selection.get("config"))
        existing_latency = _load_outbounds_node_latency(str(selection.get("path") or ""), nodes)
        try:
            result = probe_xray_outbounds_node_latency(
                selection.get("config"),
                node_key,
                xray_configs_dir=os.path.dirname(str(selection.get("path") or "")) or XRAY_CONFIGS_DIR,
                existing_latency=existing_latency,
                timeout_s=_outbounds_node_timeout(payload),
            )
        except KeyError:
            return error_response("node not found", 404, ok=False)
        except ValueError as exc:
            return error_response(str(exc), 400, ok=False)
        except Exception as exc:
            return exception_response(
                "Не удалось проверить задержку proxy-узла.",
                500,
                ok=False,
                code="outbounds_node_ping_failed",
                hint="Подробности смотрите в server logs.",
                exc=exc,
                log_tag="xray_configs.outbounds_node_ping_failed",
            )

        if result.get("entry"):
            existing_latency[str(result.get("node_key") or node_key)] = result.get("entry")
            _save_outbounds_node_latency(str(selection.get("path") or ""), nodes, existing_latency)
        status = 200 if result.get("ok") else 400
        return jsonify(result), status

    @bp.post("/api/xray/outbounds/nodes/ping-bulk")
    def api_probe_xray_outbounds_nodes():
        payload = request.get_json(silent=True) or {}
        node_keys = payload.get("node_keys", payload.get("nodeKeys", payload.get("keys")))
        file_arg = request.args.get("file", "")
        selection = _load_outbounds_selection(file_arg)
        nodes = build_xray_outbounds_nodes(selection.get("config"))
        existing_latency = _load_outbounds_node_latency(str(selection.get("path") or ""), nodes)
        try:
            result = probe_xray_outbounds_nodes_latency(
                selection.get("config"),
                node_keys,
                xray_configs_dir=os.path.dirname(str(selection.get("path") or "")) or XRAY_CONFIGS_DIR,
                existing_latency=existing_latency,
                timeout_s=_outbounds_node_timeout(payload),
            )
        except KeyError:
            return error_response("node not found", 404, ok=False)
        except ValueError as exc:
            return error_response(str(exc), 400, ok=False)
        except Exception as exc:
            return exception_response(
                "Не удалось проверить задержку proxy-узлов.",
                500,
                ok=False,
                code="outbounds_nodes_ping_failed",
                hint="Подробности смотрите в server logs.",
                exc=exc,
                log_tag="xray_configs.outbounds_nodes_ping_failed",
            )

        saved_latency = _save_outbounds_node_latency(
            str(selection.get("path") or ""),
            nodes,
            result.get("node_latency"),
        )
        result["node_latency"] = saved_latency
        return jsonify(result), 200

    # --- API: batch add/update proxy outbounds (for balancer pools) ---

    @bp.post("/api/xray/outbounds/proxies")
    def api_xray_outbounds_proxies():
        """Upsert multiple proxy outbounds into 04_outbounds.json.

        Payload:
          {
            "entries": [ {"tag": "p1", "url": "vless://..."}, ... ],
            "restart": true,
            "replace_pool": false,
            "write_raw": true
          }
        """
        payload = request.get_json(silent=True) or {}

        entries = payload.get("entries")
        if entries is None:
            entries = payload.get("proxies")
        if not isinstance(entries, list) or not entries:
            return error_response("entries must be a non-empty list", 400, ok=False)

        file_arg = request.args.get("file", "")
        sel_path = resolve_xray_fragment_file(file_arg, kind="outbounds", default_path=OUTBOUNDS_FILE)
        sel_path = _normalize_main_json_path(sel_path)

        chosen_path, raw_path, raw_exists = _choose_raw_or_main(sel_path)
        text = _read_text_silent(chosen_path)

        # Parse existing config (support json/jsonc)
        base_obj: Any = None
        try:
            if text.strip():
                cleaned = strip_json_comments_text(text)
                base_obj = json.loads(cleaned) if cleaned.strip() else None
            else:
                base_obj = load_json(sel_path, default=None)
        except Exception:
            base_obj = load_json(sel_path, default=None)

        base_is_list = isinstance(base_obj, list)
        if base_is_list:
            outbounds = base_obj
        else:
            if not isinstance(base_obj, dict):
                base_obj = {}
            outbounds = base_obj.get("outbounds") if isinstance(base_obj, dict) else None

        if not isinstance(outbounds, list):
            outbounds = []

        # Validate + build proxy outbounds
        RESERVED = {
            "direct",
            "block",
            "dns",
            "freedom",
            "blackhole",
            "reject",
            "bypass",
            "api",
            "xray-api",
            "metrics",
        }

        def _clean_tag(t: Any) -> str:
            return str(t or "").strip()

        def _is_reserved(tag: str) -> bool:
            if not tag:
                return True
            return tag.strip().lower() in RESERVED

        # Xray tags can be quite permissive, but we still reject whitespace-only / too long.
        tag_re = re.compile(r"^.{1,64}$")

        built: list[dict] = []
        errors: list[dict] = []
        seen_tags: set[str] = set()
        for i, ent in enumerate(entries):
            if not isinstance(ent, dict):
                errors.append({"idx": i, "error": "entry must be object"})
                continue
            tag = _clean_tag(ent.get("tag"))
            url = str(ent.get("url") or "").strip()
            if not tag:
                errors.append({"idx": i, "error": "tag is required"})
                continue
            if not tag_re.match(tag):
                errors.append({"idx": i, "tag": tag, "error": "tag слишком длинный (макс 64 символа)"})
                continue
            if _is_reserved(tag):
                errors.append({"idx": i, "tag": tag, "error": "tag зарезервирован"})
                continue
            if not url:
                errors.append({"idx": i, "tag": tag, "error": "url is required"})
                continue
            # allow duplicates in payload: keep last occurrence
            if tag in seen_tags:
                # remove previous built
                built = [b for b in built if str(b.get("tag")) != tag]
            seen_tags.add(tag)
            try:
                ob = build_proxy_outbound_from_link(url, tag)
                built.append(ob)
            except ValueError:
                errors.append({"idx": i, "tag": tag, "error": "Некорректная ссылка прокси"})
            except Exception:
                errors.append({"idx": i, "tag": tag, "error": "Не удалось разобрать ссылку прокси"})

        if errors:
            return jsonify({"ok": False, "error": "invalid entries", "errors": errors}), 400

        replace_pool = bool(payload.get("replace_pool", False))

        new_tags = {str(o.get("tag") or "").strip() for o in built}
        new_tags = {t for t in new_tags if t}

        # Split tail (direct/block) to keep them at the end.
        head: list[Any] = []
        tail: list[Any] = []
        for ob in outbounds:
            if not isinstance(ob, dict):
                head.append(ob)
                continue
            t = str(ob.get("tag") or "").strip()
            tl = t.lower()
            if tl in ("direct", "block"):
                tail.append(ob)
                continue
            if replace_pool:
                # keep only reserved/service tags when replacing pool
                if tl in RESERVED:
                    head.append(ob)
                continue
            # upsert mode: remove tags that are being updated
            if t in new_tags:
                continue
            head.append(ob)

        # Append new proxies before tail
        merged: list[Any] = head + built

        def _pick_first(tag_name: str, default_obj: dict) -> dict:
            for ob in tail:
                if isinstance(ob, dict) and str(ob.get("tag") or "").strip().lower() == tag_name:
                    return ob
            return default_obj

        direct_obj = _pick_first("direct", {"tag": "direct", "protocol": "freedom"})
        block_obj = _pick_first(
            "block",
            {
                "tag": "block",
                "protocol": "blackhole",
                "settings": {"response": {"type": "http"}},
            },
        )

        # Ensure there is only one direct/block
        merged = [
            ob
            for ob in merged
            if not (
                isinstance(ob, dict)
                and str(ob.get("tag") or "").strip().lower() in ("direct", "block")
            )
        ]
        merged.append(direct_obj)
        merged.append(block_obj)

        if base_is_list:
            final_obj: Any = merged
        else:
            final_obj = dict(base_obj) if isinstance(base_obj, dict) else {}
            final_obj["outbounds"] = merged

        # Save
        write_raw = bool(payload.get("write_raw", True))

        # If raw exists, always keep it in sync (even if write_raw=false in payload).
        if raw_exists:
            write_raw = True

        ensure_xray_jsonc_dir()

        snapshot_xray_config_before_overwrite(sel_path)
        if write_raw:
            snapshot_xray_config_before_overwrite(raw_path)

        try:
            d = os.path.dirname(sel_path)
            if d and not os.path.isdir(d):
                os.makedirs(d, exist_ok=True)
            _atomic_write_json(sel_path, final_obj)
        except Exception as e:
            return _xray_exception(
                "Не удалось сохранить основной JSON-файл.",
                code="write_failed",
                hint="Подробности смотрите в server logs.",
                exc=e,
            )

        if write_raw:
            try:
                raw_text = "// Generated by XKeen UI (outbounds pool)\n" + json.dumps(
                    final_obj, ensure_ascii=False, indent=2
                ) + "\n"
                _atomic_write_text(raw_path, raw_text)
            except Exception as e:
                return _xray_exception(
                    "Не удалось сохранить raw JSONC-файл.",
                    code="write_raw_failed",
                    hint="Подробности смотрите в server logs.",
                    exc=e,
                )

        tags_out: list[str] = []
        seen_out: set[str] = set()
        try:
            lst = merged if isinstance(merged, list) else []
            for o in lst:
                if not isinstance(o, dict):
                    continue
                t = o.get("tag")
                if not isinstance(t, str):
                    continue
                t = t.strip()
                if not t or t in seen_out:
                    continue
                seen_out.add(t)
                tags_out.append(t)
        except Exception:
            tags_out = []

        restart_flag = bool(payload.get("restart", True))
        return _restart_response(
            source="outbounds",
            restart_flag=restart_flag,
            extra={
                "updated": len(built),
                "file": os.path.basename(sel_path),
                "replaced_pool": bool(replace_pool),
                "tags": tags_out,
            },
        )

    # --- API: Xray observatory preset (for balancer leastPing) ---

    @bp.post("/api/xray/observatory/preset")
    def api_xray_observatory_preset():
        """Create 07_observatory.json (+ .jsonc) from the bundled template."""
        payload = request.get_json(silent=True) or {}
        restart_flag = bool(payload.get("restart", False))

        dst_json = os.path.join(XRAY_CONFIGS_DIR, "07_observatory.json")
        dst_jsonc = jsonc_path_for(dst_json)
        legacy_dst_jsonc = legacy_jsonc_path_for(dst_json)
        ensure_xray_jsonc_dir()

        existed_json = False
        existed_jsonc = False
        existed_legacy_jsonc = False
        try:
            existed_json = os.path.exists(dst_json)
            existed_jsonc = os.path.exists(dst_jsonc)
            existed_legacy_jsonc = bool(legacy_dst_jsonc) and os.path.exists(legacy_dst_jsonc)
        except Exception:
            existed_json = False
            existed_jsonc = False
            existed_legacy_jsonc = False

        # If JSON already exists — don't overwrite.
        if existed_json:
            wrote: list[str] = []
            if not existed_jsonc:
                try:
                    tpl_text = ""
                    tpl_default = os.path.join(
                        (os.environ.get("XKEEN_UI_STATE_DIR") or os.environ.get("XKEEN_UI_DIR") or "/opt/etc/xkeen-ui"),
                        "templates", "observatory", "07_observatory_base.jsonc",
                    )
                    tpl_path = os.environ.get("XKEEN_XRAY_OBSERVATORY_TEMPLATE", tpl_default)
                    if tpl_path and os.path.exists(tpl_path):
                        with open(tpl_path, "r", encoding="utf-8") as f:
                            tpl_text = f.read()
                    if not tpl_text:
                        base_dir = os.path.dirname(os.path.abspath(__file__))
                        bundled = os.path.join(
                            base_dir,
                            "opt",
                            "etc",
                            "xray",
                            "templates",
                            "observatory",
                            "07_observatory_base.jsonc",
                        )
                        if os.path.exists(bundled):
                            with open(bundled, "r", encoding="utf-8") as f:
                                tpl_text = f.read()
                    if tpl_text:
                        _atomic_write_bytes(dst_jsonc, (tpl_text.rstrip("\n") + "\n").encode("utf-8"), mode=0o644)
                        wrote.append(os.path.basename(dst_jsonc))
                except Exception:
                    pass

            restarted = restart_flag and restart_xkeen(source="observatory-preset")
            return jsonify({"ok": True, "existed": True, "files": wrote, "restarted": restarted}), 200

        # Load template text (prefer /opt/etc, fallback to bundled UI archive).
        tpl_text = ""
        tpl_default = os.path.join(
            (os.environ.get("XKEEN_UI_STATE_DIR") or os.environ.get("XKEEN_UI_DIR") or "/opt/etc/xkeen-ui"),
            "templates", "observatory", "07_observatory_base.jsonc",
        )
        tpl_path = os.environ.get("XKEEN_XRAY_OBSERVATORY_TEMPLATE", tpl_default)
        try:
            if tpl_path and os.path.exists(tpl_path):
                with open(tpl_path, "r", encoding="utf-8") as f:
                    tpl_text = f.read()
        except Exception:
            tpl_text = ""

        if not tpl_text:
            try:
                base_dir = os.path.dirname(os.path.abspath(__file__))
                bundled = os.path.join(
                    base_dir,
                    "opt",
                    "etc",
                    "xray",
                    "templates",
                    "observatory",
                    "07_observatory_base.jsonc",
                )
                if os.path.exists(bundled):
                    with open(bundled, "r", encoding="utf-8") as f:
                        tpl_text = f.read()
            except Exception:
                tpl_text = ""

        # Final fallback: minimal config in code.
        if not tpl_text:
            tpl_text = (
                '{\n'
                '  "observatory": {\n'
                '    "subjectSelector": ["proxy"],\n'
                '    "probeUrl": "https://www.google.com/generate_204",\n'
                '    "probeInterval": "60s",\n'
                '    "enableConcurrency": true\n'
                '  }\n'
                '}\n'
            )

        # Parse JSON from JSONC template.
        cfg_obj: dict[str, Any] = {}
        try:
            cleaned = strip_json_comments_text(tpl_text)
            parsed = json.loads(cleaned) if cleaned.strip() else {}
            if isinstance(parsed, dict):
                cfg_obj = parsed
        except Exception:
            cfg_obj = {}

        if not isinstance(cfg_obj, dict) or not cfg_obj:
            cfg_obj = {
                "observatory": {
                    "subjectSelector": ["proxy"],
                    "probeUrl": "https://www.google.com/generate_204",
                    "probeInterval": "60s",
                    "enableConcurrency": True,
                }
            }

        files_written: list[str] = []

        # Write JSON (for Xray)
        try:
            pretty = json.dumps(cfg_obj, ensure_ascii=False, indent=2) + "\n"
            _atomic_write_bytes(dst_json, pretty.encode("utf-8"), mode=0o644)
            files_written.append(os.path.basename(dst_json))
        except Exception:
            return error_response("failed to write observatory json", 500, ok=False)

        # Write JSONC (for UI), but don't overwrite if already exists.
        try:
            if not existed_jsonc:
                _atomic_write_bytes(dst_jsonc, (tpl_text.rstrip("\n") + "\n").encode("utf-8"), mode=0o644)
                files_written.append(os.path.basename(dst_jsonc))
        except Exception:
            pass

        restarted = restart_flag and restart_xkeen(source="observatory-preset")
        return jsonify({"ok": True, "existed": False, "files": files_written, "restarted": restarted}), 200


    # --- API: Xray observatory config (read) ---

    @bp.get("/api/xray/observatory/config")
    def api_xray_observatory_config():
        """Return parsed observatory settings for 07_observatory.json (if present)."""
        dst_json = os.path.join(XRAY_CONFIGS_DIR, "07_observatory.json")
        dst_jsonc = jsonc_path_for(dst_json)
        legacy_dst_jsonc = legacy_jsonc_path_for(dst_json)

        exists = False
        cfg_obj: Dict[str, Any] = {}
        try:
            exists = os.path.exists(dst_json)
        except Exception:
            exists = False

        if exists:
            try:
                with open(dst_json, "r", encoding="utf-8") as f:
                    txt = f.read()
                parsed = json.loads(txt) if txt.strip() else {}
                if isinstance(parsed, dict):
                    cfg_obj = parsed
            except Exception:
                cfg_obj = {}

        obs: Dict[str, Any] = {}
        try:
            v = cfg_obj.get("observatory") if isinstance(cfg_obj, dict) else None
            if isinstance(v, dict):
                obs = v
        except Exception:
            obs = {}

        def _str(v, default=""):
            try:
                s = str(v)
                return s
            except Exception:
                return default

        def _bool(v, default=True):
            try:
                if isinstance(v, bool):
                    return v
            except Exception:
                pass
            return default

        def _list(v):
            out: list[str] = []
            if isinstance(v, list):
                for x in v:
                    if isinstance(x, str) and x.strip():
                        out.append(x.strip())
            return out

        config = {
            "subjectSelector": _list(obs.get("subjectSelector")),
            "probeUrl": _str(obs.get("probeUrl"), ""),
            "probeInterval": _str(obs.get("probeInterval"), ""),
            "enableConcurrency": _bool(obs.get("enableConcurrency"), True),
        }

        # Also report where JSONC sidecar lives (for UI hints/debug), without exposing realpaths.
        jsonc_exists = False
        legacy_jsonc_exists = False
        try:
            jsonc_exists = os.path.exists(dst_jsonc)
            legacy_jsonc_exists = bool(legacy_dst_jsonc) and os.path.exists(legacy_dst_jsonc)
        except Exception:
            jsonc_exists = False
            legacy_jsonc_exists = False

        return (
            jsonify(
                {
                    "ok": True,
                    "exists": bool(exists),
                    "dir": XRAY_CONFIGS_DIR,
                    "file": "07_observatory.json",
                    "jsonc": os.path.basename(dst_jsonc),
                    "jsonc_exists": bool(jsonc_exists),
                    "legacy_jsonc_exists": bool(legacy_jsonc_exists),
                    "config": config,
                }
            ),
            200,
        )


    # --- API: Xray observatory config (generate/update) ---

    @bp.post("/api/xray/observatory/generate")
    def api_xray_observatory_generate():
        """Generate/update 07_observatory.json (+ JSONC sidecar) from UI parameters.

        Payload:
          - subjectSelector: list[str] (required)
          - probeUrl: str (optional)
          - probeInterval: str (optional)
          - enableConcurrency: bool (optional)
          - overwrite: bool (default true)
        """
        payload = request.get_json(silent=True) or {}

        overwrite = True
        try:
            if "overwrite" in payload:
                overwrite = bool(payload.get("overwrite"))
        except Exception:
            overwrite = True

        def _norm_list(v):
            if isinstance(v, str):
                # Allow comma/newline separated
                raw = v.replace(',', '\n')
                v = raw.splitlines()
            out: list[str] = []
            seen: set[str] = set()
            if isinstance(v, list):
                for x in v:
                    if not isinstance(x, str):
                        continue
                    s = x.strip()
                    if not s:
                        continue
                    if s in seen:
                        continue
                    seen.add(s)
                    out.append(s)
            return out

        subject = _norm_list(payload.get("subjectSelector") or payload.get("selector") or payload.get("tags"))
        if not subject:
            return error_response("subjectSelector_required", 400, ok=False)

        probe_url = payload.get("probeUrl")
        probe_interval = payload.get("probeInterval")
        enable_conc = payload.get("enableConcurrency")

        dst_json = os.path.join(XRAY_CONFIGS_DIR, "07_observatory.json")
        dst_jsonc = jsonc_path_for(dst_json)
        legacy_dst_jsonc = legacy_jsonc_path_for(dst_json)

        ensure_xray_jsonc_dir()

        existed = False
        try:
            existed = os.path.exists(dst_json)
        except Exception:
            existed = False

        if existed and not overwrite:
            # No-op: return current config
            return jsonify({"ok": True, "existed": True, "overwritten": False, "file": "07_observatory.json"}), 200

        # Load existing JSON as base (preserve unknown keys), otherwise start minimal.
        cfg_obj: Dict[str, Any] = {}
        if existed:
            try:
                with open(dst_json, "r", encoding="utf-8") as f:
                    txt = f.read()
                parsed = json.loads(txt) if txt.strip() else {}
                if isinstance(parsed, dict):
                    cfg_obj = parsed
            except Exception:
                cfg_obj = {}

        if not isinstance(cfg_obj, dict) or not cfg_obj:
            cfg_obj = {}

        obs = cfg_obj.get("observatory")
        if not isinstance(obs, dict):
            obs = {}

        # Apply fields
        obs["subjectSelector"] = subject
        if isinstance(probe_url, str) and probe_url.strip():
            obs["probeUrl"] = probe_url.strip()
        elif "probeUrl" not in obs:
            obs["probeUrl"] = "https://www.gstatic.com/generate_204"

        if isinstance(probe_interval, str) and probe_interval.strip():
            obs["probeInterval"] = probe_interval.strip()
        elif "probeInterval" not in obs:
            obs["probeInterval"] = "60s"

        if isinstance(enable_conc, bool):
            obs["enableConcurrency"] = enable_conc
        elif "enableConcurrency" not in obs:
            obs["enableConcurrency"] = True

        cfg_obj["observatory"] = obs

        # Write JSON for Xray
        try:
            pretty = json.dumps(cfg_obj, ensure_ascii=False, indent=2) + "\n"
            _atomic_write_bytes(dst_json, pretty.encode("utf-8"), mode=0o644)
        except Exception:
            return error_response("failed_to_write_observatory_json", 500, ok=False)

        # Write JSONC sidecar for UI (always rewrite to keep it in sync)
        jsonc_text = (
            "// Автосгенерировано панелью XKeen UI (leastPing)\n"
            "// Этот файл хранится в UI‑каталоге JSONC (не в /opt/etc/xray/configs), чтобы Xray не подхватывал *.jsonc.\n"
            + (json.dumps(cfg_obj, ensure_ascii=False, indent=2) + "\n")
        )
        try:
            _atomic_write_bytes(dst_jsonc, jsonc_text.encode("utf-8"), mode=0o644)
        except Exception:
            # JSONC is optional; never fail the whole flow.
            pass

        # Remove legacy JSONC inside configs dir so Xray won't parse it.
        try:
            if legacy_dst_jsonc and (legacy_dst_jsonc != dst_jsonc) and os.path.exists(legacy_dst_jsonc):
                os.remove(legacy_dst_jsonc)
        except Exception:
            pass

        return (
            jsonify(
                {
                    "ok": True,
                    "existed": bool(existed),
                    "overwritten": True,
                    "file": "07_observatory.json",
                    "jsonc": os.path.basename(dst_jsonc),
                    "config": {
                        "subjectSelector": subject,
                        "probeUrl": obs.get("probeUrl"),
                        "probeInterval": obs.get("probeInterval"),
                        "enableConcurrency": obs.get("enableConcurrency"),
                    },
                }
            ),
            200,
        )

    return bp
