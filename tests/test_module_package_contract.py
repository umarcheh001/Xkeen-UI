from __future__ import annotations

import hashlib
import io
import json
import tarfile
from pathlib import Path

import pytest

from services.module_package_contract import (
    ModulePackageContractError,
    validate_catalog_entry,
    validate_catalog_source,
    validate_module_archive,
)


def _manifest(**overrides: object) -> dict[str, object]:
    manifest: dict[str, object] = {
        "schema_version": 1,
        "id": "tool.files",
        "version": "1.2.3",
        "channel": "stable",
        "panel_api": "1",
        "module_api": "1",
        "min_core": "1.0.0",
        "architectures": ["aarch64"],
        "requires": ["core"],
        "conflicts": [],
        "requires_restart": True,
        "ownership": ["services/file_manager.py"],
        "max_size": 4096,
    }
    manifest.update(overrides)
    return manifest


def _write_archive(
    path: Path,
    manifest: dict[str, object],
    *,
    payload_name: str = "services/file_manager.py",
    symlink: bool = False,
    extra_directory: str | None = None,
) -> tuple[int, str]:
    with tarfile.open(path, "w:gz") as archive:
        if extra_directory:
            directory_info = tarfile.TarInfo(extra_directory)
            directory_info.type = tarfile.DIRTYPE
            archive.addfile(directory_info)
        manifest_data = json.dumps(manifest, sort_keys=True).encode("utf-8")
        manifest_info = tarfile.TarInfo("module-manifest.json")
        manifest_info.size = len(manifest_data)
        archive.addfile(manifest_info, io.BytesIO(manifest_data))

        payload_info = tarfile.TarInfo(f"payload/{payload_name}")
        if symlink:
            payload_info.type = tarfile.SYMTYPE
            payload_info.linkname = "/etc/passwd"
            archive.addfile(payload_info)
        else:
            payload_data = b"official module payload\n"
            payload_info.size = len(payload_data)
            archive.addfile(payload_info, io.BytesIO(payload_data))

    content = path.read_bytes()
    return len(content), hashlib.sha256(content).hexdigest()


def _catalog(*, size: int, sha256: str, **overrides: object) -> dict[str, object]:
    entry: dict[str, object] = {
        "id": "tool.files",
        "version": "1.2.3",
        "channel": "stable",
        "panel_api": "1",
        "module_api": "1",
        "min_core": "1.0.0",
        "architectures": ["aarch64"],
        "requires": ["core"],
        "conflicts": [],
        "requires_restart": True,
        "archive": "xkeen-module-tool.files-1.2.3.tar.gz",
        "size": size,
        "sha256": sha256,
        "signing_key_id": "release-2026",
    }
    entry.update(overrides)
    return entry


def test_valid_official_module_archive_passes_static_preflight(tmp_path: Path):
    archive_path = tmp_path / "tool-files.tar.gz"
    manifest = _manifest()
    size, digest = _write_archive(archive_path, manifest)
    catalog = _catalog(size=size, sha256=digest)

    validate_catalog_source(
        "https://github.com/umarcheh001/Xkeen-UI/releases/download/v1.2.3/catalog.json"
    )
    validate_catalog_entry(catalog)
    validate_catalog_entry(catalog, platform_architecture="aarch64", core_version="1.0.0")
    result = validate_module_archive(
        archive_path,
        catalog,
        platform_architecture="aarch64",
        core_version="1.0.0",
    )

    assert result == {
        "id": "tool.files",
        "version": "1.2.3",
        "payload_files": ["services/file_manager.py"],
    }


@pytest.mark.parametrize(
    ("source", "code"),
    [
        ("https://example.invalid/catalog.json", "catalog_source_not_official"),
        (
            "https://github.com/umarcheh001/Xkeen-UI/releases/download/v1/catalog.json?branch=main",
            "catalog_source_not_stable",
        ),
    ],
)
def test_catalog_source_rejects_non_official_or_mutable_urls(source: str, code: str):
    with pytest.raises(ModulePackageContractError, match=code):
        validate_catalog_source(source)


def test_catalog_entry_rejects_unsupported_api_and_external_archive_url():
    with pytest.raises(ModulePackageContractError, match="catalog_api_unsupported"):
        validate_catalog_entry(_catalog(size=1, sha256="a" * 64, panel_api="2"))

    with pytest.raises(ModulePackageContractError, match="catalog_archive_not_filename"):
        validate_catalog_entry(
            _catalog(size=1, sha256="a" * 64, archive="https://example.invalid/module.tar.gz")
        )

    with pytest.raises(ModulePackageContractError, match="catalog_signing_key_unknown"):
        validate_catalog_entry(
            _catalog(size=1, sha256="a" * 64),
            trusted_signing_key_ids={"future-rotated-key"},
        )

    with pytest.raises(ModulePackageContractError, match="catalog_signing_key_unknown"):
        validate_catalog_entry(_catalog(size=1, sha256="a" * 64, signing_key_id="untrusted-key"))

    with pytest.raises(ModulePackageContractError, match="catalog_architecture_unsupported"):
        validate_catalog_entry(
            _catalog(size=1, sha256="a" * 64),
            platform_architecture="armv7",
        )

    with pytest.raises(ModulePackageContractError, match="catalog_min_core_unsupported"):
        validate_catalog_entry(
            _catalog(size=1, sha256="a" * 64, min_core="1.2.0"),
            core_version="1.0.0",
        )


def test_archive_preflight_rejects_traversal_and_symlinks(tmp_path: Path):
    traversal = tmp_path / "traversal.tar.gz"
    size, digest = _write_archive(traversal, _manifest(), payload_name="../outside.py")
    with pytest.raises(ModulePackageContractError, match="archive_path_unsafe"):
        validate_module_archive(traversal, _catalog(size=size, sha256=digest))

    symlink = tmp_path / "symlink.tar.gz"
    size, digest = _write_archive(symlink, _manifest(), symlink=True)
    with pytest.raises(ModulePackageContractError, match="archive_link_forbidden"):
        validate_module_archive(symlink, _catalog(size=size, sha256=digest))

    extra_directory = tmp_path / "extra-directory.tar.gz"
    size, digest = _write_archive(extra_directory, _manifest(), extra_directory="unexpected")
    with pytest.raises(ModulePackageContractError, match="archive_layout_invalid"):
        validate_module_archive(extra_directory, _catalog(size=size, sha256=digest))


def test_archive_preflight_rejects_manifest_mismatch_and_hooks(tmp_path: Path):
    mismatched = tmp_path / "mismatched.tar.gz"
    size, digest = _write_archive(mismatched, _manifest(id="tool.editor"))
    with pytest.raises(ModulePackageContractError, match="manifest_identity_mismatch"):
        validate_module_archive(mismatched, _catalog(size=size, sha256=digest))

    hook = tmp_path / "hook.tar.gz"
    size, digest = _write_archive(
        hook,
        _manifest(ownership=["install.sh"]),
        payload_name="install.sh",
    )
    with pytest.raises(ModulePackageContractError, match="manifest_hook_forbidden"):
        validate_module_archive(hook, _catalog(size=size, sha256=digest))

    missing_limit = tmp_path / "missing-limit.tar.gz"
    manifest = _manifest()
    del manifest["max_size"]
    size, digest = _write_archive(missing_limit, manifest)
    with pytest.raises(ModulePackageContractError, match="manifest_required_field"):
        validate_module_archive(missing_limit, _catalog(size=size, sha256=digest))
