"""scripts/check_keys_upstream.py: compare the pinned key manifest with the author's main branch, update it on request.

No network and no real keys: the author's files are random bytes shaped like DER.
"""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import io
import json
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "xkeen-ui"
SCRIPT = ROOT / "scripts" / "check_keys_upstream.py"
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from services.happ_decryptor import keys  # noqa: E402

REPO = "LeeeeT/happ-decryptor"
PINNED = "a" * 40
LATEST = "b" * 40
RAW = "https://raw.githubusercontent.com/" + REPO + "/"
COMMIT_API = "https://api.github.com/repos/" + REPO + "/commits/main"


def _load():
    spec = importlib.util.spec_from_file_location("check_keys_upstream_under_test", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _der() -> str:
    return base64.b64encode(b"\x30\x82" + os.urandom(200)).decode()


def _files(table=None, legacy=None) -> dict[str, bytes]:
    table = table or {"vdAbCdEf": _der(), "Zx09Qw12": _der()}
    legacy = legacy or [_der() for _ in range(4)]
    rows = "\n".join(f'  "{k}",' for k in legacy)
    return {
        "public/data/crypt5-keys.json": json.dumps(table).encode(),
        "src/decrypt.js": f"const PKCS1_KEYS_B64 = [\n{rows}\n];\n".encode(),
    }


def _write_manifest(path: Path, files: dict[str, bytes], commit: str = PINNED) -> None:
    crypt5, js = files["public/data/crypt5-keys.json"], files["src/decrypt.js"]
    path.write_text(json.dumps({
        "schema": 1,
        "source": {"repo": REPO, "commit": commit},
        "files": [
            {"name": "crypt5-keys.json", "path": "public/data/crypt5-keys.json",
             "sha256": hashlib.sha256(crypt5).hexdigest(), "size": len(crypt5)},
            {"name": "legacy_keys.json", "path": "src/decrypt.js",
             "sha256": hashlib.sha256(js).hexdigest(), "size": len(js), "extract": "pkcs1_keys_b64"},
        ],
    }, indent=2) + "\n", encoding="utf-8")


class FakeGet:
    def __init__(self, by_url: dict[str, bytes]) -> None:
        self.by_url = by_url
        self.calls: list[str] = []

    def __call__(self, url: str, max_bytes: int) -> bytes:
        self.calls.append(url)
        if url not in self.by_url:
            raise OSError("http_404")
        return self.by_url[url]


def _upstream(main_files: dict[str, bytes]) -> dict[str, bytes]:
    by_url = {COMMIT_API: json.dumps({"sha": LATEST}).encode()}
    for ref in ("main", LATEST):
        for path, data in main_files.items():
            by_url[RAW + ref + "/" + path] = data
    return by_url


def _run(manifest: Path, get: FakeGet, *args: str) -> tuple[int, str]:
    out = io.StringIO()
    code = _load().main(["--manifest", str(manifest), *args], get=get, out=out)
    return code, out.getvalue()


def test_check_reports_unchanged_keys(tmp_path):
    files = _files()
    manifest = tmp_path / "keys_manifest.json"
    _write_manifest(manifest, files)

    code, text = _run(manifest, FakeGet(_upstream(files)))

    assert code == 0
    assert "не менялись" in text


def test_check_reports_changed_key_file(tmp_path):
    pinned = _files()
    manifest = tmp_path / "keys_manifest.json"
    _write_manifest(manifest, pinned)
    main_files = dict(pinned, **{"public/data/crypt5-keys.json": _files()["public/data/crypt5-keys.json"]})

    code, text = _run(manifest, FakeGet(_upstream(main_files)))

    assert code == 1
    assert "crypt5-keys.json" in text
    assert "legacy_keys.json" not in text.split("изменились", 1)[-1]


def test_update_pins_latest_commit_with_new_sizes_and_hashes(tmp_path):
    manifest = tmp_path / "keys_manifest.json"
    _write_manifest(manifest, _files())
    main_files = _files()

    code, _text = _run(manifest, FakeGet(_upstream(main_files)), "--update")

    assert code == 0
    updated = keys.parse_manifest(manifest.read_bytes())
    assert updated.commit == LATEST
    by_path = {item.path: item for item in updated.files}
    for path, data in main_files.items():
        assert by_path[path].sha256 == hashlib.sha256(data).hexdigest()
        assert by_path[path].size == len(data)
    assert by_path["src/decrypt.js"].extract == keys.EXTRACT_PKCS1_ARRAY
    assert manifest.read_text(encoding="utf-8").endswith("}\n")


def test_update_rejects_broken_key_file_and_keeps_manifest(tmp_path):
    manifest = tmp_path / "keys_manifest.json"
    _write_manifest(manifest, _files())
    before = manifest.read_bytes()
    main_files = dict(_files(), **{"public/data/crypt5-keys.json": b'{"vdAbCdEf": "not a key"}'})

    code, text = _run(manifest, FakeGet(_upstream(main_files)), "--update")

    assert code == 2
    assert manifest.read_bytes() == before
    assert "crypt5-keys.json" in text


def test_update_leaves_manifest_alone_when_keys_are_unchanged(tmp_path):
    files = _files()
    manifest = tmp_path / "keys_manifest.json"
    _write_manifest(manifest, files)
    before = manifest.read_bytes()

    code, text = _run(manifest, FakeGet(_upstream(files)), "--update")

    assert code == 0
    assert manifest.read_bytes() == before
    assert "не менялись" in text


@pytest.mark.parametrize("args", [(), ("--update",)])
def test_network_failure_is_reported_as_error(tmp_path, args):
    manifest = tmp_path / "keys_manifest.json"
    _write_manifest(manifest, _files())
    before = manifest.read_bytes()

    code, text = _run(manifest, FakeGet({}), *args)

    assert code == 2
    assert manifest.read_bytes() == before
    assert text.strip()


def test_default_manifest_is_the_one_the_panel_ships():
    assert Path(_load().DEFAULT_MANIFEST) == keys.BUNDLED_MANIFEST_PATH
