from __future__ import annotations

import importlib
import importlib.util
import io
import json
import sys
import tempfile
import types
from pathlib import Path
from types import SimpleNamespace

from flask import Blueprint, Flask


ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "xkeen-ui"
ROUTES_DIR = APP_DIR / "routes"
ROUTING_DIR = ROUTES_DIR / "routing"

if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))


def _reload(name: str):
    module = sys.modules.get(name)
    if module is not None:
        return importlib.reload(module)
    return importlib.import_module(name)


def _load_routing_module(module_basename: str):
    module_name = f"routes.routing.{module_basename}"
    module_path = ROUTING_DIR / f"{module_basename}.py"

    prev_routes = sys.modules.get("routes")
    prev_routing = sys.modules.get("routes.routing")
    prev_module = sys.modules.get(module_name)
    prev_path = list(sys.path)

    try:
        if str(APP_DIR) not in sys.path:
            sys.path.insert(0, str(APP_DIR))

        routes_pkg = prev_routes
        if routes_pkg is None:
            routes_pkg = types.ModuleType("routes")
            routes_pkg.__path__ = [str(ROUTES_DIR)]
            sys.modules["routes"] = routes_pkg

        routing_pkg = types.ModuleType("routes.routing")
        routing_pkg.__path__ = [str(ROUTING_DIR)]
        sys.modules["routes.routing"] = routing_pkg

        spec = importlib.util.spec_from_file_location(module_name, module_path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        assert spec and spec.loader
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path[:] = prev_path
        if prev_routes is not None:
            sys.modules["routes"] = prev_routes
        else:
            sys.modules.pop("routes", None)

        if prev_routing is not None:
            sys.modules["routes.routing"] = prev_routing
        else:
            sys.modules.pop("routes.routing", None)

        if prev_module is not None:
            sys.modules[module_name] = prev_module
        else:
            sys.modules.pop(module_name, None)


def test_config_exchange_local_import_hides_read_exception_details(monkeypatch):
    config_exchange = _reload("routes.config_exchange")
    app = Flask("config-exchange-sanitize-read")
    app.register_blueprint(config_exchange.create_config_exchange_blueprint())
    client = app.test_client()

    monkeypatch.setattr(
        config_exchange,
        "read_uploaded_file_bytes_limited",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("C:/secret/bundle.json is unreadable")),
    )

    response = client.post(
        "/api/local/import-configs",
        data={"file": (io.BytesIO(b"{}"), "bundle.json")},
        content_type="multipart/form-data",
    )

    assert response.status_code == 400
    payload = response.get_json()
    raw = json.dumps(payload, ensure_ascii=False)
    assert payload["ok"] is False
    assert payload["error"] == "read_failed"
    assert payload["hint"] == "Не удалось прочитать загруженный файл конфигурации."
    assert "secret" not in raw
    assert "unreadable" not in raw


def test_config_exchange_local_import_hides_invalid_json_parse_details():
    config_exchange = _reload("routes.config_exchange")
    app = Flask("config-exchange-sanitize-json")
    app.register_blueprint(config_exchange.create_config_exchange_blueprint())
    client = app.test_client()

    response = client.post(
        "/api/local/import-configs",
        data={"file": (io.BytesIO(b"{not-json"), "bundle.json")},
        content_type="multipart/form-data",
    )

    assert response.status_code == 400
    payload = response.get_json()
    raw = json.dumps(payload, ensure_ascii=False)
    assert payload["ok"] is False
    assert payload["error"] == "invalid_json"
    assert payload["hint"] == "Файл конфигурации содержит некорректный JSON."
    assert "Expecting" not in raw
    assert "line 1" not in raw


def test_devtools_spawn_failed_hides_exception_details_in_response_and_status(monkeypatch, tmp_path: Path):
    devtools = _reload("routes.devtools")
    app = Flask("devtools-sanitize-spawn")
    app.register_blueprint(devtools.create_devtools_blueprint(str(tmp_path)))
    client = app.test_client()

    monkeypatch.setattr(devtools.shutil, "which", lambda _name: "stub")

    def fake_popen(*_args, **_kwargs):
        raise RuntimeError("/opt/etc/xkeen-ui/scripts/update_xkeen_ui.sh spawn failure")

    monkeypatch.setattr(devtools.subprocess, "Popen", fake_popen)

    response = client.post("/api/devtools/update/run", json={})

    assert response.status_code == 200
    payload = response.get_json()
    raw = json.dumps(payload, ensure_ascii=False)
    assert payload["ok"] is False
    assert payload["error"] == "spawn_failed"
    assert payload["hint"] == "Не удалось запустить update runner. Подробности смотрите в server logs."
    assert "spawn failure" not in raw
    assert "/opt/etc/xkeen-ui" not in raw
    assert "meta" not in payload

    status_response = client.get("/api/devtools/update/status?tail=0")
    status_payload = status_response.get_json()
    status_raw = json.dumps(status_payload, ensure_ascii=False)
    assert status_payload["status"]["error"] == "spawn_failed"
    assert status_payload["status"]["message"] == "Не удалось запустить update runner"
    assert "spawn failure" not in status_raw
    assert "/opt/etc/xkeen-ui" not in status_raw


def test_geodat_install_hides_exception_details(monkeypatch, tmp_path: Path):
    geodat = _load_routing_module("geodat")
    script_path = tmp_path / "install_xk_geodat.sh"
    script_path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    bin_path = tmp_path / "xk-geodat"
    bin_path.write_bytes(b"\x7fELFfake")

    monkeypatch.setattr(geodat, "_geodat_install_script_path", lambda: str(script_path))
    monkeypatch.setattr(geodat, "_geodat_bin_path", lambda: str(bin_path))
    monkeypatch.setattr(geodat, "_geodat_run_help", lambda _path: (True, "ok"))
    monkeypatch.setattr(geodat, "geodat_platform_info", lambda: {"supported": True})

    def fake_run(*_args, **_kwargs):
        raise OSError("/opt/etc/xkeen-ui/bin/xk-geodat failed to exec")

    monkeypatch.setattr(geodat.subprocess, "run", fake_run)

    bp = Blueprint("geodat_sanitize", __name__)
    geodat.register_geodat_routes(bp)
    app = Flask("geodat-sanitize")
    app.register_blueprint(bp)
    client = app.test_client()

    response = client.post("/api/routing/geodat/install", json={})

    assert response.status_code == 200
    payload = response.get_json()
    raw = json.dumps(payload, ensure_ascii=False)
    assert payload["ok"] is False
    assert payload["error"] == "install_failed"
    assert payload["hint"] == "Не удалось запустить установку xk-geodat. Подробности смотрите в server logs."
    assert "details" not in payload
    assert "/opt/etc/xkeen-ui" not in raw
    assert "failed to exec" not in raw


def test_service_core_switch_hides_exception_details(monkeypatch, tmp_path: Path):
    service = _reload("routes.service")
    app = Flask("service-sanitize-core-switch")
    app.register_blueprint(
        service.create_service_blueprint(
            restart_xkeen=lambda **_kwargs: True,
            append_restart_log=lambda *_args, **_kwargs: None,
            XRAY_ERROR_LOG=str(tmp_path / "xray-error.log"),
        )
    )
    client = app.test_client()

    def fake_switch_core(*_args, **_kwargs):
        raise service.CoreSwitchError(
            "/opt/etc/xkeen-ui/bin/xkeen -mihomo failed",
            details={"cmd": "/opt/etc/xkeen-ui/bin/xkeen -mihomo"},
        )

    monkeypatch.setattr(service, "switch_core", fake_switch_core)

    response = client.post("/api/xkeen/core", json={"core": "mihomo"})

    assert response.status_code == 500
    payload = response.get_json()
    raw = json.dumps(payload, ensure_ascii=False)
    assert payload["ok"] is False
    assert payload["error"] == "Не удалось переключить ядро xkeen."
    assert payload["code"] == "core_switch_failed"
    assert payload["hint"] == "Подробности смотрите в server logs."
    assert "details" not in payload
    assert "/opt/etc/xkeen-ui" not in raw
    assert "-mihomo failed" not in raw


def test_xray_inbounds_write_failure_hides_exception_details(monkeypatch, tmp_path: Path):
    xray_configs = _reload("routes.xray_configs")
    app = Flask("xray-configs-sanitize-write")
    app.register_blueprint(
        xray_configs.create_xray_configs_blueprint(
            restart_xkeen=lambda **_kwargs: True,
            load_json=lambda _path, default=None: default,
            save_json=lambda _path, data: data,
            strip_json_comments_text=lambda text: text,
            snapshot_xray_config_before_overwrite=lambda _path: None,
        )
    )
    client = app.test_client()

    monkeypatch.setattr(
        xray_configs,
        "resolve_xray_fragment_file",
        lambda *_args, **_kwargs: str(tmp_path / "01_inbounds.json"),
    )

    def fake_atomic_write_json(*_args, **_kwargs):
        raise OSError("/opt/etc/xray/01_inbounds.json permission denied")

    monkeypatch.setattr(xray_configs, "_atomic_write_json", fake_atomic_write_json)

    response = client.post("/api/inbounds", json={"text": "{}", "restart": False})

    assert response.status_code == 500
    payload = response.get_json()
    raw = json.dumps(payload, ensure_ascii=False)
    assert payload["ok"] is False
    assert payload["error"] == "Не удалось сохранить основной JSON-файл."
    assert payload["code"] == "write_failed"
    assert payload["hint"] == "Подробности смотрите в server logs."
    assert "/opt/etc/xray" not in raw
    assert "permission denied" not in raw


def test_mihomo_preview_hides_exception_details(monkeypatch, tmp_path: Path):
    mihomo = _reload("routes.mihomo")
    app = Flask("mihomo-sanitize-preview")
    app.register_blueprint(
        mihomo.create_mihomo_blueprint(
            MIHOMO_CONFIG_FILE=str(tmp_path / "config.yaml"),
            MIHOMO_TEMPLATES_DIR=str(tmp_path / "templates"),
            MIHOMO_DEFAULT_TEMPLATE=str(tmp_path / "default.yaml"),
            restart_xkeen=lambda **_kwargs: True,
        )
    )
    client = app.test_client()

    def fake_generate_preview(_payload):
        raise RuntimeError("/opt/etc/xkeen-ui/templates/default.yaml failed to load")

    monkeypatch.setattr(mihomo.mihomo_svc, "generate_preview", fake_generate_preview)

    response = client.post("/api/mihomo/preview", json={})

    assert response.status_code == 400
    payload = response.get_json()
    raw = json.dumps(payload, ensure_ascii=False)
    assert payload["ok"] is False
    assert payload["error"] == "Не удалось сгенерировать предпросмотр."
    assert payload["code"] == "preview_failed"
    assert payload["hint"] == "Проверьте входные данные и повторите попытку."
    assert "/opt/etc/xkeen-ui" not in raw
    assert "failed to load" not in raw


def test_routing_geodat_error_payload_drops_raw_details():
    routing_errors = _load_routing_module("errors")

    payload = routing_errors._geodat_error_payload(
        "xk_geodat_failed",
        details="secret crash at /private/tmp/xk-geodat",
    )

    raw = json.dumps(payload, ensure_ascii=False)
    assert payload["ok"] is False
    assert payload["error"] == "xk_geodat_failed"
    assert "details" not in payload
    assert "Причина:" not in str(payload.get("hint") or "")
    assert "secret" not in raw
    assert "/private/tmp" not in raw


def test_mihomo_invalid_yaml_hides_parser_details(tmp_path: Path, monkeypatch):
    mihomo = _reload("routes.mihomo")
    app = Flask("mihomo-sanitize-yaml")
    app.register_blueprint(
        mihomo.create_mihomo_blueprint(
            MIHOMO_CONFIG_FILE=str(tmp_path / "config.yaml"),
            MIHOMO_TEMPLATES_DIR=str(tmp_path / "templates"),
            MIHOMO_DEFAULT_TEMPLATE=str(tmp_path / "default.yaml"),
            restart_xkeen=lambda **_kwargs: True,
        )
    )
    client = app.test_client()

    monkeypatch.setattr(
        mihomo,
        "validate_yaml_syntax",
        lambda _cfg: (False, "ParserError: /opt/etc/mihomo/config.yaml line 7 near secret-token"),
    )

    response = client.post("/api/mihomo/save_raw", json={"config": "bad: ["})

    assert response.status_code == 400
    payload = response.get_json()
    raw = json.dumps(payload, ensure_ascii=False)
    assert payload["ok"] is False
    assert payload["error"] == "Некорректный YAML-конфиг."
    assert payload["code"] == "yaml_invalid"
    assert payload["hint"] == "Проверьте YAML и попробуйте снова."
    assert "ParserError" not in raw
    assert "secret-token" not in raw
    assert "/opt/etc/mihomo" not in raw


def test_fs_remote_chmod_hides_lftp_tail():
    perms = _reload("routes.fs.endpoints_perms")
    app = Flask("fs-perms-sanitize-remote")
    bp = Blueprint("fs_perms_test", __name__)

    class _FakeMgr:
        def _run_lftp(self, _session, _cmds, capture=True):
            return 1, b"", b"/remote/secret chmod failed: permission denied"

    perms.register_perms_endpoints(
        bp,
        {
            "error_response": _reload("routes.common.errors").error_response,
            "_require_enabled": lambda: None,
            "_get_session_or_404": lambda sid: (SimpleNamespace(session_id=sid, protocol="sftp"), None),
            "_core_log": lambda *_args, **_kwargs: None,
            "LOCALFS_ROOTS": ["/tmp"],
            "mgr": _FakeMgr(),
            "_lftp_quote": lambda value: value,
            "_local_resolve": lambda path, _roots: path,
        },
    )
    app.register_blueprint(bp)
    client = app.test_client()

    response = client.post(
        "/api/fs/chmod",
        json={"target": "remote", "sid": "s1", "path": "/remote/secret", "mode": "644"},
    )

    assert response.status_code == 400
    payload = response.get_json()
    raw = json.dumps(payload, ensure_ascii=False)
    assert payload["ok"] is False
    assert payload["error"] == "chmod_failed"
    assert "details" not in payload
    assert "/remote/secret" not in raw
    assert "permission denied" not in raw


def test_remotefs_connect_failed_hides_lftp_tail():
    sessions = _reload("routes.remotefs.sessions")
    app = Flask("remotefs-sanitize-connect")
    bp = Blueprint("remotefs_sessions_test", __name__)

    class _FakeMgr:
        known_hosts_path = ""
        default_ca_file = ""

        def create(self, protocol, host, port, username, auth_type, auth, options):
            return SimpleNamespace(
                session_id="sid-1",
                protocol=protocol,
                host=host,
                port=port,
                username=username,
            )

        def close(self, _sid):
            return True

        def _run_lftp(self, _session, _cmds, capture=True):
            return 1, b"", b"ssh: connect to host private.example port 22: Permission denied (publickey)"

    sessions.register_sessions_endpoints(
        bp,
        require_enabled=lambda: None,
        mgr=_FakeMgr(),
        normalize_security_options=lambda protocol, options, **_kwargs: (options, {"mode": "strict"}, []),
        classify_connect_error=lambda _tail: {"kind": "auth_failed", "hint": "Проверьте логин, ключ и доступ к хосту."},
        core_log=lambda *_args, **_kwargs: None,
    )
    app.register_blueprint(bp)
    client = app.test_client()

    response = client.post(
        "/api/remotefs/sessions",
        json={
            "protocol": "sftp",
            "host": "private.example",
            "username": "root",
            "auth": {"type": "password", "password": "secret"},
        },
    )

    assert response.status_code == 400
    payload = response.get_json()
    raw = json.dumps(payload, ensure_ascii=False)
    assert payload["ok"] is False
    assert payload["error"] == "connect_failed"
    assert payload["kind"] == "auth_failed"
    assert payload["hint"] == "Проверьте логин, ключ и доступ к хосту."
    assert "details" not in payload
    assert "private.example" not in raw
    assert "Permission denied" not in raw
