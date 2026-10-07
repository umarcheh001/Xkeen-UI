from __future__ import annotations

import hashlib
import io
import json
import tarfile
from pathlib import Path

import pytest

from services.module_package_contract import (
    CATALOG_ARCHITECTURES,
    ModulePackageContractError,
    compare_semver,
    detect_platform_architecture,
    validate_catalog_document,
    validate_catalog_entry,
    validate_catalog_source,
    validate_module_archive,
    validate_semver,
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


def _catalog_document(*, modules: object | None = None, **overrides: object) -> dict[str, object]:
    document: dict[str, object] = {
        "schema_version": 1,
        "release_version": "1.2.3",
        "channel": "stable",
        "source_commit": "a" * 40,
        "panel": {
            "archive": "xkeen-ui-panel-1.2.3.tar.gz",
            "size": 3,
            "sha256": "b" * 64,
            "version": "1.2.3",
            "signing_key_id": "release-2026",
            "architectures": ["aarch64"],
        },
        "modules": [
            _catalog(
                size=1,
                sha256="a" * 64,
            )
        ]
        if modules is None
        else modules,
    }
    document.update(overrides)
    return document


def test_compare_semver_orders_prereleases_before_final_releases() -> None:
    assert compare_semver("1.0.0-alpha", "1.0.0") == -1
    assert compare_semver("1.0.0", "1.0.0-alpha") == 1
    assert compare_semver("1.0.0", "1.0.0") == 0
    assert compare_semver("1.0.1", "1.0.0") == 1


@pytest.mark.parametrize("version", ("1.0.0-01", "1.0.0-alpha.002"))
def test_validate_semver_rejects_numeric_prerelease_identifiers_with_leading_zero(version: str) -> None:
    with pytest.raises(ModulePackageContractError, match="version_invalid"):
        validate_semver(version, "version")


def test_catalog_document_validates_top_level_and_entry_key_identity() -> None:
    document = _catalog_document()

    normalized = validate_catalog_document(
        document,
        release_version="1.2.3",
        signing_key_id="release-2026",
        platform_architecture="aarch64",
        core_version="1.0.0",
    )

    assert normalized == document
    assert normalized is not document
    assert normalized["modules"] is not document["modules"]
    assert normalized["panel"] is not document["panel"]


@pytest.mark.parametrize(
    ("panel", "code"),
    [
        (None, "catalog_required_field"),
        ({}, "catalog_panel_required_field"),
        (
            {
                "archive": "xkeen-ui-panel-1.2.3.tar.gz",
                "size": 3,
                "sha256": "b" * 64,
                "version": "1.2.3",
                "signing_key_id": "release-2026",
                "architectures": ["aarch64"],
                "unexpected": True,
            },
            "catalog_panel_field_unknown",
        ),
        (
            {
                "archive": "xkeen-ui-panel-1.2.3.tar.gz",
                "size": 3,
                "sha256": "b" * 64,
                "version": "1.2.4",
                "signing_key_id": "release-2026",
                "architectures": ["aarch64"],
            },
            "catalog_panel_version_mismatch",
        ),
        (
            {
                "archive": "xkeen-ui-panel-1.2.3.tar.gz",
                "size": 3,
                "sha256": "b" * 64,
                "version": "1.2.3",
                "signing_key_id": "release-2026",
                "architectures": ["mips"],
            },
            "catalog_architecture_unsupported",
        ),
    ],
)
def test_catalog_document_rejects_invalid_panel_descriptor(panel: object, code: str) -> None:
    document = _catalog_document()
    if panel is None:
        del document["panel"]
    else:
        document["panel"] = panel

    with pytest.raises(ModulePackageContractError, match=code):
        validate_catalog_document(
            document,
            release_version="1.2.3",
            signing_key_id="release-2026",
            platform_architecture="aarch64",
        )


@pytest.mark.parametrize(
    ("document", "release_version", "code"),
    [
        (_catalog_document(modules=[]), "1.2.3", "catalog_modules_empty"),
        (_catalog_document(modules={}), "1.2.3", "catalog_modules_invalid"),
        (_catalog_document(channel="preview"), "1.2.3", "catalog_channel_unsupported"),
        (_catalog_document(release_version="1.2.4"), "1.2.3", "catalog_release_version_mismatch"),
        (_catalog_document(source_commit=""), "1.2.3", "catalog_source_commit_invalid"),
    ],
)
def test_catalog_document_rejects_invalid_top_level_shape(
    document: dict[str, object], release_version: str, code: str
) -> None:
    with pytest.raises(ModulePackageContractError, match=code):
        validate_catalog_document(
            document,
            release_version=release_version,
            signing_key_id="release-2026",
        )


def test_catalog_document_rejects_duplicate_module_ids() -> None:
    entry = _catalog(size=1, sha256="a" * 64)
    document = _catalog_document(modules=[entry, dict(entry)])

    with pytest.raises(ModulePackageContractError, match="catalog_module_duplicate"):
        validate_catalog_document(
            document,
            release_version="1.2.3",
            signing_key_id="release-2026",
        )


def test_catalog_document_rejects_entry_key_different_from_verified_envelope() -> None:
    document = _catalog_document(
        modules=[_catalog(size=1, sha256="a" * 64, signing_key_id="rotated-2027")]
    )

    with pytest.raises(ModulePackageContractError, match="catalog_signing_key_mismatch"):
        validate_catalog_document(
            document,
            release_version="1.2.3",
            signing_key_id="release-2026",
            trusted_signing_key_ids={"release-2026", "rotated-2027"},
        )


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


@pytest.mark.parametrize(
    ("machine", "byteorder", "expected"),
    [
        ("aarch64", "little", "aarch64"),
        ("arm64", "little", "aarch64"),
        # Keenetic answers "mips" on both byte orders: the byte order decides.
        ("mips", "little", "mipsel"),
        ("mips", "big", "mips"),
        ("mipsel", "big", "mipsel"),
        ("mipsle", "little", "mipsel"),
        ("MIPS", "little", "mipsel"),
    ],
)
def test_platform_architecture_is_normalized_to_a_catalog_id(machine: str, byteorder: str, expected: str) -> None:
    assert detect_platform_architecture(machine=machine, byteorder=byteorder) == expected
    assert expected in CATALOG_ARCHITECTURES


@pytest.mark.parametrize("machine", ["x86_64", "AMD64", "armv7l", "mips64", "mips64el", ""])
def test_platform_architecture_outside_the_catalog_is_refused(machine: str) -> None:
    with pytest.raises(ModulePackageContractError, match="platform_architecture_unsupported"):
        detect_platform_architecture(machine=machine, byteorder="little")


def test_detected_architecture_is_accepted_by_a_catalog_entry_for_every_router() -> None:
    catalog = _catalog(size=1, sha256="a" * 64, architectures=list(CATALOG_ARCHITECTURES))
    for machine, byteorder in (("aarch64", "little"), ("mips", "little"), ("mips", "big")):
        architecture = detect_platform_architecture(machine=machine, byteorder=byteorder)
        assert validate_catalog_entry(catalog, platform_architecture=architecture, core_version="1.0.0")
