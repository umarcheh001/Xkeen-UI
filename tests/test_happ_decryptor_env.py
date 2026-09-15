"""ENV editor knobs of the Happ decryptor installer."""

from __future__ import annotations

from services.devtools.env import ENV_WHITELIST, _default_effective_value
from services import happ_links
from services.happ_decryptor import engine, keys


def test_release_and_manifest_urls_are_editable_with_their_defaults(tmp_path):
    for key, default in (
        ("XKEEN_HAPP_DECRYPTOR_RELEASE_URL", engine.DEFAULT_RELEASE_URL),
        ("XKEEN_HAPP_KEYS_MANIFEST_URL", keys.DEFAULT_MANIFEST_URL),
    ):
        assert key in ENV_WHITELIST
        assert _default_effective_value(key, str(tmp_path)) == default
    assert engine.RELEASE_URL_ENV == "XKEEN_HAPP_DECRYPTOR_RELEASE_URL"
    assert keys.MANIFEST_URL_ENV == "XKEEN_HAPP_KEYS_MANIFEST_URL"


def test_custom_download_urls_switch_is_editable_and_off_by_default(tmp_path, monkeypatch):
    # The ENV help for the release URL points at this switch, so it has to be reachable in the editor.
    key = "XKEEN_HAPP_DECRYPTOR_ALLOW_CUSTOM_URLS"
    assert key in ENV_WHITELIST
    assert _default_effective_value(key, str(tmp_path)) == "0"

    from services.url_policy import get_policy_from_env

    monkeypatch.delenv(key, raising=False)
    assert get_policy_from_env("XKEEN_HAPP_DECRYPTOR").allow_custom_urls is False
    monkeypatch.setenv(key, "1")
    assert get_policy_from_env("XKEEN_HAPP_DECRYPTOR").allow_custom_urls is True


def test_decryptor_timeout_default_follows_the_installed_decryptor(tmp_path, monkeypatch):
    monkeypatch.setattr(happ_links, "default_decryptor_timeout_seconds", lambda: 15.0)
    assert _default_effective_value("XKEEN_HAPP_DECRYPTOR_TIMEOUT", str(tmp_path)) == "15"

    monkeypatch.setattr(happ_links, "default_decryptor_timeout_seconds", lambda: 45.0)
    assert _default_effective_value("XKEEN_HAPP_DECRYPTOR_TIMEOUT", str(tmp_path)) == "45"
