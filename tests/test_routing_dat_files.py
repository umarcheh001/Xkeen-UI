from __future__ import annotations

import io
import os
from pathlib import Path

import pytest
from flask import Blueprint, Flask

from routes.routing.dat_files import register_dat_file_routes
from services.request_limits import install_request_size_guards
from tests.support.panel_render import (
    FULL_MODULE_IDS,
    MIHOMO_MINIMAL_MODULE_IDS,
    XRAY_MINIMAL_MODULE_IDS,
    render_panel,
)


ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def dat_env(tmp_path, monkeypatch):
    allowed = tmp_path / "allowed"
    dat_dir = allowed / "xray" / "dat"
    dat_dir.mkdir(parents=True)
    (dat_dir / "geosite.dat").write_bytes(b"s" * 10)
    (dat_dir / "geoip.dat").write_bytes(b"i" * 20)
    (dat_dir / "notes.txt").write_text("skip", encoding="utf-8")
    (dat_dir / "nested.dat").mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.dat").write_bytes(b"x")
    monkeypatch.setenv("XKEEN_LOCALFM_ROOTS", str(allowed))
    monkeypatch.setenv("XKEEN_MAX_DAT_MB", "1")

    app = Flask("routing-dat-files")
    app.config["TESTING"] = True
    install_request_size_guards(app, env={"XKEEN_MAX_DAT_MB": "1"})
    bp = Blueprint("routing", __name__)
    register_dat_file_routes(bp)
    app.register_blueprint(bp)
    return {"client": app.test_client(), "dat_dir": dat_dir, "outside": outside}


def test_files_lists_only_dat_files_of_an_allowed_directory(dat_env):
    client = dat_env["client"]

    response = client.get("/api/routing/dat/files", query_string={"dir": str(dat_env["dat_dir"])})
    payload = response.get_json()

    assert response.status_code == 200
    assert [item["name"] for item in payload["items"]] == ["geoip.dat", "geosite.dat"]
    assert {item["type"] for item in payload["items"]} == {"file"}
    assert payload["items"][0]["size"] == 20

    forbidden = client.get("/api/routing/dat/files", query_string={"dir": str(dat_env["outside"])})
    assert forbidden.status_code == 403
    missing = client.get("/api/routing/dat/files", query_string={"dir": str(dat_env["dat_dir"] / "none")})
    assert missing.status_code == 200 and missing.get_json()["items"] == []


def test_stat_keeps_requested_paths_and_refuses_foreign_files(dat_env):
    client = dat_env["client"]
    site = str(dat_env["dat_dir"] / "geosite.dat")
    absent = str(dat_env["dat_dir"] / "absent.dat")
    outside = str(dat_env["outside"] / "secret.dat")
    not_dat = str(dat_env["dat_dir"] / "notes.txt")

    response = client.post("/api/routing/dat/stat", json={"paths": [site, absent, outside, not_dat]})
    items = {item["path"]: item for item in response.get_json()["items"]}

    assert response.status_code == 200
    assert items[site]["exists"] is True and items[site]["size"] == 10
    assert items[absent] == {"path": absent, "exists": False}
    assert items[outside]["error"] == "forbidden"
    assert items[not_dat]["error"] == "forbidden"
    too_many = client.post("/api/routing/dat/stat", json={"paths": [site] * 9})
    assert too_many.status_code == 400


def test_upload_requires_overwrite_and_keeps_limits(dat_env):
    client = dat_env["client"]
    target = dat_env["dat_dir"] / "geosite.dat"

    def upload(path, body, **query):
        return client.post(
            "/api/routing/dat/upload",
            query_string={"path": str(path), **query},
            data={"file": (io.BytesIO(body), "upload.dat")},
            content_type="multipart/form-data",
        )

    assert upload(target, b"new").status_code == 409
    replaced = upload(target, b"new", overwrite="1")
    assert replaced.status_code == 200 and replaced.get_json()["size"] == 3
    assert target.read_bytes() == b"new"

    created = upload(dat_env["dat_dir"] / "fresh.dat", b"abc")
    assert created.status_code == 200
    assert upload(dat_env["outside"] / "evil.dat", b"x").status_code == 403
    assert upload(dat_env["dat_dir"] / "evil.sh", b"x").status_code == 400

    too_large = upload(dat_env["dat_dir"] / "big.dat", b"x" * (1024 * 1024 + 1))
    assert too_large.status_code == 413
    assert not (dat_env["dat_dir"] / "big.dat").exists()
    assert not [name for name in os.listdir(dat_env["dat_dir"]) if name.endswith(".tmp")]


def test_download_serves_only_allowed_dat_files(dat_env):
    client = dat_env["client"]

    response = client.get("/api/routing/dat/download", query_string={"path": str(dat_env["dat_dir"] / "geoip.dat")})
    assert response.status_code == 200
    assert response.data == b"i" * 20
    assert "attachment" in response.headers.get("Content-Disposition", "")
    response.close()

    outside = client.get("/api/routing/dat/download", query_string={"path": str(dat_env["outside"] / "secret.dat")})
    assert outside.status_code == 403
    not_dat = client.get("/api/routing/dat/download", query_string={"path": str(dat_env["dat_dir"] / "notes.txt")})
    assert not_dat.status_code == 400


def test_dat_card_frontend_no_longer_depends_on_file_manager_api():
    api = (ROOT / "xkeen-ui/static/js/features/routing_cards/dat/api.js").read_text(encoding="utf-8")

    assert "/api/fs/" not in api
    for endpoint in ("/api/routing/dat/stat", "/api/routing/dat/files", "/api/routing/dat/upload", "/api/routing/dat/download"):
        assert endpoint in api


def test_resource_summary_is_rendered_only_with_advanced_diagnostics(tmp_path, monkeypatch):
    monkeypatch.delenv("XKEEN_UI_PANEL_SECTIONS_WHITELIST", raising=False)

    assert 'id="xk-resource-monitor"' in render_panel(FULL_MODULE_IDS, tmp_path / "full")
    for name, module_ids in (("xray", XRAY_MINIMAL_MODULE_IDS), ("mihomo", MIHOMO_MINIMAL_MODULE_IDS)):
        assert 'id="xk-resource-monitor"' not in render_panel(module_ids, tmp_path / name)
