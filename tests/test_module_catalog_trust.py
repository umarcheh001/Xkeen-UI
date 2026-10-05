from __future__ import annotations

import base64
import json

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from services.module_catalog_trust import (
    CatalogTrustError,
    parse_catalog_signature,
    verify_catalog_signature,
)


CATALOG_BYTES = b'{"channel":"stable","schema_version":1}\n'


def _public_pem(private_key: Ed25519PrivateKey) -> bytes:
    return private_key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )


def _envelope(
    private_key: Ed25519PrivateKey,
    *,
    key_id: str = "release-2026",
    algorithm: str = "Ed25519",
    schema_version: int = 1,
    signature: bytes | None = None,
) -> bytes:
    encoded_signature = private_key.sign(CATALOG_BYTES) if signature is None else signature
    return (
        json.dumps(
            {
                "schema_version": schema_version,
                "algorithm": algorithm,
                "key_id": key_id,
                "signature": base64.b64encode(encoded_signature).decode("ascii"),
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    ).encode("utf-8")


def test_verify_catalog_signature_accepts_exact_catalog_bytes() -> None:
    private_key = Ed25519PrivateKey.generate()
    envelope = _envelope(private_key)

    signature = verify_catalog_signature(
        CATALOG_BYTES,
        envelope,
        keyring={"release-2026": _public_pem(private_key)},
    )

    assert signature.key_id == "release-2026"
    assert signature.algorithm == "Ed25519"
    assert signature.signature == private_key.sign(CATALOG_BYTES)


def test_verify_catalog_signature_rejects_changed_catalog_bytes() -> None:
    private_key = Ed25519PrivateKey.generate()

    with pytest.raises(CatalogTrustError, match="catalog_signature_invalid"):
        verify_catalog_signature(
            CATALOG_BYTES + b" ",
            _envelope(private_key),
            keyring={"release-2026": _public_pem(private_key)},
        )


@pytest.mark.parametrize(
    ("envelope", "keyring", "code"),
    [
        (b"not-json", {}, "catalog_signature_invalid"),
        (
            b'{"algorithm":"RSA","key_id":"release-2026","schema_version":1,"signature":"AA=="}',
            {},
            "catalog_signature_algorithm_unsupported",
        ),
        (
            b'{"algorithm":"Ed25519","key_id":"unknown","schema_version":1,"signature":"AA=="}',
            {},
            "catalog_signing_key_unknown",
        ),
        (
            b'{"algorithm":"Ed25519","key_id":"release-2026","schema_version":2,"signature":"AA=="}',
            {},
            "catalog_signature_schema_unsupported",
        ),
        (
            b'{"algorithm":"Ed25519","key_id":"release-2026","schema_version":1,"signature":"%%%"}',
            {},
            "catalog_signature_invalid",
        ),
    ],
)
def test_parse_catalog_signature_rejects_untrusted_or_malformed_envelopes(
    envelope: bytes, keyring: dict[str, bytes], code: str
) -> None:
    with pytest.raises(CatalogTrustError, match=code):
        signature = parse_catalog_signature(envelope)
        verify_catalog_signature(CATALOG_BYTES, envelope, keyring=keyring)
        assert signature


def test_verify_catalog_signature_supports_two_key_rotation_window() -> None:
    old_private_key = Ed25519PrivateKey.generate()
    rotated_private_key = Ed25519PrivateKey.generate()
    envelope = _envelope(rotated_private_key, key_id="release-2027")

    signature = verify_catalog_signature(
        CATALOG_BYTES,
        envelope,
        keyring={
            "release-2026": _public_pem(old_private_key),
            "release-2027": _public_pem(rotated_private_key),
        },
    )

    assert signature.key_id == "release-2027"


def test_verify_catalog_signature_rejects_truncated_signature() -> None:
    private_key = Ed25519PrivateKey.generate()

    with pytest.raises(CatalogTrustError, match="catalog_signature_invalid"):
        verify_catalog_signature(
            CATALOG_BYTES,
            _envelope(private_key, signature=private_key.sign(CATALOG_BYTES)[:8]),
            keyring={"release-2026": _public_pem(private_key)},
        )
