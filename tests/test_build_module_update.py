"""Сборка каталога обновлений модулей одной панели (scripts/build_module_update.py)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from scripts import sign_modular_panel_catalog
from scripts.build_module_update import ModuleUpdateBuildError, build_module_update, load_previous
from services.module_package_contract import validate_module_archive, validate_module_updates_document

EPOCH = 1_700_000_000
PANEL = "3.1.0"


def _tree(root: Path) -> Path:
    package = root / "xkeen-ui"
    for relative in (
        "install.sh",
        "services/module_registry.py",
        "static/js/pages/terminal.lazy.entry.js",
        "routes/backups.py",
    ):
        path = package / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"payload {relative}\n", encoding="utf-8")
    return root


def _build(tmp_path: Path, name: str, module_id: str, version: str, previous=None, panel=PANEL, channel="stable"):
    return build_module_update(
        _tree(tmp_path / "root"),
        tmp_path / name,
        module_id=module_id,
        version=version,
        panel_version=panel,
        channel=channel,
        previous=previous,
        epoch=EPOCH,
    )


def _document(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_first_release_has_serial_one_and_passes_the_contract(tmp_path):
    path = _build(tmp_path, "out", "tool.terminal", "1.0.1")
    assert path.name == "module-updates.json"
    document = _document(path)
    assert document["kind"] == "xkeen-module-updates"
    assert document["serial"] == 1
    assert document["panel_version"] == PANEL
    validated = validate_module_updates_document(
        document, panel_version=PANEL, signing_key_id="release-2026", core_version=PANEL
    )
    [entry] = validated["modules"]
    assert entry["id"] == "tool.terminal"
    assert entry["version"] == "1.0.1"
    assert entry["min_core"] == PANEL
    assert entry["ownership"] == ["static/js/pages/terminal.lazy.entry.js"]

    archive = path.parent / entry["archive"]
    assert archive.name == "xkeen-module-tool.terminal-1.0.1.tar.gz"
    result = validate_module_archive(archive, entry, platform_architecture="mips", core_version=PANEL)
    assert result["payload_files"] == entry["ownership"]
    sidecar = archive.with_name(archive.name + ".sha256")
    assert sidecar.read_text(encoding="utf-8") == f"{entry['sha256']}  {archive.name}\n"


def test_metadata_lists_only_files_uploaded_to_the_panel_release(tmp_path):
    path = _build(tmp_path, "out", "tool.terminal", "1.0.1")
    metadata = _document(path.parent / "release-metadata.json")
    # release-metadata.json of the panel itself is not overwritten: it is not an asset here.
    assert metadata["assets"] == sorted(
        [
            "module-updates.json",
            "xkeen-module-tool.terminal-1.0.1.tar.gz",
            "xkeen-module-tool.terminal-1.0.1.tar.gz.sha256",
        ]
    )
    assert metadata["release_version"] == PANEL


def test_next_release_raises_serial_and_replaces_only_its_module(tmp_path):
    first = _document(_build(tmp_path, "one", "tool.terminal", "1.0.1"))
    second = _document(_build(tmp_path, "two", "tool.backups", "1.0.1", previous=first))
    assert second["serial"] == 2
    assert [entry["id"] for entry in second["modules"]] == ["tool.backups", "tool.terminal"]
    kept = next(entry for entry in second["modules"] if entry["id"] == "tool.terminal")
    assert kept == first["modules"][0]

    third = _document(_build(tmp_path, "three", "tool.terminal", "1.0.2", previous=second))
    assert third["serial"] == 3
    versions = {entry["id"]: entry["version"] for entry in third["modules"]}
    assert versions == {"tool.backups": "1.0.1", "tool.terminal": "1.0.2"}
    validate_module_updates_document(third, panel_version=PANEL, signing_key_id="release-2026", core_version=PANEL)


def test_previous_of_another_panel_or_newer_version_is_refused(tmp_path):
    first = _document(_build(tmp_path, "one", "tool.terminal", "1.0.2"))
    with pytest.raises(ModuleUpdateBuildError):
        _build(tmp_path, "two", "tool.terminal", "1.0.2", previous=first)
    with pytest.raises(ModuleUpdateBuildError):
        _build(tmp_path, "three", "tool.terminal", "1.0.3", previous={**first, "panel_version": "3.0.9"})


def test_version_equal_to_panel_would_overwrite_the_panel_archive(tmp_path):
    with pytest.raises(ModuleUpdateBuildError):
        _build(tmp_path, "out", "tool.terminal", PANEL)


def test_prerelease_panel_needs_prerelease_channel(tmp_path):
    with pytest.raises(ModuleUpdateBuildError):
        _build(tmp_path, "out", "tool.terminal", "1.0.1", panel="3.1.0-beta.2", channel="stable")
    path = _build(tmp_path, "ok", "tool.terminal", "1.0.1", panel="3.1.0-beta.2", channel="prerelease")
    assert _document(path)["modules"][0]["channel"] == "prerelease"


def _keys(monkeypatch):
    key = Ed25519PrivateKey.generate()
    pem = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode("ascii")
    monkeypatch.setenv("TEST_MODULE_UPDATES_KEY", pem)
    public = key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    return {"release-2026": public}


def _sign(path: Path) -> Path:
    code = sign_modular_panel_catalog.main(
        [
            "--catalog", str(path),
            "--metadata", str(path.parent / "release-metadata.json"),
            "--key-id", "release-2026",
            "--private-key-env", "TEST_MODULE_UPDATES_KEY",
        ]
    )
    assert code == 0
    return path.with_name(path.name + ".sig")


def test_signed_document_is_read_back_as_previous(tmp_path, monkeypatch):
    keyring = _keys(monkeypatch)
    path = _build(tmp_path, "one", "tool.terminal", "1.0.1")
    signature = _sign(path)
    assert "module-updates.json.sig" in _document(path.parent / "release-metadata.json")["assets"]
    previous = load_previous(path, signature, panel_version=PANEL, keyring=keyring)
    assert previous["serial"] == 1

    tampered = tmp_path / "tampered.json"
    tampered.write_bytes(path.read_bytes().replace(b'"serial":1', b'"serial":9'))
    with pytest.raises(ModuleUpdateBuildError):
        load_previous(tampered, signature, panel_version=PANEL, keyring=keyring)
    with pytest.raises(ModuleUpdateBuildError):
        load_previous(path, signature, panel_version="3.1.1", keyring=keyring)


def test_no_previous_files_means_first_release(tmp_path):
    assert load_previous(None, None, panel_version=PANEL) is None
    with pytest.raises(ModuleUpdateBuildError):
        # a document without its signature is never trusted
        load_previous(tmp_path / "module-updates.json", None, panel_version=PANEL)


WORKFLOW = Path(__file__).resolve().parents[1] / ".github" / "workflows" / "release-module.yml"


def _steps() -> dict[str, dict]:
    import yaml

    workflow = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    # PyYAML reads the key `on` as True.
    assert workflow[True] == {"push": {"tags": ["module-*"]}}
    assert workflow["concurrency"] == {"group": "module-release", "cancel-in-progress": False}
    return {step["name"]: step for step in workflow["jobs"]["release-module"]["steps"]}


def test_workflow_passes_the_signing_secret_only_to_the_signing_step():
    steps = _steps()
    with_secret = [name for name, step in steps.items() if "secrets." in json.dumps(step)]
    assert with_secret == ["Sign module updates"]
    assert "--catalog dist/module-release/module-updates.json" in steps["Sign module updates"]["run"]


def test_workflow_order_and_release_checks():
    steps = _steps()
    names = list(steps)
    order = [
        "Run Python tests",
        "Download the panel archive",
        "Prepare package tree",
        "Check module release",
        "Download previous module updates",
        "Build module release",
        "Sign module updates",
        "Validate module release assets",
        "Publish to the panel release",
    ]
    assert [name for name in names if name in order] == order
    check = steps["Check module release"]["run"]
    assert "--published-file" in check and "2)" in check and "выпуском панели" in check
    publish = [line.strip() for line in steps["Publish to the panel release"]["run"].splitlines() if "gh release upload" in line]
    assert len(publish) == 3
    assert ".sha256" in publish[0] and "--clobber" in publish[0]
    assert publish[1].endswith("module-updates.json --clobber")
    assert publish[2].endswith("module-updates.json.sig --clobber")
