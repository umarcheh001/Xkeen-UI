"""A local drop-in Happ decryptor must not travel in the user archive.

install.sh copies the archive over /opt/etc/xkeen-ui with rsync, so an old Node
decryptor lying in the developer's xkeen-ui/bin/ would overwrite the Go engine
a tester installed from the panel, and its .assets/ carry Happ key material.
The engine and its keys are installed on the router instead (services/happ_decryptor).
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT / "scripts" / "build_user_archive.py"


def _load_builder():
    name = "build_user_archive_local_decryptor_test"
    spec = importlib.util.spec_from_file_location(name, SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


KEPT = {
    "bin/README.happ-decryptor.txt",
    "bin/xk-geodat",
    "services/happ_decryptor/engine.py",
    "services/happ_decryptor/keys_manifest.json",
    "routes/happ_decryptor.py",
    "scripts/install_happ_decryptor.py",
    "scripts/happ_transport_helper.py",
}
DROPPED = {
    "bin/happ-decrypt-universal",
    "bin/happ-decrypt-universal.bak",
    "bin/happ-decrypt-universal.assets/keytable.json",
    "bin/happ-decrypt-universal.assets/crypt5-keys.json",
    "bin/happ_decryptor.py",
    "bin/Happwner.py",
    "bin/happwner",
}


def test_local_decryptor_files_stay_out_of_the_user_archive(tmp_path, monkeypatch):
    builder = _load_builder()
    src = tmp_path / "src" / "xkeen-ui"
    for rel in KEPT | DROPPED:
        path = src / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(rel, encoding="utf-8")
    monkeypatch.setattr(builder, "PROJECT_ROOT", src.resolve())

    dst = tmp_path / "package" / "xkeen-ui"
    builder.copy_project_tree(src, dst)

    packed = {p.relative_to(dst).as_posix() for p in dst.rglob("*") if p.is_file()}
    assert packed == KEPT
    assert not (dst / "bin" / "happ-decrypt-universal.assets").exists()
