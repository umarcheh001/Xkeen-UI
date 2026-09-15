"""Happ key files: pinned manifest, checked download, extraction, validation, staged install.

No real Happ keys here: the tables are random bytes shaped like DER.
"""

from __future__ import annotations

import base64
import copy
import hashlib
import json
import os
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "xkeen-ui"
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from services.happ_decryptor import keys  # noqa: E402
from services.happ_decryptor.errors import HappDecryptorError  # noqa: E402


def _der() -> str:
    return base64.b64encode(b"\x30\x82" + os.urandom(200)).decode()


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _decrypt_js(key_list: list[str]) -> str:
    rows = "\n".join(f'  // key[{i}] — happ://crypt{i + 1}/\n  "{k}",' for i, k in enumerate(key_list))
    return f"import forge from 'node-forge';\n\nconst PKCS1_KEYS_B64 = [\n{rows}\n];\n\nconst other = ['x'];\n"


class FakeFetch:
    def __init__(self, by_url: dict[str, bytes]) -> None:
        self.by_url = by_url
        self.calls: list[tuple[str, int]] = []

    def __call__(self, url: str, dest: str, max_bytes: int) -> int:
        self.calls.append((url, max_bytes))
        if url not in self.by_url:
            raise RuntimeError("http_404")
        data = self.by_url[url]
        if len(data) > max_bytes:
            raise RuntimeError("size_limit")
        Path(dest).write_bytes(data)
        return len(data)


@pytest.fixture()
def upstream():
    table = {"vdAbCdEf": _der(), "Zx09Qw12": _der()}
    legacy = [_der() for _ in range(4)]
    crypt5_bytes = json.dumps(table).encode()
    js_bytes = _decrypt_js(legacy).encode()
    raw = {
        "schema": 1,
        "source": {"repo": "LeeeeT/happ-decryptor", "commit": "a" * 40},
        "files": [
            {"name": "crypt5-keys.json", "path": "public/data/crypt5-keys.json",
             "sha256": _sha(crypt5_bytes), "size": len(crypt5_bytes)},
            {"name": "legacy_keys.json", "path": "src/decrypt.js",
             "sha256": _sha(js_bytes), "size": len(js_bytes), "extract": "pkcs1_keys_b64"},
        ],
    }
    manifest = keys.parse_manifest(raw)
    base = "https://raw.githubusercontent.com/LeeeeT/happ-decryptor/" + "a" * 40 + "/"
    by_url = {base + "public/data/crypt5-keys.json": crypt5_bytes, base + "src/decrypt.js": js_bytes}
    return {"table": table, "legacy": legacy, "raw": raw, "manifest": manifest, "by_url": by_url}


def test_bundled_manifest_pins_author_commit_without_key_material():
    manifest = keys.load_bundled_manifest()
    assert manifest.repo == "LeeeeT/happ-decryptor"
    assert re.fullmatch(r"[0-9a-f]{40}", manifest.commit)
    assert {f.name for f in manifest.files} == set(keys.KEY_FILES)

    raw = keys.BUNDLED_MANIFEST_PATH.read_text(encoding="utf-8")
    assert len(raw) < 4096
    assert not re.search(r"[A-Za-z0-9+/]{100,}", raw), "the manifest must not carry keys"


def test_manifest_urls_point_to_the_pinned_commit():
    manifest = keys.load_bundled_manifest()
    for item in manifest.files:
        assert manifest.url_for(item) == f"https://raw.githubusercontent.com/{manifest.repo}/{manifest.commit}/{item.path}"


def _mutations():
    def commit_branch(m): m["source"]["commit"] = "main"
    def path_parent(m): m["files"][0]["path"] = "../secrets.json"
    def path_absolute(m): m["files"][0]["path"] = "/etc/passwd"
    def repo_traversal(m): m["source"]["repo"] = "LeeeeT/../evil"
    def bad_sha(m): m["files"][0]["sha256"] = "zz"
    def bad_extract(m): m["files"][1]["extract"] = "eval"
    def missing_legacy(m): m["files"].pop(1)
    def duplicate(m): m["files"][1] = copy.deepcopy(m["files"][0])
    def unknown_name(m): m["files"][0]["name"] = "../../bin/happ-decrypt-universal"
    def negative_size(m): m["files"][0]["size"] = -1
    def huge_size(m): m["files"][0]["size"] = 50 * 1024 * 1024
    def schema(m): m["schema"] = 2
    return [commit_branch, path_parent, path_absolute, repo_traversal, bad_sha, bad_extract,
            missing_legacy, duplicate, unknown_name, negative_size, huge_size, schema]


@pytest.mark.parametrize("mutate", _mutations(), ids=lambda f: f.__name__)
def test_parse_manifest_rejects_unsafe_or_incomplete(upstream, mutate):
    raw = copy.deepcopy(upstream["raw"])
    mutate(raw)
    with pytest.raises(HappDecryptorError) as exc:
        keys.parse_manifest(raw)
    assert exc.value.code == "bad_manifest"


def test_extract_legacy_keys_reads_the_array_despite_brackets_in_comments(upstream):
    assert keys.extract_legacy_keys(_decrypt_js(upstream["legacy"])) == upstream["legacy"]


def test_extract_legacy_keys_requires_exactly_four_keys(upstream):
    with pytest.raises(HappDecryptorError) as exc:
        keys.extract_legacy_keys(_decrypt_js(upstream["legacy"][:3]))
    assert exc.value.code == "bad_key_file"
    with pytest.raises(HappDecryptorError):
        keys.extract_legacy_keys("export const nothing = 1;")


@pytest.mark.parametrize(
    "table",
    [[], {}, {"short": "AAAA"}, {"vdAbCdEf": "not base64!"}, {"vdAbCdEf": base64.b64encode(b"hello").decode()}],
    ids=["list", "empty", "bad-marker", "not-base64", "not-der"],
)
def test_validate_crypt5_table_rejects_malformed(table):
    with pytest.raises(HappDecryptorError) as exc:
        keys.validate_crypt5_table(table)
    assert exc.value.code == "bad_key_file"


def test_validate_legacy_table_requires_four_der_keys(upstream):
    assert keys.validate_legacy_table(upstream["legacy"]) == upstream["legacy"]
    for bad in ({}, upstream["legacy"][:3], upstream["legacy"][:3] + ["AAAA"]):
        with pytest.raises(HappDecryptorError):
            keys.validate_legacy_table(bad)


def test_download_keys_checks_sizes_and_checksums_and_extracts_legacy(upstream, tmp_path):
    fetch = FakeFetch(upstream["by_url"])
    files = keys.download_keys(upstream["manifest"], fetch, str(tmp_path))

    assert json.loads(files[keys.CRYPT5_FILE]) == upstream["table"]
    assert json.loads(files[keys.LEGACY_FILE]) == upstream["legacy"]
    sizes = {item.path: item.size for item in upstream["manifest"].files}
    for url, max_bytes in fetch.calls:
        assert max_bytes == sizes[url.split("/" + "a" * 40 + "/", 1)[1]]
    assert list(tmp_path.iterdir()) == [], "downloads must be cleaned up"


def test_download_keys_rejects_checksum_mismatch(upstream, tmp_path):
    by_url = dict(upstream["by_url"])
    url = next(iter(by_url))
    by_url[url] = by_url[url].replace(b"vdAbCdEf", b"vdAbCdEF")
    with pytest.raises(HappDecryptorError) as exc:
        keys.download_keys(upstream["manifest"], FakeFetch(by_url), str(tmp_path))
    assert exc.value.code == "checksum_mismatch"


def test_download_keys_reports_unreachable_source(upstream, tmp_path):
    with pytest.raises(HappDecryptorError) as exc:
        keys.download_keys(upstream["manifest"], FakeFetch({}), str(tmp_path))
    assert exc.value.code == "download_failed"


def test_resolve_manifest_prefers_the_published_copy(upstream, tmp_path):
    url = "https://raw.githubusercontent.com/umarcheh001/Xkeen-UI/main/manifest.json"
    fetch = FakeFetch({url: json.dumps(upstream["raw"]).encode()})
    manifest, source = keys.resolve_manifest(fetch, str(tmp_path), url=url)
    assert (manifest, source) == (upstream["manifest"], "remote")


@pytest.mark.parametrize("payload", [None, b"{not json", b'{"schema": 9}'], ids=["unreachable", "broken", "invalid"])
def test_resolve_manifest_falls_back_to_the_bundled_copy(tmp_path, payload):
    url = "https://raw.githubusercontent.com/umarcheh001/Xkeen-UI/main/manifest.json"
    fetch = FakeFetch({} if payload is None else {url: payload})
    manifest, source = keys.resolve_manifest(fetch, str(tmp_path), url=url)
    assert (manifest, source) == (keys.load_bundled_manifest(), "bundled")


def test_classify_key_upload_recognises_all_supported_files(upstream):
    table_bytes = json.dumps(upstream["table"]).encode()
    legacy_bytes = json.dumps(upstream["legacy"]).encode()
    js_bytes = _decrypt_js(upstream["legacy"]).encode()

    assert keys.classify_key_upload("crypt5-keys.json", table_bytes) == (keys.CRYPT5_FILE, table_bytes)
    assert keys.classify_key_upload("whatever.json", legacy_bytes) == (keys.LEGACY_FILE, legacy_bytes)
    name, content = keys.classify_key_upload("decrypt.js", js_bytes)
    assert name == keys.LEGACY_FILE and json.loads(content) == upstream["legacy"]


@pytest.mark.parametrize("data", [b"\x7fELF\x02\x01", b"<html>blocked</html>", b'{"vdAbCdEf": 1}', b""])
def test_classify_key_upload_rejects_other_files(data):
    with pytest.raises(HappDecryptorError) as exc:
        keys.classify_key_upload("file", data)
    assert exc.value.code in {"bad_key_file", "unrecognized_key_file"}


def test_install_key_files_replaces_files_and_records_their_origin(upstream, tmp_path):
    assets = tmp_path / "happ-decrypt-universal.assets"
    assets.mkdir()
    (assets / keys.CRYPT5_FILE).write_bytes(b'{"old": "x"}')
    (assets / "keytable.json").write_text("emulator data of the old Node decryptor")
    new = {keys.CRYPT5_FILE: json.dumps(upstream["table"]).encode(),
           keys.LEGACY_FILE: json.dumps(upstream["legacy"]).encode()}

    result = keys.install_key_files(str(assets), new, meta={"source": "manifest", "repo": "LeeeeT/happ-decryptor", "commit": "a" * 40})

    assert sorted(result["installed"]) == sorted(keys.KEY_FILES)
    for name, data in new.items():
        assert (assets / name).read_bytes() == data
    assert (assets / (keys.CRYPT5_FILE + ".bak")).read_bytes() == b'{"old": "x"}'
    assert (assets / "keytable.json").exists(), "unrelated files stay"
    meta = json.loads((assets / keys.META_FILE).read_text(encoding="utf-8"))
    for name, data in new.items():
        assert meta["files"][name]["sha256"] == _sha(data)
        assert meta["files"][name]["commit"] == "a" * 40
        assert meta["files"][name]["source"] == "manifest"
        assert meta["files"][name]["installed_at"]
    assert not [p for p in assets.iterdir() if p.name.startswith(".")], "no staging leftovers"


def test_install_key_files_verifies_the_complete_candidate_set(upstream, tmp_path):
    assets = tmp_path / "assets"
    assets.mkdir()
    legacy_bytes = json.dumps(upstream["legacy"]).encode()
    (assets / keys.LEGACY_FILE).write_bytes(legacy_bytes)
    seen = {}

    def verify(staging: str) -> None:
        seen.update({p.name: p.read_bytes() for p in Path(staging).iterdir()})

    crypt5_bytes = json.dumps(upstream["table"]).encode()
    keys.install_key_files(str(assets), {keys.CRYPT5_FILE: crypt5_bytes}, meta={"source": "upload"}, verify=verify)

    assert seen == {keys.CRYPT5_FILE: crypt5_bytes, keys.LEGACY_FILE: legacy_bytes}
    meta = json.loads((assets / keys.META_FILE).read_text(encoding="utf-8"))
    assert set(meta["files"]) == {keys.CRYPT5_FILE}


def test_install_key_files_keeps_old_files_when_verification_fails(upstream, tmp_path):
    assets = tmp_path / "assets"
    assets.mkdir()
    (assets / keys.CRYPT5_FILE).write_bytes(b"old")

    def verify(_staging: str) -> None:
        raise HappDecryptorError("keys_check_failed", "Движок не принял ключи.")

    with pytest.raises(HappDecryptorError):
        keys.install_key_files(str(assets), {keys.CRYPT5_FILE: json.dumps(upstream["table"]).encode()},
                               meta={"source": "upload"}, verify=verify)

    assert (assets / keys.CRYPT5_FILE).read_bytes() == b"old"
    assert sorted(p.name for p in assets.iterdir()) == [keys.CRYPT5_FILE]


def test_install_key_files_accepts_only_known_names(tmp_path):
    with pytest.raises(ValueError):
        keys.install_key_files(str(tmp_path), {"../happ-decrypt-universal": b"x"}, meta={})
