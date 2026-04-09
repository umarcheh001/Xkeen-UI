from __future__ import annotations

import importlib
import importlib.util
import io
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
