"""Guard: every documented env var is actually reachable from the ENV editor.

The DevTools ENV editor only shows keys listed in ``ENV_WHITELIST``. A feature
can ship a working env knob, document it in README, and still leave the user
staring at "Ничего не найдено" in the panel — that is exactly what happened to
the subscription auto-refresh settings. These tests keep the three places in
sync: README, the Python whitelist, and the frontend help/grouping.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "xkeen-ui"

if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from services.devtools.env import (  # noqa: E402
    ENV_WHITELIST,
    _default_effective_value,
)

ENV_JS = APP_DIR / "static" / "js" / "features" / "devtools" / "env.js"
README = ROOT / "README.md"

# Documented in README on purpose, but deliberately kept out of the ENV editor.
# Add a key here only together with a comment saying why it must stay hidden.
README_ONLY_KEYS: frozenset[str] = frozenset()

# Whitelisted keys with no meaningful default: an empty value means "show
# everything", so inventing a default would be misleading.
KEYS_WITHOUT_DEFAULT = frozenset(
    {
        "XKEEN_UI_PANEL_SECTIONS_WHITELIST",
        "XKEEN_UI_DEVTOOLS_SECTIONS_WHITELIST",
    }
)


def _readme_env_keys() -> set[str]:
    text = README.read_text(encoding="utf-8")
    return {m.group(1) for m in re.finditer(r"`(XKEEN_[A-Z0-9_]+)", text)}


def _env_js_source() -> str:
    return ENV_JS.read_text(encoding="utf-8")


def _env_help_keys() -> set[str]:
    src = _env_js_source()
    start = src.index("const ENV_HELP = {")
    end = src.index("\n  };", start)
    literal = src[start:end]

    keys = {m.group(1) for m in re.finditer(r"'(XKEEN_[A-Z0-9_]+)'\s*:", literal)}
    keys |= {m.group(1) for m in re.finditer(r"ENV_HELP\.(XKEEN_[A-Z0-9_]+)\s*=", src)}
    return keys


def _env_groups() -> list[dict]:
    src = _env_js_source()
    start = src.index("const ENV_GROUPS = [")
    end = src.index("\n  ];", start)
    block = src[start:end]

    groups = []
    pattern = re.compile(
        r"\{\s*id: '([a-z]+)',.*?keys: \[(.*?)\],\s*prefixes: \[(.*?)\],\s*\}",
        re.DOTALL,
    )
    for match in pattern.finditer(block):
        groups.append(
            {
                "id": match.group(1),
                "keys": re.findall(r"'([^']+)'", match.group(2)),
                "prefixes": re.findall(r"'([^']+)'", match.group(3)),
            }
        )
    return groups


def _group_for_key(key: str) -> str:
    for group in _env_groups():
        if group["id"] == "other":
            continue
        if key in group["keys"]:
            return group["id"]
        if any(key.startswith(prefix) for prefix in group["prefixes"]):
            return group["id"]
    return "other"


def test_readme_env_vars_are_editable_in_devtools():
    documented = _readme_env_keys() - README_ONLY_KEYS
    missing = sorted(documented - set(ENV_WHITELIST))
    assert not missing, (
        "Переменные задокументированы в README, но их нет в ENV_WHITELIST, "
        "поэтому в панели они не видны: " + ", ".join(missing)
    )


def test_every_whitelisted_key_has_a_default_value():
    missing = sorted(
        key
        for key in ENV_WHITELIST
        if key not in KEYS_WITHOUT_DEFAULT
        and _default_effective_value(key, str(ROOT / "state")) is None
    )
    assert not missing, (
        "Ключи из ENV_WHITELIST без значения по умолчанию — колонка Current "
        "останется пустой: " + ", ".join(missing)
    )


def test_every_whitelisted_key_is_described_and_grouped():
    described = _env_help_keys()
    undescribed = sorted(set(ENV_WHITELIST) - described)
    assert not undescribed, (
        "Нет описания в ENV_HELP (env.js), «Справка» покажет заглушку: "
        + ", ".join(undescribed)
    )

    ungrouped = sorted(key for key in ENV_WHITELIST if _group_for_key(key) == "other")
    assert not ungrouped, (
        "Ключи не попадают ни в одну группу ENV_GROUPS и свалятся в «Прочее»: "
        + ", ".join(ungrouped)
    )


@pytest.mark.parametrize(
    ("key", "expected"),
    [
        ("XKEEN_SUBSCRIPTIONS_SCHEDULER", "1"),
        ("XKEEN_SUBSCRIPTIONS_SCHEDULER_TICK", "60"),
        ("XKEEN_SUBSCRIPTIONS_RESTART_BATCH", "1"),
        ("XKEEN_MIHOMO_SUBSCRIPTIONS_SCHEDULER", "1"),
        ("XKEEN_MIHOMO_SUBSCRIPTIONS_SCHEDULER_TICK", "60"),
        ("XKEEN_MIHOMO_SUBSCRIPTIONS_RESTART_BATCH", "1"),
        ("XKEEN_SUBSCRIPTION_ALLOW_HTTP", "1"),
        ("XKEEN_SUBSCRIPTION_ALLOW_PRIVATE_HOSTS", "0"),
    ],
)
def test_subscription_defaults_match_runtime(key, expected):
    assert _default_effective_value(key, str(ROOT / "state")) == expected


def test_lookahead_default_matches_subscription_services():
    import services.mihomo_subscriptions as mihomo_subscriptions
    import services.xray_subscriptions as xray_subscriptions

    expected = str(xray_subscriptions.DEFAULT_REFRESH_LOOKAHEAD_SECONDS)
    assert expected == str(mihomo_subscriptions.DEFAULT_REFRESH_LOOKAHEAD_SECONDS)

    state = str(ROOT / "state")
    assert _default_effective_value("XKEEN_SUBSCRIPTIONS_LOOKAHEAD_SEC", state) == expected
    assert _default_effective_value("XKEEN_MIHOMO_SUBSCRIPTIONS_LOOKAHEAD_SEC", state) == expected


def test_dns_watchdog_defaults_match_runtime_constants():
    import services.dns_over_vless as dns_over_vless

    state = str(ROOT / "state")
    assert _default_effective_value("XKEEN_DNS_OVER_VLESS_WATCHDOG", state) == "1"
    assert _default_effective_value("XKEEN_DNS_OVER_VLESS_WATCHDOG_INTERVAL", state) == str(
        int(dns_over_vless.WATCHDOG_INTERVAL)
    )
    assert _default_effective_value("XKEEN_DNS_OVER_VLESS_WATCHDOG_FAILS", state) == str(
        dns_over_vless.WATCHDOG_FAIL_THRESHOLD
    )
    assert _default_effective_value("XKEEN_DNS_OVER_VLESS_WATCHDOG_RESTARTS", state) == str(
        dns_over_vless.WATCHDOG_RESTART_ATTEMPTS
    )
