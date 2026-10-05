from __future__ import annotations

import io
import tarfile
from pathlib import Path

import pytest

from services.module_transactions.extract import extract_payload
from services.module_transactions.state import ModuleTransactionError


def _archive(path: Path, members: list[tuple[str, bytes | None, str]]) -> Path:
    """members: (name, payload, kind) where kind is file / dir / symlink / hardlink."""

    with tarfile.open(path, "w:gz") as archive:
        for name, payload, kind in members:
            info = tarfile.TarInfo(name)
            if kind == "dir":
                info.type = tarfile.DIRTYPE
                archive.addfile(info)
            elif kind == "symlink":
                info.type = tarfile.SYMTYPE
                info.linkname = "../../outside"
                archive.addfile(info)
            elif kind == "hardlink":
                info.type = tarfile.LNKTYPE
                info.linkname = "payload/a.txt"
                archive.addfile(info)
            else:
                info.size = len(payload or b"")
                archive.addfile(info, io.BytesIO(payload or b""))
    return path


def test_extract_takes_only_requested_files(tmp_path: Path) -> None:
    archive = _archive(
        tmp_path / "m.tar.gz",
        [
            ("module-manifest.json", b"{}", "file"),
            ("payload", None, "dir"),
            ("payload/static", None, "dir"),
            ("payload/static/a.js", b"A", "file"),
            ("payload/static/b.js", b"B", "file"),
            ("payload/routes/c.py", b"C", "file"),
        ],
    )
    destination = tmp_path / "staging"

    extracted = extract_payload(archive, destination, ["static/a.js", "routes/c.py"])

    assert extracted == ("routes/c.py", "static/a.js")
    assert (destination / "static" / "a.js").read_bytes() == b"A"
    assert (destination / "routes" / "c.py").read_bytes() == b"C"
    assert not (destination / "static" / "b.js").exists()
    assert not (destination / "module-manifest.json").exists()


def test_extract_reports_a_requested_file_the_archive_lacks(tmp_path: Path) -> None:
    archive = _archive(tmp_path / "m.tar.gz", [("payload/static/a.js", b"A", "file")])

    with pytest.raises(ModuleTransactionError) as raised:
        extract_payload(archive, tmp_path / "staging", ["static/a.js", "static/missing.js"])

    assert raised.value.code == "archive_member_missing"
    assert raised.value.details["paths"] == ["static/missing.js"]


@pytest.mark.parametrize(
    "name",
    ["payload/../escape.py", "/payload/abs.py", "payload//double.py", "payload/./dot.py", "payload\\back.py"],
)
def test_extract_rejects_unsafe_member_names(tmp_path: Path, name: str) -> None:
    archive = _archive(tmp_path / "m.tar.gz", [(name, b"x", "file")])

    with pytest.raises(ModuleTransactionError) as raised:
        extract_payload(archive, tmp_path / "staging", ["escape.py", "abs.py", "double.py", "dot.py", "back.py"])

    assert raised.value.code == "archive_path_unsafe"
    assert not (tmp_path / "escape.py").exists()


@pytest.mark.parametrize("kind", ["symlink", "hardlink"])
def test_extract_rejects_links(tmp_path: Path, kind: str) -> None:
    archive = _archive(
        tmp_path / "m.tar.gz",
        [("payload/a.txt", b"A", "file"), ("payload/link.txt", None, kind)],
    )

    with pytest.raises(ModuleTransactionError) as raised:
        extract_payload(archive, tmp_path / "staging", ["a.txt", "link.txt"])

    assert raised.value.code == "archive_link_forbidden"


def test_extract_rejects_an_unsafe_requested_path(tmp_path: Path) -> None:
    archive = _archive(tmp_path / "m.tar.gz", [("payload/a.txt", b"A", "file")])

    with pytest.raises(ModuleTransactionError) as raised:
        extract_payload(archive, tmp_path / "staging", ["../a.txt"])

    assert raised.value.code == "archive_path_unsafe"


def test_extract_reports_a_broken_archive(tmp_path: Path) -> None:
    broken = tmp_path / "m.tar.gz"
    broken.write_bytes(b"not a gzip stream")

    with pytest.raises(ModuleTransactionError) as raised:
        extract_payload(broken, tmp_path / "staging", ["a.txt"])

    assert raised.value.code == "archive_invalid"
