"""/api/happ-decryptor/*: status, install from release or upload, key update and key upload."""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import struct
import sys
from pathlib import Path

import pytest
from flask import Flask

ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "xkeen-ui"
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from routes.happ_decryptor import create_happ_decryptor_blueprint  # noqa: E402
from services.happ_decryptor import engine, keys  # noqa: E402

ARM64 = "happ-decrypt-universal-linux-arm64"
COMMIT = "b" * 40
RAW = f"https://raw.githubusercontent.com/LeeeeT/happ-decryptor/{COMMIT}/"
FULL_SELFTEST = {
    "formats": ["crypt", "crypt2", "crypt3", "crypt4", "crypt5"],
    "crypt5_keys": {"present": True, "keys": 1, "invalid": 0},
    "legacy_keys": {"present": True, "keys": 4, "invalid": 0},
}


def _der() -> str:
    return base64.b64encode(b"\x30\x82" + os.urandom(200)).decode()


def _decrypt_js(key_list):
    rows = "\n".join(f'  // key[{i}]\n  "{k}",' for i, k in enumerate(key_list))
    return f"const PKCS1_KEYS_B64 = [\n{rows}\n];\n"


def _arm64_elf() -> bytes:
    return b"\x7fELF\x02\x01\x01" + b"\0" * 11 + struct.pack("<H", 183) + os.urandom(512)


class FakeFetch:
    def __init__(self, by_url):
        self.by_url = by_url
        self.calls = []

    def __call__(self, url, dest, max_bytes):
        self.calls.append(url)
        if url not in self.by_url:
            raise RuntimeError("http_404")
        Path(dest).write_bytes(self.by_url[url])
        return len(self.by_url[url])


class FakeRun:
    def __init__(self, selftest=FULL_SELFTEST):
        self.selftest = selftest
        self.calls = []

    def __call__(self, argv, timeout):
        self.calls.append(list(argv))
        if "-version" in argv:
            return 0, "happ-decrypt-universal v1.0.0 (abc1234)\n", ""
        if "-selftest" in argv:
            return 0, json.dumps(self.selftest), ""
        return 2, "", ""


@pytest.fixture()
def world(tmp_path, monkeypatch):
    monkeypatch.delenv(keys.MANIFEST_URL_ENV, raising=False)
    monkeypatch.delenv(engine.RELEASE_URL_ENV, raising=False)
    table = {"vdAbCdEf": _der()}
    legacy = [_der() for _ in range(4)]
    crypt5 = json.dumps(table).encode()
    js = _decrypt_js(legacy).encode()
    manifest = {
        "schema": 1,
        "source": {"repo": "LeeeeT/happ-decryptor", "commit": COMMIT},
        "files": [
            {"name": "crypt5-keys.json", "path": "public/data/crypt5-keys.json",
             "sha256": hashlib.sha256(crypt5).hexdigest(), "size": len(crypt5)},
            {"name": "legacy_keys.json", "path": "src/decrypt.js",
             "sha256": hashlib.sha256(js).hexdigest(), "size": len(js), "extract": "pkcs1_keys_b64"},
        ],
    }
    binary = _arm64_elf()
    sums = f"{hashlib.sha256(binary).hexdigest()}  dist/{ARM64}\n".encode()
    by_url = {
        keys.DEFAULT_MANIFEST_URL: json.dumps(manifest).encode(),
        RAW + "public/data/crypt5-keys.json": crypt5,
        RAW + "src/decrypt.js": js,
        engine.DEFAULT_RELEASE_URL + ARM64: binary,
        engine.DEFAULT_RELEASE_URL + "SHA256SUMS": sums,
    }
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    return {
        "bin": bin_dir / "happ-decrypt-universal", "assets": bin_dir / "happ-decrypt-universal.assets",
        "binary": binary, "crypt5": crypt5, "js": js, "table": table, "legacy": legacy, "by_url": by_url,
    }


def _client(world, fetch, run, platform=None):
    app = Flask("happ-decryptor-test")
    app.register_blueprint(create_happ_decryptor_blueprint(
        bin_path=str(world["bin"]),
        fetch=fetch,
        run=run,
        platform=platform or (lambda: {"asset": ARM64, "supported": True}),
    ))
    return app.test_client()


def test_status_without_engine(world):
    resp = _client(world, FakeFetch({}), FakeRun()).get("/api/happ-decryptor/status")
    body = resp.get_json()
    assert resp.status_code == 200 and body["ok"] is True
    assert body["status"]["kind"] == "missing" and body["status"]["installed"] is False


def test_install_puts_engine_and_keys_in_place(world):
    fetch = FakeFetch(world["by_url"])
    body = _client(world, fetch, FakeRun()).post("/api/happ-decryptor/install", json={}).get_json()

    assert body["ok"] is True, body
    assert world["bin"].read_bytes() == world["binary"]
    assert (world["assets"] / "crypt5-keys.json").read_bytes() == world["crypt5"]
    assert json.loads((world["assets"] / "legacy_keys.json").read_text()) == world["legacy"]
    meta = json.loads((world["assets"] / "happ-keys.json").read_text(encoding="utf-8"))
    assert meta["files"]["crypt5-keys.json"]["commit"] == COMMIT
    assert body["keys"]["manifest"] == {"repo": "LeeeeT/happ-decryptor", "commit": COMMIT, "source": "remote"}
    assert body["engine"]["version"] == "happ-decrypt-universal v1.0.0 (abc1234)"
    assert body["status"]["installed"] is True


def test_install_can_skip_keys(world):
    fetch = FakeFetch(world["by_url"])
    body = _client(world, fetch, FakeRun()).post("/api/happ-decryptor/install", json={"keys": False}).get_json()

    assert body["ok"] is True and "keys" not in body
    assert not world["assets"].exists()
    assert not [u for u in fetch.calls if "raw.githubusercontent.com" in u]


def test_install_reports_expected_failure_with_code_and_hint(world):
    by_url = dict(world["by_url"])
    del by_url[engine.DEFAULT_RELEASE_URL + "SHA256SUMS"]
    body = _client(world, FakeFetch(by_url), FakeRun()).post("/api/happ-decryptor/install", json={}).get_json()

    assert body["ok"] is False and body["error"] == "checksum_missing"
    assert body["hint"] and "status" in body
    assert not world["bin"].exists()


def test_install_hides_unexpected_errors(world):
    def broken_platform():
        raise RuntimeError("secret crash at /opt/etc/xkeen-ui/bin")

    resp = _client(world, FakeFetch(world["by_url"]), FakeRun(), platform=broken_platform).post(
        "/api/happ-decryptor/install", json={}
    )
    raw = resp.get_data(as_text=True)
    assert resp.status_code == 200
    assert resp.get_json()["error"] == "internal_error"
    assert "secret" not in raw and "/opt/etc" not in raw


def test_install_from_uploaded_binary(world):
    fetch = FakeFetch(world["by_url"])
    upload = _arm64_elf()
    body = _client(world, fetch, FakeRun()).post(
        "/api/happ-decryptor/install",
        data={"file": (io.BytesIO(upload), "happ-decrypt-universal-linux-arm64")},
        content_type="multipart/form-data",
    ).get_json()

    assert body["ok"] is True, body
    assert fetch.calls == []
    assert world["bin"].read_bytes() == upload


def test_update_keys_lets_the_installed_engine_check_them(world):
    world["bin"].write_bytes(world["binary"])
    run = FakeRun()
    body = _client(world, FakeFetch(world["by_url"]), run).post("/api/happ-decryptor/keys", json={}).get_json()

    assert body["ok"] is True, body
    selftests = [c for c in run.calls if "-selftest" in c]
    assert selftests and selftests[0][-1] != str(world["assets"]), "keys are checked before they are swapped in"
    assert (world["assets"] / "crypt5-keys.json").read_bytes() == world["crypt5"]


def test_update_keys_rejected_by_engine_leaves_old_keys(world):
    world["bin"].write_bytes(world["binary"])
    world["assets"].mkdir()
    (world["assets"] / "crypt5-keys.json").write_bytes(b"old keys")
    run = FakeRun(selftest={**FULL_SELFTEST, "crypt5_keys": {"present": True, "keys": 1, "invalid": 1}})

    body = _client(world, FakeFetch(world["by_url"]), run).post("/api/happ-decryptor/keys", json={}).get_json()

    assert body["ok"] is False and body["error"] == "keys_check_failed"
    assert (world["assets"] / "crypt5-keys.json").read_bytes() == b"old keys"


def test_upload_keys_accepts_json_and_decrypt_js(world):
    body = _client(world, FakeFetch({}), FakeRun()).post(
        "/api/happ-decryptor/keys/upload",
        data={"file": [(io.BytesIO(world["crypt5"]), "crypt5-keys.json"), (io.BytesIO(world["js"]), "decrypt.js")]},
        content_type="multipart/form-data",
    ).get_json()

    assert body["ok"] is True, body
    assert sorted(body["keys"]["installed"]) == ["crypt5-keys.json", "legacy_keys.json"]
    meta = json.loads((world["assets"] / "happ-keys.json").read_text(encoding="utf-8"))
    assert {entry["source"] for entry in meta["files"].values()} == {"upload"}


@pytest.mark.parametrize(
    "files,code",
    [
        ([(b"<html>blocked</html>", "keys.json")], "unrecognized_key_file"),
        ([], "no_files"),
        ("same-kind", "duplicate_key_file"),
    ],
    ids=["unrecognized", "no-file", "duplicate"],
)
def test_upload_keys_rejects_bad_requests(world, files, code):
    if files == "same-kind":
        files = [(world["crypt5"], "a.json"), (world["crypt5"], "b.json")]
    data = {"file": [(io.BytesIO(content), name) for content, name in files]} if files else {}
    body = _client(world, FakeFetch({}), FakeRun()).post(
        "/api/happ-decryptor/keys/upload", data=data, content_type="multipart/form-data"
    ).get_json()

    assert body["ok"] is False and body["error"] == code
    assert not (world["assets"] / "crypt5-keys.json").exists()


def test_upload_keys_rejects_oversized_file(world):
    big = b"{" + b" " * (keys.MAX_KEY_FILE_BYTES + 1) + b"}"
    resp = _client(world, FakeFetch({}), FakeRun()).post(
        "/api/happ-decryptor/keys/upload",
        data={"file": (io.BytesIO(big), "crypt5-keys.json")},
        content_type="multipart/form-data",
    )
    assert resp.status_code == 413
    assert resp.get_json()["error"] == "payload too large"


class CheckingRun(FakeRun):
    def __init__(self, result):
        super().__init__()
        self.result = result

    def __call__(self, argv, timeout):
        if "-json" in argv:
            self.calls.append(list(argv))
            return self.result
        return super().__call__(argv, timeout)


def test_check_link_route_returns_the_result(world):
    world["bin"].write_bytes(world["binary"])
    run = CheckingRun((0, json.dumps({"ok": True, "format": "crypt5", "layout": "salted", "url": "https://example.com/sub"}), ""))

    body = _client(world, FakeFetch({}), run).post("/api/happ-decryptor/check", json={"link": "happ://crypt5/abc"}).get_json()

    assert body["ok"] is True, body
    assert body["check"] == {"format": "crypt5", "layout": "salted", "url": "https://example.com/sub"}


def test_check_link_route_explains_a_missing_key(world):
    world["bin"].write_bytes(world["binary"])
    message = 'crypt5 marker "vdQx7r2p" is not in crypt5-keys.json; update the Happ keys'
    run = CheckingRun((4, json.dumps({"ok": False, "error": "unknown_key", "message": message}), ""))

    body = _client(world, FakeFetch({}), run).post("/api/happ-decryptor/check", json={"link": "happ://crypt5/abc"}).get_json()

    assert body["ok"] is False and body["error"] == "unknown_key"
    assert "vdQx7r2p" in body["hint"]
