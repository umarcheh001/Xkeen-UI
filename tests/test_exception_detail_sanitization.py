from __future__ import annotations

import importlib
import importlib.util
import io
import json
import sys
import tempfile
import types
from pathlib import Path

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
