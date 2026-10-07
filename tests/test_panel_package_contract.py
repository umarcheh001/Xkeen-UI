from __future__ import annotations

import hashlib
import io
import json
import tarfile
from pathlib import Path

import pytest

from services.module_package_contract import ModulePackageContractError
from services.panel_package_contract import validate_panel_archive


def _ownership(*paths: str) -> bytes:
    return (
        json.dumps(
            {"schema_version": 1, "modules": {"core": list(paths)}, "frontend": {"bridge": {}, "build": {}}},
            sort_keys=True,
        )
        + "\n"
    ).encode("utf-8")


def _write_panel(
    path: Path,
    *,
    files: list[tuple[str, bytes | None, bytes | str]] | None = None,
) -> dict[str, object]:
    members = files or [
        ("xkeen-ui/app.py", b"print('ready')\n", b"file"),
        (
            "xkeen-ui/module-ownership.json",
            _ownership("app.py", "module-ownership.json"),
            b"file",
        ),
    ]
    with tarfile.open(path, "w:gz") as archive:
        for name, data, kind in members:
            info = tarfile.TarInfo(name)
            if kind == b"dir":
                info.type = tarfile.DIRTYPE
                archive.addfile(info)
            elif kind == b"symlink":
                info.type = tarfile.SYMTYPE
                info.linkname = str(data)
                archive.addfile(info)
            elif kind == b"hardlink":
                info.type = tarfile.LNKTYPE
                info.linkname = str(data)
                archive.addfile(info)
            else:
                payload = bytes(data or b"")
                info.size = len(payload)
                archive.addfile(info, io.BytesIO(payload))
    content = path.read_bytes()
    return {
        "archive": "xkeen-ui-panel-1.2.3.tar.gz",
        "size": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
        "version": "1.2.3",
        "signing_key_id": "release-2026",
        "architectures": ["aarch64"],
    }


def test_valid_panel_archive_returns_normalized_payload_and_ownership(tmp_path: Path) -> None:
    path = tmp_path / "xkeen-ui-panel-1.2.3.tar.gz"
    descriptor = _write_panel(path)

    checked = validate_panel_archive(path, descriptor, platform_architecture="aarch64")

    assert checked == {
        "root": "xkeen-ui",
        "payload_files": ["app.py", "module-ownership.json"],
        "expanded_size": 136,
        "payload_sizes": {"app.py": 15, "module-ownership.json": 121},
        "payload_digests": {
            "app.py": hashlib.sha256(b"print('ready')\n").hexdigest(),
            "module-ownership.json": hashlib.sha256(_ownership("app.py", "module-ownership.json")).hexdigest(),
        },
        "payload_executable": [],
        "ownership": {
            "schema_version": 1,
            "modules": {"core": ["app.py", "module-ownership.json"]},
            "frontend": {"bridge": {}, "build": {}},
        },
    }


@pytest.mark.parametrize(
    ("members", "code"),
    [
        (
            [
                ("xkeen-ui/../escape", b"bad", b"file"),
                ("xkeen-ui/module-ownership.json", _ownership("../escape", "module-ownership.json"), b"file"),
            ],
            "panel_archive_path_unsafe",
        ),
        (
            [
                ("/xkeen-ui/app.py", b"bad", b"file"),
                ("xkeen-ui/module-ownership.json", _ownership("module-ownership.json"), b"file"),
            ],
            "panel_archive_path_unsafe",
        ),
        (
            [
                ("xkeen-ui/app.py", b"one", b"file"),
                ("xkeen-ui/app.py", b"two", b"file"),
                ("xkeen-ui/module-ownership.json", _ownership("app.py", "module-ownership.json"), b"file"),
            ],
            "panel_archive_member_duplicate",
        ),
        (
            [
                ("xkeen-ui/app.py", "/etc/passwd", b"symlink"),
                ("xkeen-ui/module-ownership.json", _ownership("app.py", "module-ownership.json"), b"file"),
            ],
            "panel_archive_member_type_forbidden",
        ),
        (
            [
                ("xkeen-ui/app.py", "xkeen-ui/other.py", b"hardlink"),
                ("xkeen-ui/module-ownership.json", _ownership("app.py", "module-ownership.json"), b"file"),
            ],
            "panel_archive_member_type_forbidden",
        ),
        (
            [
                ("xkeen-ui/app.py", b"ok", b"file"),
                ("other/file.py", b"bad", b"file"),
                ("xkeen-ui/module-ownership.json", _ownership("app.py", "module-ownership.json"), b"file"),
            ],
            "panel_archive_root_invalid",
        ),
        (
            [
                ("xkeen-ui/secret.key", b"private", b"file"),
                ("xkeen-ui/module-ownership.json", _ownership("module-ownership.json"), b"file"),
            ],
            "panel_archive_user_path_forbidden",
        ),
        (
            [
                ("xkeen-ui/app.py", b"ok", b"file"),
                ("xkeen-ui/module-ownership.json", _ownership("module-ownership.json"), b"file"),
            ],
            "panel_archive_ownership_mismatch",
        ),
    ],
)
def test_panel_archive_rejects_unsafe_members(
    tmp_path: Path,
    members: list[tuple[str, bytes | None, bytes | str]],
    code: str,
) -> None:
    path = tmp_path / "xkeen-ui-panel-1.2.3.tar.gz"
    descriptor = _write_panel(path, files=members)

    with pytest.raises(ModulePackageContractError, match=code):
        validate_panel_archive(path, descriptor, platform_architecture="aarch64")


def test_panel_archive_rejects_unsupported_architecture_before_reading(tmp_path: Path) -> None:
    path = tmp_path / "xkeen-ui-panel-1.2.3.tar.gz"
    descriptor = _write_panel(path)

    with pytest.raises(ModulePackageContractError, match="catalog_architecture_unsupported"):
        validate_panel_archive(path, descriptor, platform_architecture="mips")
