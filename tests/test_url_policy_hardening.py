from __future__ import annotations

import importlib
import importlib.util
import subprocess
import sys
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


def _make_geodat_client(monkeypatch, tmp_path: Path):
    geodat = _load_routing_module("geodat")
    script_path = tmp_path / "install_xk_geodat.sh"
    script_path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    bin_path = tmp_path / "xk-geodat"
    bin_path.write_bytes(b"\x7fELFfake")

    monkeypatch.setattr(geodat, "_geodat_install_script_path", lambda: str(script_path))
    monkeypatch.setattr(geodat, "_geodat_bin_path", lambda: str(bin_path))
    monkeypatch.setattr(geodat, "_geodat_run_help", lambda _path: (True, "ok"))
    monkeypatch.setattr(geodat, "geodat_platform_info", lambda: {"supported": True, "asset": "xk-geodat-linux-arm64"})

    bp = Blueprint("geodat_test", __name__)
    geodat.register_geodat_routes(bp)
    app = Flask("geodat-url-policy-test")
    app.register_blueprint(bp)
    return app.test_client(), geodat


def _make_dat_client():
    dat = _load_routing_module("dat")
    bp = Blueprint("dat_test", __name__)
    dat.register_dat_routes(bp)
    app = Flask("dat-url-policy-test")
    app.register_blueprint(bp)
    return app.test_client(), dat


def test_geodat_install_blocks_custom_url_by_default_before_running_script(monkeypatch, tmp_path: Path):
    monkeypatch.delenv("XKEEN_GEODAT_ALLOW_CUSTOM_URLS", raising=False)
    monkeypatch.delenv("XKEEN_GEODAT_ALLOW_PRIVATE_HOSTS", raising=False)
    monkeypatch.delenv("XKEEN_GEODAT_ALLOW_HTTP", raising=False)
    client, geodat = _make_geodat_client(monkeypatch, tmp_path)

    calls = []

    def fake_run(*args, **kwargs):
        calls.append((args, kwargs))
        return subprocess.CompletedProcess(args[0], 0, "", "")

    monkeypatch.setattr(geodat.subprocess, "run", fake_run)

    response = client.post("/api/routing/geodat/install", json={"url": "https://mirror.example/xk-geodat"})

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is False
    assert payload["error"] == "url_blocked"
    assert payload["reason"] == "host_not_allowed:mirror.example"
    assert "XKEEN_GEODAT_ALLOW_CUSTOM_URLS=1" in payload["hint"]
    assert calls == []


def test_geodat_install_opt_in_downloads_to_local_file_before_script(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("XKEEN_GEODAT_ALLOW_CUSTOM_URLS", "1")
    monkeypatch.delenv("XKEEN_GEODAT_ALLOW_PRIVATE_HOSTS", raising=False)
    client, geodat = _make_geodat_client(monkeypatch, tmp_path)

    download_calls = []
    seen_env = {}

    def fake_download(url, tmp_file, max_bytes, *, policy, user_agent="Xkeen-UI", timeout=45):
        download_calls.append({
            "url": url,
            "tmp_file": tmp_file,
            "max_bytes": max_bytes,
            "allow_custom_urls": policy.allow_custom_urls,
            "allow_private_hosts": policy.allow_private_hosts,
        })
        Path(tmp_file).write_bytes(b"\x7fELFdownloaded")
        return 16

    def fake_run(argv, env=None, **kwargs):
        seen_env.update(dict(env or {}))
        return subprocess.CompletedProcess(argv, 0, "ok", "")

    monkeypatch.setattr(geodat, "download_to_file_with_policy", fake_download)
    monkeypatch.setattr(geodat.subprocess, "run", fake_run)

    response = client.post("/api/routing/geodat/install", json={"url": "https://mirror.example/xk-geodat"})

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    assert download_calls and download_calls[0]["url"] == "https://mirror.example/xk-geodat"
    assert download_calls[0]["allow_custom_urls"] is True
    assert "XKEEN_GEODAT_LOCAL" in seen_env
    assert "XKEEN_GEODAT_URL" not in seen_env
    assert not Path(seen_env["XKEEN_GEODAT_LOCAL"]).exists()


def test_dat_update_blocks_custom_url_by_default_before_download(monkeypatch, tmp_path: Path):
    monkeypatch.delenv("XKEEN_DAT_ALLOW_CUSTOM_URLS", raising=False)
    monkeypatch.delenv("XKEEN_DAT_ALLOW_PRIVATE_HOSTS", raising=False)
    monkeypatch.delenv("XKEEN_DAT_ALLOW_HTTP", raising=False)
    client, dat = _make_dat_client()
    target = tmp_path / "geosite_v2fly.dat"

    monkeypatch.setattr(dat, "_local_allowed_roots", lambda: [str(tmp_path)])
    monkeypatch.setattr(dat, "_local_resolve", lambda path, roots: str(target))

    calls = []

    def fake_download(*args, **kwargs):
        calls.append((args, kwargs))
        return 123

    monkeypatch.setattr(dat, "download_to_file_with_policy", fake_download)

    response = client.post(
        "/api/routing/dat/update",
        json={"kind": "geosite", "url": "https://mirror.example/geosite.dat", "path": str(target)},
    )

    assert response.status_code == 400
    payload = response.get_json()
    assert payload["ok"] is False
    assert payload["error"] == "url_blocked"
    assert payload["reason"] == "host_not_allowed:mirror.example"
    assert "XKEEN_DAT_ALLOW_CUSTOM_URLS=1" in payload["hint"]
    assert calls == []


def test_dat_update_rejects_private_hosts_even_with_custom_urls(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("XKEEN_DAT_ALLOW_CUSTOM_URLS", "1")
    monkeypatch.delenv("XKEEN_DAT_ALLOW_PRIVATE_HOSTS", raising=False)
    client, dat = _make_dat_client()
    target = tmp_path / "geoip_v2fly.dat"

    monkeypatch.setattr(dat, "_local_allowed_roots", lambda: [str(tmp_path)])
    monkeypatch.setattr(dat, "_local_resolve", lambda path, roots: str(target))

    response = client.post(
        "/api/routing/dat/update",
        json={"kind": "geoip", "url": "https://127.0.0.1/geoip.dat", "path": str(target)},
    )

    assert response.status_code == 400
    payload = response.get_json()
    assert payload["ok"] is False
    assert payload["error"] == "url_blocked"
    assert payload["reason"] == "private_host_not_allowed:127.0.0.1"
    assert "XKEEN_DAT_ALLOW_PRIVATE_HOSTS=1" in payload["hint"]


def test_dat_update_opt_in_allows_custom_public_url(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("XKEEN_DAT_ALLOW_CUSTOM_URLS", "1")
    monkeypatch.delenv("XKEEN_DAT_ALLOW_PRIVATE_HOSTS", raising=False)
    client, dat = _make_dat_client()
    target = tmp_path / "geosite_v2fly.dat"

    monkeypatch.setattr(dat, "_local_allowed_roots", lambda: [str(tmp_path)])
    monkeypatch.setattr(dat, "_local_resolve", lambda path, roots: str(target))
    monkeypatch.setattr(dat, "_apply_local_metadata_best_effort", lambda *args, **kwargs: None)

    def fake_download(url, tmp_file, max_bytes, *, policy, user_agent="Xkeen-UI", timeout=45):
        Path(tmp_file).write_bytes(b"dat")
        return 3

    monkeypatch.setattr(dat, "download_to_file_with_policy", fake_download)

    response = client.post(
        "/api/routing/dat/update",
        json={"kind": "geosite", "url": "https://mirror.example/geosite.dat", "path": str(target)},
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    assert payload["path"] == str(target)
    assert target.read_bytes() == b"dat"
