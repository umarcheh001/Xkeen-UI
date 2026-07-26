from __future__ import annotations

import base64

import pytest

from services import happ_payloads


_PLAINTEXT = "vless://user@example.com:443?security=tls#Happ"
_CIPHERTEXT = "lGLnl/+7sfNVtjrk7UjH3D1zZqgxZr2x4IjSjbVKAKoorFYcJdbCmkd6KJ8PnQ=="
_TAG = "mgbbH9BPh+/tJkyUZDfhfQ=="


def test_aes128_gcm_matches_standard_zero_vector():
    ciphertext = bytes.fromhex("0388dace60b6a392f328c2b971b2fe78")
    tag = bytes.fromhex("ab6e47d42cec13bdf53a67b21257bddf")

    plaintext = happ_payloads._decrypt_aes128_gcm(bytes(16), bytes(12), ciphertext, tag)

    assert plaintext == bytes(16)


def test_decrypt_subscription_body_uses_key_selector_and_encrypt_tag():
    plaintext = happ_payloads.decrypt_subscription_body(
        "https://sender.example/subscription?key=key08",
        _CIPHERTEXT,
        {"Encrypt-Tag": _TAG, "Content-Type": "application/octet-stream"},
    )

    assert plaintext == _PLAINTEXT


def test_decrypt_subscription_body_accepts_unpadded_base64():
    plaintext = happ_payloads.decrypt_subscription_body(
        "https://sender.example/subscription?key=key08",
        _CIPHERTEXT.rstrip("="),
        {"encrypt-tag": _TAG.rstrip("=")},
    )

    assert plaintext == _PLAINTEXT


def test_decrypt_subscription_body_ignores_regular_responses():
    assert (
        happ_payloads.decrypt_subscription_body(
            "https://sender.example/subscription",
            _PLAINTEXT,
            {"content-type": "text/plain"},
        )
        is None
    )


def test_decrypt_subscription_body_rejects_modified_ciphertext():
    ciphertext = bytearray(base64.b64decode(_CIPHERTEXT))
    ciphertext[0] ^= 1

    with pytest.raises(happ_payloads.HappPayloadError, match="authentication_failed"):
        happ_payloads.decrypt_subscription_body(
            "https://sender.example/subscription?key=key08",
            base64.b64encode(ciphertext).decode("ascii"),
            {"encrypt-tag": _TAG},
        )
