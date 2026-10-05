#!/usr/bin/env python3
"""Sign immutable modular-panel catalog bytes for a tagged GitHub Release."""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


class CatalogSigningError(ValueError):
    """A safe-to-display CI signing input error."""


def _atomic_write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def _load_private_key(environment_name: str) -> Ed25519PrivateKey:
    raw_private_key = os.environ.get(environment_name)
    if not raw_private_key or not raw_private_key.strip():
        raise CatalogSigningError("release signing key is unavailable")
    try:
        private_key = serialization.load_pem_private_key(raw_private_key.encode("utf-8"), password=None)
    except (TypeError, ValueError) as error:
        raise CatalogSigningError("release signing key is invalid") from error
    if not isinstance(private_key, Ed25519PrivateKey):
        raise CatalogSigningError("release signing key is not Ed25519")
    return private_key


def _read_metadata(path: Path) -> dict[str, Any]:
    try:
        decoded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CatalogSigningError("release metadata is invalid") from error
    if not isinstance(decoded, dict) or not isinstance(decoded.get("assets"), list):
        raise CatalogSigningError("release metadata is invalid")
    if any(not isinstance(asset, str) or not asset for asset in decoded["assets"]):
        raise CatalogSigningError("release metadata is invalid")
    return decoded


def sign_catalog(catalog_path: Path, metadata_path: Path, *, key_id: str, private_key_env: str) -> Path:
    """Write a detached envelope and add it to release metadata atomically per file."""

    if not key_id or "/" in key_id or "\\" in key_id:
        raise CatalogSigningError("release signing key ID is invalid")
    private_key = _load_private_key(private_key_env)
    try:
        catalog_bytes = catalog_path.read_bytes()
    except OSError as error:
        raise CatalogSigningError("catalog input is unavailable") from error
    metadata = _read_metadata(metadata_path)
    signature_path = catalog_path.with_name(f"{catalog_path.name}.sig")
    envelope = {
        "schema_version": 1,
        "algorithm": "Ed25519",
        "key_id": key_id,
        "signature": base64.b64encode(private_key.sign(catalog_bytes)).decode("ascii"),
    }
    signature_bytes = (json.dumps(envelope, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    metadata["assets"] = sorted({*metadata["assets"], signature_path.name})
    metadata_bytes = (json.dumps(metadata, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    _atomic_write_bytes(signature_path, signature_bytes)
    _atomic_write_bytes(metadata_path, metadata_bytes)
    return signature_path


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--metadata", type=Path, required=True)
    parser.add_argument("--key-id", required=True)
    parser.add_argument("--private-key-env", required=True)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        sign_catalog(
            args.catalog,
            args.metadata,
            key_id=args.key_id,
            private_key_env=args.private_key_env,
        )
    except CatalogSigningError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
