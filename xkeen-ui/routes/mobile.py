"""Versioned session contract for the native mobile companion.

The browser UI keeps its existing auth routes and Flask session model.  This
module gives native clients a small, explicit envelope around that model so
they do not need to parse HTML login/setup pages or emulate browser forms.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
from typing import Any

from flask import Flask, current_app, jsonify, request, session
from werkzeug.security import check_password_hash

from services.auth_rate_limit import (
    clear_login_rate_limit,
    format_lockout_wait,
    get_login_rate_limit_status,
    register_login_failure,
)
from services.auth_setup import (
    _auth_load,
    _ensure_csrf_token,
    _is_logged_in,
    auth_is_configured,
)
from services.request_limits import (
    PayloadTooLargeError,
    get_routing_save_max_bytes,
    read_request_bytes_limited,
)
from utils.jsonc import strip_json_comments_text


MOBILE_API_PREFIX = "/api/mobile/v1"
MOBILE_XRAY_ROUTING_VALIDATE_PATH = f"{MOBILE_API_PREFIX}/xray/routing/validate"
MOBILE_XRAY_ROUTING_DOCUMENT_PATH = f"{MOBILE_API_PREFIX}/xray/routing/document"
MOBILE_XRAY_ROUTING_SAVE_PATH = f"{MOBILE_API_PREFIX}/xray/routing/save"
MOBILE_XRAY_ROUTING_APPLY_PATH = f"{MOBILE_API_PREFIX}/xray/routing/apply"
MOBILE_LOGS_PATH = f"{MOBILE_API_PREFIX}/logs"
_MOBILE_ROUTING_SERVICE_EXTENSION = "xkeen.mobile_routing_service"
_MOBILE_LOG_SOURCES = {
    "error": "xray-error",
    "access": "xray-access",
}
_MOBILE_LOG_TIME_RE = re.compile(r"\b\d{4}/\d{2}/\d{2}\s+(\d{2}:\d{2}:\d{2})\b")


def configure_mobile_routing_service(app: Flask, service: Any) -> None:
    """Attach the write service after app composition has created restart/path dependencies."""

    app.extensions[_MOBILE_ROUTING_SERVICE_EXTENSION] = service


def _mobile_routing_service() -> Any:
    service = current_app.extensions.get(_MOBILE_ROUTING_SERVICE_EXTENSION)
    if service is None:
        raise RuntimeError("mobile routing service is not configured")
    return service


def _mobile_xray_routing_validation_dependencies() -> dict[str, Any]:
    """Load the existing Xray preflight dependencies on demand.

    Mobile session routes are registered before the regular routing blueprint.
    Delaying these imports keeps that registration order intact, while making
    the mobile endpoint use exactly the same temporary-confdir preflight as
    ``POST /api/routing``.
    """

    from routes.routing.config import _run_xray_preflight
    from services.routing.templates import _paths_for_routing
    from services.xray_config_files import (
        ROUTING_FILE,
        ROUTING_FILE_RAW,
        XRAY_CONFIGS_DIR,
        XRAY_CONFIGS_DIR_REAL,
    )

    return {
        "run_preflight": _run_xray_preflight,
        "paths_for_routing": _paths_for_routing,
        "routing_file": ROUTING_FILE,
        "routing_file_raw": ROUTING_FILE_RAW,
        "xray_configs_dir": XRAY_CONFIGS_DIR,
        "xray_configs_dir_real": XRAY_CONFIGS_DIR_REAL,
    }


def _is_mobile_routing_document_name(value: str) -> bool:
    """Accept only a fragment basename supported by the mobile contract."""

    name = str(value or "").strip()
    if not name or len(name) > 255 or "\x00" in name:
        return False
    if "/" in name or "\\" in name:
        return False
    return name.lower().endswith((".json", ".jsonc"))


def _mobile_routing_diagnostic(
    *,
    code: str,
    message: str,
    path: str | None = None,
    line: int | None = None,
    column: int | None = None,
    severity: str = "error",
    hint: str | None = None,
    phase: str | None = None,
) -> dict[str, Any]:
    """Create the intentionally small, stable diagnostic shape for Android."""

    diagnostic: dict[str, Any] = {
        "source": "server",
        "severity": severity,
        "code": code,
        "message": message,
    }
    if path:
        diagnostic["path"] = path
    if line is not None and line > 0:
        diagnostic["line"] = int(line)
    if column is not None and column > 0:
        diagnostic["column"] = int(column)
    if hint:
        diagnostic["hint"] = str(hint)[:4000]
    if phase:
        diagnostic["phase"] = str(phase)
    return diagnostic


def _mobile_preflight_diagnostic_code(preflight: dict[str, Any]) -> str:
    phase = str(preflight.get("phase") or "").strip()
    error = str(preflight.get("error") or "").strip().lower()

    if phase == "routing_semantic_validate":
        return "routing_semantic_validate"
    if bool(preflight.get("timed_out")):
        return "xray_test_timeout"
    if error == "xray binary not found":
        return "xray_binary_not_found"
    if error == "xray config dir not found":
        return "xray_config_dir_not_found"
    if phase == "xray_test":
        return "xray_test_failed"
    return "xray_preflight_failed"


def _mobile_preflight_message(preflight: dict[str, Any]) -> str:
    """Prefer the user-facing preflight explanation over command output."""

    for key in ("summary", "hint"):
        value = preflight.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()[:4000]
    return "Серверная проверка конфигурации Xray не пройдена."


def _read_mobile_routing_validation_request() -> dict[str, Any]:
    """Read JSON safely both with and without the global request-size hook."""

    max_bytes = get_routing_save_max_bytes()
    cached = getattr(request, "_cached_data", None)
    if isinstance(cached, (bytes, bytearray)):
        raw = bytes(cached)
        if len(raw) > max_bytes:
            raise PayloadTooLargeError(max_bytes=max_bytes, actual=len(raw))
    else:
        raw = read_request_bytes_limited(request, max_bytes=max_bytes)

    try:
        decoded = raw.decode("utf-8")
        data = json.loads(decoded)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("invalid JSON request body") from exc

    if not isinstance(data, dict):
        raise ValueError("JSON request body must be an object")
    return data


def _mobile_xray_logs_dependencies() -> dict[str, Any]:
    """Load existing safe Xray log-tail primitives behind the mobile contract."""

    from services.xray_log_api import adjust_log_timezone, resolve_xray_log_path_for_ws
    from services.xray_logs import read_new_lines, tail_lines_fast

    return {
        "adjust_log_timezone": adjust_log_timezone,
        "read_new_lines": read_new_lines,
        "resolve_path": resolve_xray_log_path_for_ws,
        "tail_lines_fast": tail_lines_fast,
    }


def _mobile_log_cursor_encode(source: str, inode: int, offset: int, carry: bytes) -> str:
    payload = {
        "source": source,
        "inode": int(inode),
        "offset": int(offset),
        "carry": base64.urlsafe_b64encode(carry).decode("ascii").rstrip("="),
    }
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _mobile_log_cursor_decode(value: str, source: str) -> dict[str, Any] | None:
    if not value or len(value) > 4096:
        return None
    try:
        padded = value + ("=" * (-len(value) % 4))
        decoded = base64.urlsafe_b64decode(padded.encode("ascii"))
        payload = json.loads(decoded.decode("utf-8"))
        if not isinstance(payload, dict) or payload.get("source") != source:
            return None
        inode = int(payload.get("inode"))
        offset = int(payload.get("offset"))
        raw_carry = str(payload.get("carry") or "")
        padded_carry = raw_carry + ("=" * (-len(raw_carry) % 4))
        carry = base64.urlsafe_b64decode(padded_carry.encode("ascii")) if raw_carry else b""
        if inode < 0 or offset < 0 or len(carry) > 128 * 1024:
            return None
        return {"inode": inode, "offset": offset, "carry": carry}
    except (ValueError, TypeError, UnicodeDecodeError, json.JSONDecodeError):
        return None


def _mobile_log_level(line: str) -> str:
    lowered = line.lower()
    if "[error]" in lowered or " error " in lowered or "failed" in lowered:
        return "error"
    if "[warning]" in lowered or "[warn]" in lowered or " warning " in lowered:
        return "warning"
    return "info"


def _mobile_log_entries(*, source: str, inode: int, marker: int, lines: list[str]) -> list[dict[str, str]]:
    entries: list[dict[str, str]] = []
    for index, raw_line in enumerate(lines):
        message = str(raw_line or "").strip()
        if not message:
            continue
        time_match = _MOBILE_LOG_TIME_RE.search(message)
        # IDs are opaque cursor-window identities. They stay stable for a repeated snapshot and
        # make a duplicate delivery after reconnect harmless on Android.
        identity = f"{source}:{inode}:{marker}:{index}".encode("utf-8")
        entries.append(
            {
                "id": f"{source}:{hashlib.sha256(identity).hexdigest()[:20]}",
                "time": time_match.group(1) if time_match else "—",
                "source": _MOBILE_LOG_SOURCES[source],
                "level": _mobile_log_level(message),
                "message": message[:8000],
            }
        )
    return entries


def _mobile_log_stream(*, source: str, cursor: str, limit: int) -> dict[str, Any]:
    dependencies = _mobile_xray_logs_dependencies()
    path = dependencies["resolve_path"](source)
    if not path or not os.path.isfile(path):
        return {
            "source": source,
            "mode": "snapshot",
            "cursor": "",
            "available": False,
            "entries": [],
        }
    try:
        stat = os.stat(path)
        inode = int(getattr(stat, "st_ino", 0) or 0)
        size = int(getattr(stat, "st_size", 0) or 0)
    except OSError:
        return {
            "source": source,
            "mode": "snapshot",
            "cursor": "",
            "available": False,
            "entries": [],
        }

    previous = _mobile_log_cursor_decode(cursor, source)
    if previous and previous["inode"] == inode and previous["offset"] <= size:
        start_offset = previous["offset"]
        lines, next_offset, carry = dependencies["read_new_lines"](
            path,
            start_offset,
            carry=previous["carry"],
            max_bytes=128 * 1024,
        )
        adjusted = dependencies["adjust_log_timezone"](lines)
        return {
            "source": source,
            "mode": "append",
            "cursor": _mobile_log_cursor_encode(source, inode, next_offset, carry),
            "available": True,
            "entries": _mobile_log_entries(
                source=source,
                inode=inode,
                marker=start_offset,
                lines=adjusted,
            ),
        }

    lines = dependencies["tail_lines_fast"](path, max_lines=limit, max_bytes=256 * 1024)
    adjusted = dependencies["adjust_log_timezone"](lines)
    return {
        "source": source,
        "mode": "snapshot",
        "cursor": _mobile_log_cursor_encode(source, inode, size, b""),
        "available": True,
        "entries": _mobile_log_entries(source=source, inode=inode, marker=size, lines=adjusted),
    }


def register_mobile_routes(app: Flask) -> None:
    """Register the stable mobile session bootstrap/login/logout endpoints."""

    def response(data: dict, status: int = 200):
        result = jsonify({"ok": True, "data": data})
        result.status_code = status
        result.headers["Cache-Control"] = "no-store"
        return result

    def error(code: str, message: str, status: int, **details):
        result = jsonify(
            {
                "ok": False,
                "error": {
                    "code": code,
                    "message": message,
                    **details,
                },
            }
        )
        result.status_code = status
        result.headers["Cache-Control"] = "no-store"
        return result

    def rate_limit_view(remote_addr: str | None) -> dict:
        current = get_login_rate_limit_status(remote_addr)
        return {
            "enabled": bool(current.get("enabled")),
            "window_seconds": int(current.get("window_seconds") or 0),
            "max_attempts": int(current.get("max_attempts") or 0),
            "failures": int(current.get("failures") or 0),
            "attempts_left": int(current.get("attempts_left") or 0),
            "locked": bool(current.get("locked")),
            "retry_after": int(current.get("retry_after") or 0),
        }

    def invalid_credentials_message(rate: dict) -> str:
        attempts_left = int(rate.get("attempts_left") or 0)
        if attempts_left > 0:
            return f"Неверный логин или пароль. Осталось попыток: {attempts_left}."
        return "Неверный логин или пароль."

    def locked_message(rate: dict) -> str:
        return "Слишком много неудачных попыток входа. Повторите через " + format_lockout_wait(
            rate.get("retry_after") or 0
        ) + "."

    @app.get(f"{MOBILE_API_PREFIX}/bootstrap")
    def mobile_bootstrap():
        configured = auth_is_configured()
        authenticated = configured and _is_logged_in()
        return response(
            {
                "contract_version": 1,
                "auth": {
                    "configured": configured,
                    "authenticated": authenticated,
                    "user": session.get("user") if authenticated else None,
                },
            }
        )

    @app.get(MOBILE_LOGS_PATH)
    def mobile_logs():
        """Authenticated Xray history plus cursor-based live follow for the native client."""

        try:
            limit = int(request.args.get("limit", 200))
        except (TypeError, ValueError):
            limit = 200
        limit = min(500, max(50, limit))
        streams = [
            _mobile_log_stream(
                source=source,
                cursor=str(request.args.get(f"{source}-cursor") or ""),
                limit=limit,
            )
            for source in _MOBILE_LOG_SOURCES
        ]
        return response(
            {
                "contract_version": 1,
                "streams": streams,
            }
        )

    @app.post(f"{MOBILE_API_PREFIX}/session")
    def mobile_session_login():
        if not auth_is_configured():
            return error(
                "not_configured",
                "На Xkeen UI нужно завершить начальную настройку.",
                428,
            )

        data = request.get_json(silent=True) or {}
        username = str(data.get("username") or "").strip()
        password = str(data.get("password") or "")
        if not username or not password:
            return error("invalid_credentials", "Введите логин и пароль.", 400)

        rate = rate_limit_view(request.remote_addr)
        if rate["locked"]:
            retry_after = rate["retry_after"]
            result = error(
                "login_locked",
                locked_message(rate),
                429,
                rate_limit=rate,
                retry_after=retry_after,
            )
            if retry_after > 0:
                result.headers["Retry-After"] = str(retry_after)
            return result

        record = _auth_load() or {}
        authenticated = False
        try:
            authenticated = username == (record.get("username") or "") and check_password_hash(
                record.get("password_hash") or "",
                password,
            )
        except Exception:
            authenticated = False

        if not authenticated:
            rate = register_login_failure(request.remote_addr)
            if rate.get("locked"):
                retry_after = int(rate.get("retry_after") or 0)
                result = error(
                    "login_locked",
                    locked_message(rate),
                    429,
                    rate_limit=rate_limit_view(request.remote_addr),
                    retry_after=retry_after,
                )
                if retry_after > 0:
                    result.headers["Retry-After"] = str(retry_after)
                return result
            return error(
                "invalid_credentials",
                invalid_credentials_message(rate),
                401,
                rate_limit=rate_limit_view(request.remote_addr),
            )

        clear_login_rate_limit(request.remote_addr)
        session.clear()
        csrf_token = _ensure_csrf_token()
        session["auth"] = True
        session["user"] = username
        return response(
            {
                "session": {
                    "user": username,
                    "csrf_token": csrf_token,
                },
            }
        )

    @app.post(MOBILE_XRAY_ROUTING_VALIDATE_PATH)
    def mobile_xray_routing_validate():
        """Validate an unsaved Xray routing draft without changing runtime state.

        Syntax errors and Xray preflight failures are both successful transport
        responses with ``data.valid == false``.  This lets the Android editor
        render server diagnostics instead of treating an invalid draft as a
        network failure.  Authentication and CSRF are enforced by the global
        auth guard before this handler is reached.
        """

        if not request.is_json:
            return error(
                "invalid_request",
                "Ожидается JSON-запрос с полями document и content.",
                400,
            )

        try:
            data = _read_mobile_routing_validation_request()
        except PayloadTooLargeError as exc:
            return error(
                "payload_too_large",
                "Черновик routing превышает допустимый размер.",
                413,
                max_bytes=int(exc.max_bytes),
            )
        except ValueError:
            return error(
                "invalid_request",
                "Тело запроса должно быть корректным JSON-объектом.",
                400,
            )

        document = data.get("document")
        content = data.get("content")
        if not isinstance(document, str) or not _is_mobile_routing_document_name(document):
            return error(
                "invalid_document",
                "Поле document должно содержать имя Xray JSON/JSONC-фрагмента.",
                400,
            )
        if not isinstance(content, str):
            return error(
                "invalid_request",
                "Поле content должно содержать текст routing-документа.",
                400,
            )

        document = document.strip()
        try:
            dependencies = _mobile_xray_routing_validation_dependencies()
            sel_main, _sel_raw, _sel_raw_legacy = dependencies["paths_for_routing"](
                dependencies["routing_file"],
                dependencies["routing_file_raw"],
                dependencies["xray_configs_dir"],
                dependencies["xray_configs_dir_real"],
                document,
            )
        except Exception:
            # Do not silently fall back to the default fragment: this endpoint
            # must validate the document the mobile editor actually selected.
            return error(
                "invalid_document",
                "Выбранный routing-документ недоступен для проверки.",
                400,
            )

        try:
            cleaned = strip_json_comments_text(content)
            config = json.loads(cleaned)
        except json.JSONDecodeError as exc:
            message = "Сервер не смог разобрать JSON/JSONC. Исправьте синтаксис и повторите проверку."
            return response(
                {
                    "valid": False,
                    "message": message,
                    "diagnostics": [
                        _mobile_routing_diagnostic(
                            code="invalid_json",
                            message=message,
                            path=document,
                            line=exc.lineno,
                            column=exc.colno,
                        )
                    ],
                }
            )
        except Exception:
            message = "Сервер не смог разобрать JSON/JSONC. Исправьте синтаксис и повторите проверку."
            return response(
                {
                    "valid": False,
                    "message": message,
                    "diagnostics": [
                        _mobile_routing_diagnostic(
                            code="invalid_json",
                            message=message,
                            path=document,
                        )
                    ],
                }
            )

        try:
            preflight = dependencies["run_preflight"](
                xray_configs_dir_real=dependencies["xray_configs_dir_real"],
                sel_main=sel_main,
                obj=config,
                # The test process is already pointed at the managed DAT directory through
                # XRAY_LOCATION_ASSET.  Unlike save preflight, mobile validate must not mutate
                # /opt/sbin DAT symlinks as a side effect.
                sync_dat_assets=False,
            )
            if not isinstance(preflight, dict):
                raise TypeError("unexpected preflight response")
        except Exception:
            try:
                current_app.logger.exception("mobile.xray_routing_validate.preflight_failed")
            except Exception:
                pass
            message = "Не удалось выполнить серверную проверку Xray. Повторите попытку позже."
            return response(
                {
                    "valid": False,
                    "message": message,
                    "diagnostics": [
                        _mobile_routing_diagnostic(
                            code="server_validation_error",
                            message=message,
                            path=document,
                        )
                    ],
                }
            )

        if preflight.get("ok"):
            return response(
                {
                    "valid": True,
                    "message": "Серверная проверка конфигурации Xray пройдена.",
                    "diagnostics": [],
                }
            )

        message = _mobile_preflight_message(preflight)
        hint = preflight.get("hint")
        phase = preflight.get("phase")
        return response(
            {
                "valid": False,
                "message": message,
                "diagnostics": [
                    _mobile_routing_diagnostic(
                        code=_mobile_preflight_diagnostic_code(preflight),
                        message=message,
                        path=document,
                        hint=hint if isinstance(hint, str) else None,
                        phase=phase if isinstance(phase, str) else None,
                    )
                ],
            }
        )

    @app.get(MOBILE_XRAY_ROUTING_DOCUMENT_PATH)
    def mobile_xray_routing_document():
        document = str(request.args.get("document") or "").strip()
        if not _is_mobile_routing_document_name(document):
            return error(
                "invalid_document",
                "Параметр document должен содержать имя Xray JSON/JSONC-фрагмента.",
                400,
            )
        try:
            snapshot = _mobile_routing_service().get(document)
        except Exception:
            current_app.logger.exception("mobile.xray_routing_document.failed")
            return error(
                "document_load_failed",
                "Не удалось загрузить routing-документ с сервера.",
                500,
            )
        return response({"document": snapshot.to_payload()})

    def routing_write_request(*, include_content: bool) -> tuple[dict[str, Any] | None, Any | None]:
        if not request.is_json:
            return None, error("invalid_request", "Ожидается JSON-запрос.", 400)
        try:
            data = _read_mobile_routing_validation_request()
        except PayloadTooLargeError as exc:
            return None, error(
                "payload_too_large",
                "Routing-черновик превышает допустимый размер.",
                413,
                max_bytes=int(exc.max_bytes),
            )
        except ValueError:
            return None, error("invalid_request", "Тело запроса должно быть JSON-объектом.", 400)

        document = data.get("document")
        published_revision = data.get("published_revision")
        saved_revision = data.get("saved_revision")
        content = data.get("content")
        if not isinstance(document, str) or not _is_mobile_routing_document_name(document):
            return None, error("invalid_document", "Некорректное имя routing-документа.", 400)
        if not isinstance(published_revision, str) or not published_revision.strip():
            return None, error("invalid_revision", "Не передана published revision.", 400)
        if not isinstance(saved_revision, str) or not saved_revision.strip():
            return None, error("invalid_revision", "Не передана saved revision.", 400)
        if include_content and not isinstance(content, str):
            return None, error("invalid_request", "Не передан текст routing-черновика.", 400)
        return {
            "document": document.strip(),
            "content": content if isinstance(content, str) else None,
            "published_revision": published_revision.strip(),
            "saved_revision": saved_revision.strip(),
        }, None

    def routing_write_error(exc: Exception):
        from services.mobile_routing import (
            MobileRoutingConflict,
            MobileRoutingOperationFailure,
            MobileRoutingValidationFailure,
        )

        if isinstance(exc, MobileRoutingConflict):
            return error(
                exc.code,
                str(exc),
                409,
                document=exc.snapshot.to_payload(),
            )
        if isinstance(exc, MobileRoutingValidationFailure):
            return error(exc.code, str(exc), 422, details=exc.details)
        if isinstance(exc, MobileRoutingOperationFailure):
            status = 400 if exc.code in {"invalid_document", "nothing_to_apply"} else 500
            details: dict[str, Any] = {}
            if exc.snapshot is not None:
                details["document"] = exc.snapshot.to_payload()
            return error(exc.code, str(exc), status, **details)
        current_app.logger.exception("mobile.xray_routing_write.failed")
        return error(
            "routing_write_failed",
            "Не удалось выполнить routing-операцию на сервере.",
            500,
        )

    @app.post(MOBILE_XRAY_ROUTING_SAVE_PATH)
    def mobile_xray_routing_save():
        data, request_error = routing_write_request(include_content=True)
        if request_error is not None:
            return request_error
        assert data is not None
        try:
            snapshot = _mobile_routing_service().save(
                document=data["document"],
                content=data["content"],
                expected_published_revision=data["published_revision"],
                expected_saved_revision=data["saved_revision"],
            )
        except Exception as exc:
            return routing_write_error(exc)
        return response(
            {
                "saved": True,
                "message": "Routing-черновик сохранён на сервере без применения.",
                "document": snapshot.to_payload(),
            }
        )

    @app.post(MOBILE_XRAY_ROUTING_APPLY_PATH)
    def mobile_xray_routing_apply():
        data, request_error = routing_write_request(include_content=False)
        if request_error is not None:
            return request_error
        assert data is not None
        try:
            snapshot = _mobile_routing_service().apply(
                document=data["document"],
                expected_published_revision=data["published_revision"],
                expected_saved_revision=data["saved_revision"],
            )
        except Exception as exc:
            return routing_write_error(exc)
        return response(
            {
                "applied": True,
                "restarted": True,
                "message": "Routing-конфигурация применена, перезапуск xkeen подтверждён.",
                "document": snapshot.to_payload(),
            }
        )

    @app.delete(f"{MOBILE_API_PREFIX}/session")
    def mobile_session_logout():
        # Authentication and CSRF have already been enforced by _auth_guard.
        session.clear()
        return response({"session": {"closed": True}})
