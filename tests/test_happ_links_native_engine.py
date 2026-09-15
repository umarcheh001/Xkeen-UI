"""happ_links with the installed Go engine: discovery order, timeout and human error texts."""

from __future__ import annotations

import sys

import pytest

from services import happ_links

ELF = b"\x7fELF\x02\x01\x01" + b"\0" * 61


def test_native_engine_wins_over_script_dropins(tmp_path):
    (tmp_path / "bin").mkdir()
    (tmp_path / "scripts").mkdir()
    (tmp_path / "bin" / "happ_decryptor.py").write_text("print('old')\n", encoding="utf-8")
    (tmp_path / "scripts" / "happwner").write_text("#!/bin/sh\necho old\n", encoding="utf-8")
    native = tmp_path / "bin" / "happ-decrypt-universal"
    native.write_bytes(ELF)

    assert happ_links._bundled_decryptor_command_parts(roots=(tmp_path,)) == [str(native)]


def test_script_dropin_is_used_when_there_is_no_native_engine(tmp_path):
    (tmp_path / "bin").mkdir()
    script = tmp_path / "bin" / "happ_decryptor.py"
    script.write_text("print('ok')\n", encoding="utf-8")

    parts = happ_links._bundled_decryptor_command_parts(roots=(tmp_path,))

    assert parts == [sys.executable, str(script)]


def test_decryptor_timeout_is_short_for_the_native_engine(tmp_path, monkeypatch):
    monkeypatch.delenv(happ_links.HAPP_DECRYPTOR_TIMEOUT_ENV, raising=False)
    monkeypatch.delenv(happ_links.HAPP_HELPER_TIMEOUT_ENV, raising=False)
    native = tmp_path / "happ-decrypt-universal"
    native.write_bytes(ELF)
    monkeypatch.setattr(happ_links, "decryptor_command_parts", lambda: [str(native)])

    assert happ_links.default_decryptor_timeout_seconds() == 15.0
    assert happ_links.decryptor_timeout_seconds() == 15.0


def test_decryptor_timeout_keeps_the_long_budget_for_script_decryptors(tmp_path, monkeypatch):
    monkeypatch.delenv(happ_links.HAPP_DECRYPTOR_TIMEOUT_ENV, raising=False)
    monkeypatch.delenv(happ_links.HAPP_HELPER_TIMEOUT_ENV, raising=False)
    script = tmp_path / "happ-decrypt-universal"
    script.write_text("#!/usr/bin/env node\n", encoding="utf-8")
    monkeypatch.setattr(happ_links, "decryptor_command_parts", lambda: ["/usr/bin/node", str(script)])

    assert happ_links.decryptor_timeout_seconds() == 45.0


@pytest.mark.parametrize(
    "reason,expected",
    [
        ("happ_decryptor_not_configured", "нужен декриптор Happ"),
        ('happ_decryptor_failed:happ-decrypt-universal: unknown_key: crypt5 marker "vdQx7r2p" is not in crypt5-keys.json', "нет ключа"),
        ("happ_decryptor_failed:happ-decrypt-universal: no_keys: legacy_keys.json is not installed", "Ключи Happ не установлены"),
        ("happ_decryptor_failed:happ-decrypt-universal: bad_link: crypt5 payload is too short", "повреждена"),
        ("happ_decryptor_failed:happ-decrypt-universal: corrupt: crypt5 authentication failed", "повреждена"),
        ("happ_decryptor_timeout", "не ответил"),
        ("happ_decryptor_missing:[Errno 2] No such file", "не найден"),
        ("happ_decryptor_failed:Error: unexpected", "не смог"),
    ],
    ids=["not-configured", "unknown-key", "no-keys", "bad-link", "corrupt", "timeout", "missing", "other"],
)
def test_decryptor_failure_message_says_what_to_do(reason, expected):
    assert expected in happ_links.decryptor_failure_message(reason)


@pytest.mark.parametrize(
    "reason",
    [
        "happ_decryptor_not_configured",
        "happ_decryptor_failed:happ-decrypt-universal: unknown_key: crypt5 marker",
        "happ_decryptor_failed:happ-decrypt-universal: no_keys: missing",
    ],
)
def test_messages_about_installing_and_keys_point_to_the_card(reason):
    assert happ_links.HAPP_DECRYPTOR_CARD_LABEL in happ_links.decryptor_failure_message(reason)


def test_decryptor_failure_message_ignores_other_failures():
    assert happ_links.decryptor_failure_message("happ_helper_failed:boom") is None
    assert happ_links.decryptor_failure_message("") is None


def test_xray_subscription_error_uses_the_human_text():
    from services.xray_subscriptions import _happ_helper_error_message

    message = _happ_helper_error_message("happ_decryptor_failed:happ-decrypt-universal: unknown_key: crypt5 marker")
    assert "нет ключа" in message and happ_links.HAPP_DECRYPTOR_CARD_LABEL in message
