from __future__ import annotations

import sys
from pathlib import Path

from flask import Flask

ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "xkeen-ui"
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from routes.mihomo import create_mihomo_blueprint
import routes.mihomo as mihomo_routes
from services.mihomo_clash_migration import (
    build_safe_mihomo_config,
    materialize_generated_secret,
)


def test_bundled_templates_and_generator_are_unix_first():
    for path in sorted((APP_DIR / "opt" / "etc" / "mihomo" / "templates").glob("*.yaml")):
        text = path.read_text(encoding="utf-8")
        assert "external-controller-unix: ./mihomo-api.sock" in text
        assert "external-controller: 0.0.0.0:9090" not in text
    generator = (APP_DIR / "static" / "js" / "features" / "mihomo_generator.js").read_text(encoding="utf-8")
    assert "external-controller-unix: ./mihomo-api.sock" in generator
    assert "external-controller: 0.0.0.0:9090" not in generator


def test_unix_preview_is_non_mutating_and_removes_lan_controller():
    source = "mode: rule\nexternal-controller: 0.0.0.0:9090\nsecret: old-secret\n"
    preview = build_safe_mihomo_config(source)
    assert preview.transport == "unix"
    assert "external-controller-unix: ./mihomo-api.sock" in preview.content
    assert "external-controller: 0.0.0.0:9090" not in preview.content
    assert "old-secret" not in preview.content
    assert "old-secret" in source
    assert preview.public_dict()["content"] == preview.content
    assert len(preview.public_dict()["preview_id"]) == 64


def test_unix_preview_adds_missing_controller_without_touching_source():
    source = "mode: rule\nallow-lan: false\n"
    preview = build_safe_mihomo_config(source)
    assert preview.transport == "unix"
    assert preview.content.endswith("external-controller-unix: ./mihomo-api.sock\n")
    assert preview.changes == ("Добавить external-controller-unix внутри корня Mihomo",)
    assert source == "mode: rule\nallow-lan: false\n"


def test_tcp_preview_materializes_secret_only_on_apply():
    preview = build_safe_mihomo_config(
        "mode: rule\nexternal-controller: 0.0.0.0:9090\n", prefer_unix=False
    )
    assert preview.transport == "tcp-loopback"
    assert "127.0.0.1:9090" in preview.content
    assert "__XKEEN_GENERATED_SECRET__" in preview.content
    materialized = materialize_generated_secret(preview.content)
    assert "__XKEEN_GENERATED_SECRET__" not in materialized
    assert "secret: " in materialized


def test_migration_preview_requires_no_write(tmp_path: Path):
    config = tmp_path / "config.yaml"
    config.write_text("external-controller: 0.0.0.0:9090\n", encoding="utf-8")
    app = Flask("mihomo-migration-preview")
    app.config["TESTING"] = True
    app.register_blueprint(
        create_mihomo_blueprint(
            MIHOMO_CONFIG_FILE=str(config),
            MIHOMO_TEMPLATES_DIR=str(tmp_path / "templates"),
            MIHOMO_DEFAULT_TEMPLATE=str(tmp_path / "templates" / "custom.yaml"),
            restart_xkeen=lambda **_: False,
        )
    )
    response = app.test_client().post(
        "/api/mihomo/security/migration-preview", json={"transport": "unix"}
    )
    assert response.status_code == 200
    assert response.get_json()["requires_confirmation"] is True
    assert config.read_text(encoding="utf-8") == "external-controller: 0.0.0.0:9090\n"


def test_migration_apply_rejects_missing_or_stale_preview(tmp_path: Path):
    config = tmp_path / "config.yaml"
    config.write_text("external-controller: 0.0.0.0:9090\n", encoding="utf-8")
    app = Flask("mihomo-migration-stale")
    app.config["TESTING"] = True
    app.register_blueprint(
        create_mihomo_blueprint(
            MIHOMO_CONFIG_FILE=str(config),
            MIHOMO_TEMPLATES_DIR=str(tmp_path / "templates"),
            MIHOMO_DEFAULT_TEMPLATE=str(tmp_path / "templates" / "custom.yaml"),
            restart_xkeen=lambda **_: False,
        )
    )
    response = app.test_client().post(
        "/api/mihomo/security/migration-apply",
        json={"transport": "unix", "confirmed": True, "preview_id": "stale"},
    )
    assert response.status_code == 409
    assert response.get_json()["code"] == "migration_preview_stale"
    assert config.read_text(encoding="utf-8") == "external-controller: 0.0.0.0:9090\n"


def test_migration_apply_validates_then_saves_with_backup_contract(
    tmp_path: Path, monkeypatch
):
    config = tmp_path / "config.yaml"
    config.write_text(
        "mode: rule\nexternal-controller: 0.0.0.0:9090\n", encoding="utf-8"
    )
    calls: list[tuple[str, str]] = []
    monkeypatch.setattr(
        mihomo_routes, "ensure_mihomo_layout", lambda: calls.append(("layout", ""))
    )
    monkeypatch.setattr(
        mihomo_routes,
        "validate_config",
        lambda new_content=None: calls.append(("validate", str(new_content or "")))
        or "[exit code: 0]",
    )
    monkeypatch.setattr(
        mihomo_routes,
        "save_config",
        lambda content: calls.append(("save", str(content))),
    )
    app = Flask("mihomo-migration-apply")
    app.config["TESTING"] = True
    app.register_blueprint(
        create_mihomo_blueprint(
            MIHOMO_CONFIG_FILE=str(config),
            MIHOMO_TEMPLATES_DIR=str(tmp_path / "templates"),
            MIHOMO_DEFAULT_TEMPLATE=str(tmp_path / "templates" / "custom.yaml"),
            restart_xkeen=lambda **_: False,
        )
    )
    client = app.test_client()
    preview = client.post(
        "/api/mihomo/security/migration-preview", json={"transport": "unix"}
    ).get_json()
    response = client.post(
        "/api/mihomo/security/migration-apply",
        json={
            "transport": "unix",
            "confirmed": True,
            "preview_id": preview["preview"]["preview_id"],
            "restart": False,
        },
    )
    assert response.status_code == 200
    assert response.get_json()["backup_created"] is True
    assert [call[0] for call in calls] == ["layout", "validate", "save"]
    assert "external-controller-unix: ./mihomo-api.sock" in calls[-1][1]


def test_migration_apply_fails_closed_without_successful_mihomo_validation(
    tmp_path: Path, monkeypatch
):
    config = tmp_path / "config.yaml"
    original = "mode: rule\nexternal-controller: 0.0.0.0:9090\n"
    config.write_text(original, encoding="utf-8")
    saved: list[str] = []
    monkeypatch.setattr(mihomo_routes, "ensure_mihomo_layout", lambda: None)
    monkeypatch.setattr(
        mihomo_routes,
        "validate_config",
        lambda new_content=None: "MIHOMO_VALIDATE_CMD is not set.",
    )
    monkeypatch.setattr(mihomo_routes, "save_config", saved.append)
    app = Flask("mihomo-migration-validation-required")
    app.config["TESTING"] = True
    app.register_blueprint(
        create_mihomo_blueprint(
            MIHOMO_CONFIG_FILE=str(config),
            MIHOMO_TEMPLATES_DIR=str(tmp_path / "templates"),
            MIHOMO_DEFAULT_TEMPLATE=str(tmp_path / "templates" / "custom.yaml"),
            restart_xkeen=lambda **_: False,
        )
    )
    client = app.test_client()
    preview = client.post(
        "/api/mihomo/security/migration-preview", json={"transport": "unix"}
    ).get_json()["preview"]
    response = client.post(
        "/api/mihomo/security/migration-apply",
        json={
            "transport": "unix",
            "confirmed": True,
            "preview_id": preview["preview_id"],
        },
    )
    assert response.status_code == 400
    assert response.get_json()["code"] == "migration_validation_failed"
    assert saved == []
    assert config.read_text(encoding="utf-8") == original
