"""Decrypt subscription payloads returned by Happ-compatible senders.

Some Happ deep-links resolve to an HTTP URL whose response is an AES-GCM
encrypted, base64-encoded subscription.  The key selector is carried in the
URL's ``key`` query parameter and the authentication tag in ``Encrypt-Tag``.

The router image deliberately has no heavyweight crypto dependency, so this
module contains the small AES-128/GCM subset required by that wire format.
"""

from __future__ import annotations

import base64
import binascii
import hmac
from typing import Any, Dict
from urllib.parse import parse_qs, urlparse


HAPP_PAYLOAD_DECRYPTED_HEADER = "x-xkeen-happ-payload-decrypted"

_HAPP_PAYLOAD_KEYS = {
    "key01": b"key01:3jk#R2d&Dd",
    "key02": b"key02:+]%4ij#P\"/",
    "key03": b"key03:?&YNg/\"L3}",
    "key04": b"key04:+-4b\"-?S${",
    "key05": b"key05:N5<a/(~jJ'",
    "key06": b"key06:s5\\[\"=`uC/",
    "key07": b"key07:(H+b'')_@5",
    "key08": b"key08:W'=)[/~i9w",
    "key09": b"key09:'2%`C~>)_d",
    "key10": b"key10:)\\'h]*#7MP",
}

_NONCE = b"kkkkkkkkkkkk"
_SBOX = (
    0x63, 0x7C, 0x77, 0x7B, 0xF2, 0x6B, 0x6F, 0xC5, 0x30, 0x01, 0x67, 0x2B, 0xFE, 0xD7, 0xAB, 0x76,
    0xCA, 0x82, 0xC9, 0x7D, 0xFA, 0x59, 0x47, 0xF0, 0xAD, 0xD4, 0xA2, 0xAF, 0x9C, 0xA4, 0x72, 0xC0,
    0xB7, 0xFD, 0x93, 0x26, 0x36, 0x3F, 0xF7, 0xCC, 0x34, 0xA5, 0xE5, 0xF1, 0x71, 0xD8, 0x31, 0x15,
    0x04, 0xC7, 0x23, 0xC3, 0x18, 0x96, 0x05, 0x9A, 0x07, 0x12, 0x80, 0xE2, 0xEB, 0x27, 0xB2, 0x75,
    0x09, 0x83, 0x2C, 0x1A, 0x1B, 0x6E, 0x5A, 0xA0, 0x52, 0x3B, 0xD6, 0xB3, 0x29, 0xE3, 0x2F, 0x84,
    0x53, 0xD1, 0x00, 0xED, 0x20, 0xFC, 0xB1, 0x5B, 0x6A, 0xCB, 0xBE, 0x39, 0x4A, 0x4C, 0x58, 0xCF,
    0xD0, 0xEF, 0xAA, 0xFB, 0x43, 0x4D, 0x33, 0x85, 0x45, 0xF9, 0x02, 0x7F, 0x50, 0x3C, 0x9F, 0xA8,
    0x51, 0xA3, 0x40, 0x8F, 0x92, 0x9D, 0x38, 0xF5, 0xBC, 0xB6, 0xDA, 0x21, 0x10, 0xFF, 0xF3, 0xD2,
    0xCD, 0x0C, 0x13, 0xEC, 0x5F, 0x97, 0x44, 0x17, 0xC4, 0xA7, 0x7E, 0x3D, 0x64, 0x5D, 0x19, 0x73,
    0x60, 0x81, 0x4F, 0xDC, 0x22, 0x2A, 0x90, 0x88, 0x46, 0xEE, 0xB8, 0x14, 0xDE, 0x5E, 0x0B, 0xDB,
    0xE0, 0x32, 0x3A, 0x0A, 0x49, 0x06, 0x24, 0x5C, 0xC2, 0xD3, 0xAC, 0x62, 0x91, 0x95, 0xE4, 0x79,
    0xE7, 0xC8, 0x37, 0x6D, 0x8D, 0xD5, 0x4E, 0xA9, 0x6C, 0x56, 0xF4, 0xEA, 0x65, 0x7A, 0xAE, 0x08,
    0xBA, 0x78, 0x25, 0x2E, 0x1C, 0xA6, 0xB4, 0xC6, 0xE8, 0xDD, 0x74, 0x1F, 0x4B, 0xBD, 0x8B, 0x8A,
    0x70, 0x3E, 0xB5, 0x66, 0x48, 0x03, 0xF6, 0x0E, 0x61, 0x35, 0x57, 0xB9, 0x86, 0xC1, 0x1D, 0x9E,
    0xE1, 0xF8, 0x98, 0x11, 0x69, 0xD9, 0x8E, 0x94, 0x9B, 0x1E, 0x87, 0xE9, 0xCE, 0x55, 0x28, 0xDF,
    0x8C, 0xA1, 0x89, 0x0D, 0xBF, 0xE6, 0x42, 0x68, 0x41, 0x99, 0x2D, 0x0F, 0xB0, 0x54, 0xBB, 0x16,
)


class HappPayloadError(ValueError):
    """The response claimed to be a Happ payload but could not be verified."""


def _xtime(value: int) -> int:
    return ((value << 1) ^ (0x11B if value & 0x80 else 0)) & 0xFF


def _expand_aes128_key(key: bytes) -> bytes:
    if len(key) != 16:
        raise HappPayloadError("invalid_key")
    expanded = bytearray(key)
    rcon = 1
    while len(expanded) < 176:
        temp = list(expanded[-4:])
        if len(expanded) % 16 == 0:
            temp = [_SBOX[temp[1]], _SBOX[temp[2]], _SBOX[temp[3]], _SBOX[temp[0]]]
            temp[0] ^= rcon
            rcon = _xtime(rcon)
        for value in temp:
            expanded.append(expanded[-16] ^ value)
    return bytes(expanded)


def _mix_columns(state: list[int]) -> None:
    for offset in range(0, 16, 4):
        a, b, c, d = state[offset : offset + 4]
        total = a ^ b ^ c ^ d
        state[offset] = a ^ total ^ _xtime(a ^ b)
        state[offset + 1] = b ^ total ^ _xtime(b ^ c)
        state[offset + 2] = c ^ total ^ _xtime(c ^ d)
        state[offset + 3] = d ^ total ^ _xtime(d ^ a)


def _aes128_encrypt_block(block: bytes, expanded_key: bytes) -> bytes:
    if len(block) != 16 or len(expanded_key) != 176:
        raise HappPayloadError("invalid_block")
    state = [value ^ expanded_key[index] for index, value in enumerate(block)]
    for round_index in range(1, 11):
        state = [_SBOX[value] for value in state]
        state = [
            state[0], state[5], state[10], state[15],
            state[4], state[9], state[14], state[3],
            state[8], state[13], state[2], state[7],
            state[12], state[1], state[6], state[11],
        ]
        if round_index != 10:
            _mix_columns(state)
        key_offset = round_index * 16
        state = [value ^ expanded_key[key_offset + index] for index, value in enumerate(state)]
    return bytes(state)


def _gf128_multiply(left: int, right: int) -> int:
    result = 0
    value = right
    for bit in range(127, -1, -1):
        if (left >> bit) & 1:
            result ^= value
        value = (value >> 1) ^ (0xE1000000000000000000000000000000 if value & 1 else 0)
    return result


def _ghash(hash_key: bytes, ciphertext: bytes) -> bytes:
    h_value = int.from_bytes(hash_key, "big")
    result = 0
    padded = ciphertext + (b"\0" * ((-len(ciphertext)) % 16))
    lengths = (0).to_bytes(8, "big") + (len(ciphertext) * 8).to_bytes(8, "big")
    for offset in range(0, len(padded + lengths), 16):
        block = (padded + lengths)[offset : offset + 16]
        result = _gf128_multiply(result ^ int.from_bytes(block, "big"), h_value)
    return result.to_bytes(16, "big")


def _inc32(counter: bytes) -> bytes:
    return counter[:12] + ((int.from_bytes(counter[12:], "big") + 1) & 0xFFFFFFFF).to_bytes(4, "big")


def _gctr(expanded_key: bytes, initial_counter: bytes, value: bytes) -> bytes:
    out = bytearray()
    counter = initial_counter
    for offset in range(0, len(value), 16):
        block = value[offset : offset + 16]
        stream = _aes128_encrypt_block(counter, expanded_key)
        out.extend(a ^ b for a, b in zip(block, stream))
        counter = _inc32(counter)
    return bytes(out)


def _decrypt_aes128_gcm(key: bytes, nonce: bytes, ciphertext: bytes, tag: bytes) -> bytes:
    if len(nonce) != 12 or len(tag) != 16:
        raise HappPayloadError("invalid_parameters")
    expanded = _expand_aes128_key(key)
    hash_key = _aes128_encrypt_block(b"\0" * 16, expanded)
    initial_counter = nonce + b"\0\0\0\1"
    expected_tag = bytes(
        a ^ b
        for a, b in zip(
            _aes128_encrypt_block(initial_counter, expanded),
            _ghash(hash_key, ciphertext),
        )
    )
    if not hmac.compare_digest(expected_tag, tag):
        raise HappPayloadError("authentication_failed")
    return _gctr(expanded, _inc32(initial_counter), ciphertext)


def _decode_base64(value: Any) -> bytes:
    compact = "".join(str(value or "").split())
    if not compact:
        raise HappPayloadError("empty_payload")
    if len(compact) % 4 == 1:
        raise HappPayloadError("invalid_base64")
    compact += "=" * ((4 - (len(compact) % 4)) % 4)
    try:
        return base64.b64decode(compact, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HappPayloadError("invalid_base64") from exc


def payload_key_id(url: Any) -> str:
    try:
        values = parse_qs(urlparse(str(url or "").strip()).query).get("key") or []
    except Exception:
        return ""
    key_id = str(values[0] if values else "").strip().lower()
    return key_id if key_id in _HAPP_PAYLOAD_KEYS else ""


def decrypt_subscription_body(
    url: Any,
    body: Any,
    headers: Dict[str, str] | None,
) -> str | None:
    """Return plaintext for a recognized encrypted Happ response, else ``None``."""

    normalized_headers = {str(k or "").strip().lower(): str(v or "").strip() for k, v in (headers or {}).items()}
    encrypt_tag = normalized_headers.get("encrypt-tag") or ""
    key_id = payload_key_id(url)
    if not encrypt_tag or not key_id:
        return None
    plaintext = _decrypt_aes128_gcm(
        _HAPP_PAYLOAD_KEYS[key_id],
        _NONCE,
        _decode_base64(body),
        _decode_base64(encrypt_tag),
    )
    try:
        return plaintext.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise HappPayloadError("invalid_utf8") from exc
