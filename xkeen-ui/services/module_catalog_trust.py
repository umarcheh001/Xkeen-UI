"""Ed25519 trust boundary for official modular-panel catalogs."""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Mapping

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


SIGNATURE_SCHEMA_VERSION = 1
SIGNATURE_ALGORITHM = "Ed25519"
_ENVELOPE_KEYS = frozenset({"schema_version", "algorithm", "key_id", "signature"})
TRUSTED_CATALOG_PUBLIC_KEYS: Mapping[str, bytes] = MappingProxyType(
    {
        "release-2026": (
            b"-----BEGIN PUBLIC KEY-----\n"
            b"MCowBQYDK2VwAyEA6lOYtxXvM0jqieWVo58ku466D/PTTiFdYEw+YZ5fT2k=\n"
            b"-----END PUBLIC KEY-----\n"
        ),
    }
)
TRUSTED_SIGNING_KEY_IDS = frozenset(TRUSTED_CATALOG_PUBLIC_KEYS)


class CatalogTrustError(ValueError):
    """A fail-closed catalog signature verification failure."""

    def __init__(self, code: str, message: str, **details: Any):
        self.code = str(code)
        self.details = details
        super().__init__(f"{self.code}: {message}")


def _fail(code: str, message: str, **details: Any) -> None:
    raise CatalogTrustError(code, message, **details)


@dataclass(frozen=True, slots=True)
class CatalogSignature:
    """Normalized metadata from a detached catalog signature envelope."""

    schema_version: int
    algorithm: str
    key_id: str
    signature: bytes


def parse_catalog_signature(raw_envelope: bytes) -> CatalogSignature:
    """Parse a strict detached-signature envelope without verifying its key."""

    try:
        decoded = json.loads(bytes(raw_envelope).decode("utf-8"))
    except (TypeError, UnicodeDecodeError, json.JSONDecodeError):
        _fail("catalog_signature_invalid", "catalog signature envelope is not valid UTF-8 JSON")
    if not isinstance(decoded, dict) or set(decoded) != _ENVELOPE_KEYS:
        _fail("catalog_signature_invalid", "catalog signature envelope has an unsupported shape")
    schema_version = decoded["schema_version"]
    if not isinstance(schema_version, int) or isinstance(schema_version, bool) or schema_version != SIGNATURE_SCHEMA_VERSION:
        _fail("catalog_signature_schema_unsupported", "catalog signature schema is not supported")
    algorithm = decoded["algorithm"]
    if not isinstance(algorithm, str) or algorithm != SIGNATURE_ALGORITHM:
        _fail("catalog_signature_algorithm_unsupported", "catalog signature algorithm is not supported")
    key_id = decoded["key_id"]
    if not isinstance(key_id, str) or not key_id or "/" in key_id or "\\" in key_id:
        _fail("catalog_signature_invalid", "catalog signature key ID is invalid")
    encoded_signature = decoded["signature"]
    if not isinstance(encoded_signature, str):
        _fail("catalog_signature_invalid", "catalog signature is not base64 text")
    try:
        signature = base64.b64decode(encoded_signature, validate=True)
    except (ValueError, TypeError):
        _fail("catalog_signature_invalid", "catalog signature is not valid base64")
    if not signature:
        _fail("catalog_signature_invalid", "catalog signature is empty")
    return CatalogSignature(
        schema_version=schema_version,
        algorithm=algorithm,
        key_id=key_id,
        signature=signature,
    )


def verify_catalog_signature(
    catalog_bytes: bytes,
    raw_envelope: bytes,
    *,
    keyring: Mapping[str, bytes] = TRUSTED_CATALOG_PUBLIC_KEYS,
) -> CatalogSignature:
    """Verify exact catalog bytes with an already-embedded Ed25519 public key."""

    signature = parse_catalog_signature(raw_envelope)
    public_pem = keyring.get(signature.key_id)
    if public_pem is None:
        _fail("catalog_signing_key_unknown", "catalog signing key is not trusted", key_id=signature.key_id)
    try:
        public_key = serialization.load_pem_public_key(bytes(public_pem))
    except (TypeError, ValueError):
        _fail("catalog_signature_invalid", "catalog signing key cannot be loaded")
    if not isinstance(public_key, Ed25519PublicKey):
        _fail("catalog_signature_invalid", "catalog signing key is not Ed25519")
    try:
        public_key.verify(signature.signature, bytes(catalog_bytes))
    except (InvalidSignature, TypeError, ValueError):
        _fail("catalog_signature_invalid", "catalog signature does not match catalog bytes")
    return signature
