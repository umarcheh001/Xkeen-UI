from __future__ import annotations

import json
from pathlib import Path

from flask import Flask

from routes.backups import create_backups_blueprint


def _write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def _read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _build_client(tmp_path: Path):
    configs_dir = tmp_path / "configs"
    backup_dir = tmp_path / "backups"

    routing_file = configs_dir / "05_routing.json"
    inbounds_file = configs_dir / "03_inbounds.json"
    outbounds_file = configs_dir / "04_outbounds.json"
    routing_raw = configs_dir / "05_routing.jsonc"

    _write_json(routing_file, {"routing": "current"})
    _write_json(inbounds_file, {"inbounds": "current"})
    _write_json(outbounds_file, {"outbounds": "current"})

    def load_json(path: str, default=None):
        try:
            return json.loads(Path(path).read_text(encoding="utf-8"))
        except Exception:
            return default

    def save_json(path: str, payload) -> None:
        _write_json(Path(path), payload)

    def list_backups():
        items = []
        if not backup_dir.is_dir():
            return items
        for entry in backup_dir.iterdir():
            if entry.is_file():
                items.append({"name": entry.name})
        return items

    def detect_backup_target_file(filename: str) -> str:
        name = str(filename or "")
        if name.startswith("03_inbounds"):
            return str(inbounds_file)
        if name.startswith("04_outbounds"):
            return str(outbounds_file)
        return str(routing_file)

    def find_latest_auto_backup_for(_config_path: str):
        return None, None

    app = Flask(__name__)
    app.config.update(TESTING=True, SECRET_KEY="test-secret")
    app.register_blueprint(
        create_backups_blueprint(
            BACKUP_DIR=str(backup_dir),
            ROUTING_FILE=str(routing_file),
            ROUTING_FILE_RAW=str(routing_raw),
            INBOUNDS_FILE=str(inbounds_file),
            OUTBOUNDS_FILE=str(outbounds_file),
            load_json=load_json,
            save_json=save_json,
            list_backups=list_backups,
            _detect_backup_target_file=detect_backup_target_file,
            _find_latest_auto_backup_for=find_latest_auto_backup_for,
            strip_json_comments_text=lambda text: text,
            restart_xkeen=lambda **_kwargs: True,
        )
    )

    return app.test_client(), {
        "routing_file": routing_file,
        "backup_dir": backup_dir,
        "configs_dir": configs_dir,
    }


def test_api_restore_rejects_traversal_filename(tmp_path: Path):
    client, paths = _build_client(tmp_path)
    outside_backup = tmp_path / "escape.json"
    _write_json(outside_backup, {"routing": "pwned"})

    response = client.post("/api/restore", json={"filename": "../escape.json"})

    assert response.status_code == 404
    assert _read_json(paths["routing_file"]) == {"routing": "current"}
    assert _read_json(outside_backup) == {"routing": "pwned"}


def test_api_delete_rejects_traversal_filename(tmp_path: Path):
    client, _paths = _build_client(tmp_path)
    outside_backup = tmp_path / "escape.json"
    _write_json(outside_backup, {"keep": True})

    response = client.post("/api/delete-backup", json={"filename": "../escape.json"})

    assert response.status_code == 404
    assert outside_backup.exists()
    assert _read_json(outside_backup) == {"keep": True}


def test_html_legacy_backup_routes_ignore_traversal_names(tmp_path: Path):
    client, paths = _build_client(tmp_path)
    outside_backup = tmp_path / "escape.json"
    _write_json(outside_backup, {"routing": "outside"})

    restore_response = client.post("/restore", data={"filename": "../escape.json"}, follow_redirects=False)
    delete_response = client.post("/delete-backup", data={"filename": "../escape.json"}, follow_redirects=False)

    assert restore_response.status_code == 302
    assert delete_response.status_code == 302
    assert restore_response.headers.get("Location", "").endswith("/backups")
    assert delete_response.headers.get("Location", "").endswith("/backups")
    assert _read_json(paths["routing_file"]) == {"routing": "current"}
    assert outside_backup.exists()


def test_legacy_history_backup_restore_and_delete_still_work(tmp_path: Path):
    client, paths = _build_client(tmp_path)
    history_backup = paths["backup_dir"] / "05_routing-20260408-223000.json"
    _write_json(history_backup, {"routing": "restored"})

    restore_response = client.post("/api/restore", json={"filename": history_backup.name})
    delete_response = client.post("/api/delete-backup", json={"filename": history_backup.name})

    assert restore_response.status_code == 200
    assert restore_response.get_json() == {"ok": True}
    assert _read_json(paths["routing_file"]) == {"routing": "restored"}
    assert delete_response.status_code == 200
    assert delete_response.get_json() == {"ok": True}
    assert not history_backup.exists()
