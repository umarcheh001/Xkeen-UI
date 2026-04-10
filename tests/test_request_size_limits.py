from __future__ import annotations

import importlib
import importlib.util
import io
import json
import sys
import types
from pathlib import Path

from flask import Blueprint, Flask


ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "xkeen-ui"
ROUTES_DIR = APP_DIR / "routes"
ROUTING_DIR = ROUTES_DIR / "routing"
ROUTING_CONFIG_PATH = ROUTING_DIR / "config.py"

if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))


def _reload(name: str):
    module = sys.modules.get(name)
    if module is not None:
        return importlib.reload(module)
    return importlib.import_module(name)


def _load_routing_config_module():
    prev_routes = sys.modules.get("routes")
    prev_routing = sys.modules.get("routes.routing")
    prev_config = sys.modules.get("routes.routing.config")
    prev_command_jobs = sys.modules.get("services.command_jobs")

    try:
        routes_pkg = prev_routes
        if routes_pkg is None:
            routes_pkg = types.ModuleType("routes")
            routes_pkg.__path__ = [str(ROUTES_DIR)]
            sys.modules["routes"] = routes_pkg

        routing_pkg = types.ModuleType("routes.routing")
        routing_pkg.__path__ = [str(ROUTING_DIR)]
        sys.modules["routes.routing"] = routing_pkg

        command_jobs_stub = types.ModuleType("services.command_jobs")
        command_jobs_stub.create_command_job = lambda *args, **kwargs: None
        sys.modules["services.command_jobs"] = command_jobs_stub

        spec = importlib.util.spec_from_file_location("routes.routing.config", ROUTING_CONFIG_PATH)
        module = importlib.util.module_from_spec(spec)
        sys.modules["routes.routing.config"] = module
        assert spec and spec.loader
        spec.loader.exec_module(module)
        return module
    finally:
        if prev_routes is not None:
            sys.modules["routes"] = prev_routes
        else:
            sys.modules.pop("routes", None)

        if prev_routing is not None:
            sys.modules["routes.routing"] = prev_routing
        else:
            sys.modules.pop("routes.routing", None)

        if prev_config is not None:
            sys.modules["routes.routing.config"] = prev_config
        else:
            sys.modules.pop("routes.routing.config", None)

        if prev_command_jobs is not None:
            sys.modules["services.command_jobs"] = prev_command_jobs
        else:
            sys.modules.pop("services.command_jobs", None)


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


def test_routing_save_rejects_oversized_body_before_preflight(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("XKEEN_ROUTING_SAVE_MAX_BYTES", "64")
    routing_config = _load_routing_config_module()

    bp = Blueprint("routing_test", __name__)
    preflight_calls: list[dict] = []

    monkeypatch.setattr(
        routing_config,
        "_run_xray_preflight",
        lambda **kwargs: preflight_calls.append(kwargs) or {"ok": True},
    )

    routing_config.register_config_routes(
        bp,
        routing_file=str(tmp_path / "05_routing.json"),
        routing_file_raw=str(tmp_path / "jsonc" / "05_routing.jsonc"),
        xray_configs_dir=str(tmp_path),
        xray_configs_dir_real=str(tmp_path),
        backup_dir=str(tmp_path / "backups"),
        backup_dir_real=str(tmp_path / "backups"),
        load_json=lambda path, default=None: default,
        strip_json_comments_text=lambda text: text,
        restart_xkeen=lambda source="routing": True,
    )

    app = Flask("routing-request-limit-test")
    app.register_blueprint(bp)
    client = app.test_client()

    response = client.post("/api/routing", data=("x" * ((64 * 1024) + 256)), content_type="application/json")

    assert response.status_code == 413
    payload = response.get_json()
    assert payload["ok"] is False
    assert payload["error"] == "payload too large"
    assert payload["max_bytes"] == 64 * 1024
    assert preflight_calls == []


def test_local_config_import_rejects_oversized_upload_before_apply(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("XKEEN_CONFIG_EXCHANGE_MAX_BYTES", "128")
    config_exchange = _reload("routes.config_exchange")

    apply_calls: list[dict] = []
    monkeypatch.setattr(config_exchange, "apply_user_configs_bundle", lambda bundle: apply_calls.append(bundle))

    app = Flask("config-exchange-upload-limit-test")
    app.register_blueprint(config_exchange.create_config_exchange_blueprint())
    client = app.test_client()

    response = client.post(
        "/api/local/import-configs",
        data={"file": (io.BytesIO(b"x" * ((64 * 1024) + 256)), "bundle.json")},
        content_type="multipart/form-data",
    )

    assert response.status_code == 413
    payload = response.get_json()
    assert payload["ok"] is False
    assert payload["error"] == "payload too large"
    assert payload["max_bytes"] == 64 * 1024
    assert apply_calls == []


def test_github_export_rejects_oversized_json_body_before_server_upload(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("XKEEN_CONFIG_EXCHANGE_MAX_BYTES", "96")
    config_exchange = _reload("routes.config_exchange")

    upload_calls: list[dict] = []
    bundle_calls: list[dict] = []

    monkeypatch.setattr(config_exchange.gh, "CONFIG_SERVER_BASE", "https://configs.invalid")
    monkeypatch.setattr(
        config_exchange,
        "build_user_configs_bundle",
        lambda **kwargs: bundle_calls.append(kwargs) or {"version": 1, "files": []},
    )
    monkeypatch.setattr(
        config_exchange.gh,
        "config_server_request_safe",
        lambda *args, **kwargs: upload_calls.append({"args": args, "kwargs": kwargs}) or {"ok": True, "id": "cfg-1"},
    )

    app = Flask("config-exchange-json-limit-test")
    app.register_blueprint(config_exchange.create_config_exchange_blueprint())
    client = app.test_client()

    oversized_body = '{"title":"' + ("x" * ((64 * 1024) + 256)) + '"}'
    response = client.post(
        "/api/github/export-configs",
        data=oversized_body,
        content_type="application/json",
    )

    assert response.status_code == 413
    payload = response.get_json()
    assert payload["ok"] is False
    assert payload["error"] == "payload too large"
    assert payload["max_bytes"] == 64 * 1024
    assert bundle_calls == []
    assert upload_calls == []


def test_small_json_guard_rejects_oversized_body_before_command_handler(monkeypatch):
    monkeypatch.setenv("XKEEN_UI_MAX_CONTENT_LENGTH", str(16 * 1024))
    monkeypatch.setenv("XKEEN_JSON_BODY_MAX_BYTES", "1024")

    request_limits = _reload("services.request_limits")
    commands = _reload("routes.commands")

    job_calls: list[dict] = []
    monkeypatch.setattr(commands, "create_command_job", lambda **kwargs: job_calls.append(kwargs))

    app = Flask("json-request-limit-guard")
    request_limits.install_request_size_guards(app)
    app.register_blueprint(commands.create_commands_blueprint())
    client = app.test_client()

    oversized_body = json.dumps({"flag": "-restart", "stdin": "x" * 2048})
    response = client.post("/api/run-command", data=oversized_body, content_type="application/json")

    assert response.status_code == 413
    payload = response.get_json()
    assert payload["ok"] is False
    assert payload["error"] == "payload too large"
    assert payload["max_bytes"] == 1024
    assert job_calls == []


def test_heavy_json_guard_allows_payloads_larger_than_small_default(monkeypatch):
    monkeypatch.setenv("XKEEN_UI_MAX_CONTENT_LENGTH", str(32 * 1024))
    monkeypatch.setenv("XKEEN_JSON_BODY_MAX_BYTES", "1024")
    monkeypatch.setenv("XKEEN_JSON_HEAVY_MAX_BYTES", "8192")

    request_limits = _reload("services.request_limits")
    utils = _reload("routes.utils")

    app = Flask("json-request-limit-heavy")
    request_limits.install_request_size_guards(app)
    app.register_blueprint(utils.create_utils_blueprint())
    client = app.test_client()

    large_json_text = json.dumps({"value": "x" * 4096}, ensure_ascii=False)
    response = client.post(
        "/api/json/format",
        data=json.dumps({"text": large_json_text}),
        content_type="application/json",
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    assert payload["engine"] in ("json", "xkeen_jsonc")


def test_geodat_install_rejects_oversized_uploaded_binary_before_script(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("XKEEN_GEODAT_UPLOAD_MAX_BYTES", str(64 * 1024))
    geodat = _load_routing_module("geodat")

    script_path = tmp_path / "install_xk_geodat.sh"
    script_path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    bin_path = tmp_path / "xk-geodat"
    bin_path.write_bytes(b"\x7fELFfake")

    run_calls: list[dict] = []
    monkeypatch.setattr(geodat, "_geodat_install_script_path", lambda: str(script_path))
    monkeypatch.setattr(geodat, "_geodat_bin_path", lambda: str(bin_path))
    monkeypatch.setattr(geodat, "_geodat_run_help", lambda _path: (True, "ok"))
    monkeypatch.setattr(geodat, "geodat_platform_info", lambda: {"supported": True})
    monkeypatch.setattr(
        geodat.subprocess,
        "run",
        lambda *args, **kwargs: run_calls.append({"args": args, "kwargs": kwargs}),
    )

    bp = Blueprint("geodat_request_limit", __name__)
    geodat.register_geodat_routes(bp)
    app = Flask("geodat-upload-limit-test")
    app.register_blueprint(bp)
    client = app.test_client()

    response = client.post(
        "/api/routing/geodat/install",
        data={"file": (io.BytesIO(b"x" * ((64 * 1024) + 256)), "xk-geodat")},
        content_type="multipart/form-data",
    )

    assert response.status_code == 413
    payload = response.get_json()
    assert payload["ok"] is False
    assert payload["error"] == "payload too large"
    assert payload["max_bytes"] == 64 * 1024
    assert run_calls == []
