from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from services.module_catalog_trust import verify_catalog_signature


ROOT = Path(__file__).resolve().parents[1]
SIGNER = ROOT / "scripts" / "sign_modular_panel_catalog.py"
SECRET_NAME = "XKEEN_RELEASE_ED25519_PRIVATE_KEY"


def _private_pem() -> bytes:
    return Ed25519PrivateKey.generate().private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )


def _public_pem(private_pem: bytes) -> bytes:
    private_key = serialization.load_pem_private_key(private_pem, password=None)
    return private_key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )


def _release_assets(tmp_path: Path) -> tuple[Path, Path]:
    catalog_path = tmp_path / "catalog.json"
    metadata_path = tmp_path / "release-metadata.json"
    catalog_path.write_bytes(b'{"channel":"stable","schema_version":1}\n')
    metadata_path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "release_version": "1.2.3",
                "assets": ["release-metadata.json", "catalog.json"],
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n",
        encoding="utf-8",
    )
    return catalog_path, metadata_path


def _run_signer(catalog_path: Path, metadata_path: Path, *, private_pem: bytes | None) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    environment.pop(SECRET_NAME, None)
    if private_pem is not None:
        environment[SECRET_NAME] = private_pem.decode("ascii")
    return subprocess.run(
        [
            sys.executable,
            str(SIGNER),
            "--catalog",
            str(catalog_path),
            "--metadata",
            str(metadata_path),
            "--key-id",
            "release-2026",
            "--private-key-env",
            SECRET_NAME,
        ],
        cwd=ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )


def test_signer_writes_canonical_envelope_and_updates_metadata_once(tmp_path: Path) -> None:
    catalog_path, metadata_path = _release_assets(tmp_path)
    private_pem = _private_pem()

    result = _run_signer(catalog_path, metadata_path, private_pem=private_pem)

    assert result.returncode == 0, result.stderr
    signature_path = tmp_path / "catalog.json.sig"
    signature = signature_path.read_bytes()
    assert signature == json.dumps(
        json.loads(signature), sort_keys=True, separators=(",", ":")
    ).encode("utf-8") + b"\n"
    verified = verify_catalog_signature(
        catalog_path.read_bytes(),
        signature,
        keyring={"release-2026": _public_pem(private_pem)},
    )
    assert verified.key_id == "release-2026"
    assert json.loads(metadata_path.read_text(encoding="utf-8"))["assets"] == [
        "catalog.json",
        "catalog.json.sig",
        "release-metadata.json",
    ]

    repeated = _run_signer(catalog_path, metadata_path, private_pem=private_pem)
    assert repeated.returncode == 0, repeated.stderr
    assert json.loads(metadata_path.read_text(encoding="utf-8"))["assets"].count("catalog.json.sig") == 1


def test_signer_does_not_mutate_assets_when_private_key_is_missing(tmp_path: Path) -> None:
    catalog_path, metadata_path = _release_assets(tmp_path)
    original_metadata = metadata_path.read_bytes()

    result = _run_signer(catalog_path, metadata_path, private_pem=None)

    assert result.returncode != 0
    assert not (tmp_path / "catalog.json.sig").exists()
    assert metadata_path.read_bytes() == original_metadata
    assert SECRET_NAME not in result.stderr


def test_signer_does_not_mutate_assets_when_private_key_is_invalid(tmp_path: Path) -> None:
    catalog_path, metadata_path = _release_assets(tmp_path)
    original_metadata = metadata_path.read_bytes()
    invalid_private_pem = b"-----BEGIN PRIVATE KEY-----\ninvalid\n-----END PRIVATE KEY-----\n"

    result = _run_signer(catalog_path, metadata_path, private_pem=invalid_private_pem)

    assert result.returncode != 0
    assert not (tmp_path / "catalog.json.sig").exists()
    assert metadata_path.read_bytes() == original_metadata
    assert invalid_private_pem.decode("ascii") not in result.stderr
