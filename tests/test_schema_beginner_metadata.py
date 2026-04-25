from __future__ import annotations

import json
from pathlib import Path

import pytest


SCHEMAS_DIR = Path(__file__).resolve().parents[1] / "xkeen-ui" / "static" / "schemas"


def _load(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


REQUIRED_KEYS = ("x-ui-explain", "x-ui-use-case", "x-ui-example", "x-ui-warning")


def _assert_beginner_meta(node: dict, label: str) -> None:
    missing = [k for k in REQUIRED_KEYS if not isinstance(node.get(k), str) or not node[k].strip()]
    assert not missing, f"{label}: missing/empty x-ui-* keys: {missing}"


# ---------- Mihomo ----------


@pytest.mark.parametrize(
    "key",
    [
        "mixed-port",
        "redir-port",
        "tproxy-port",
        "allow-lan",
        "proxies",
        "proxy-providers",
        "proxy-groups",
        "rule-providers",
        "rules",
        "tun",
        "sniffer",
    ],
)
def test_mihomo_top_level_field_has_beginner_metadata(key):
    schema = _load(SCHEMAS_DIR / "mihomo-config.schema.json")
    props = schema.get("properties") or {}
    assert key in props, f"mihomo schema missing top-level property `{key}`"
    _assert_beginner_meta(props[key], f"mihomo.{key}")


# ---------- Xray routing ----------


@pytest.mark.parametrize(
    "definition",
    [
        "routingRule",
        "balancer",
        "observatory",
        "inbound",
        "outbound",
    ],
)
def test_xray_routing_definition_has_beginner_metadata(definition):
    schema = _load(SCHEMAS_DIR / "xray-routing.schema.json")
    defs = schema.get("definitions") or {}
    assert definition in defs, f"xray-routing schema missing definition `{definition}`"
    _assert_beginner_meta(defs[definition], f"xray-routing.{definition}")


# ---------- Auxiliary inbounds/outbounds schemas keep parity ----------


@pytest.mark.parametrize(
    "schema_name,definition",
    [
        ("xray-inbounds.schema.json", "inbound"),
        ("xray-inbounds.schema.json", "outbound"),
        ("xray-outbounds.schema.json", "inbound"),
        ("xray-outbounds.schema.json", "outbound"),
    ],
)
def test_xray_aux_schema_definition_has_beginner_metadata(schema_name, definition):
    schema = _load(SCHEMAS_DIR / schema_name)
    defs = schema.get("definitions") or {}
    assert definition in defs, f"{schema_name} missing definition `{definition}`"
    _assert_beginner_meta(defs[definition], f"{schema_name}#{definition}")


@pytest.mark.parametrize("key", ["dns", "observatory"])
def test_xray_config_top_level_field_has_beginner_metadata(key):
    schema = _load(SCHEMAS_DIR / "xray-config.schema.json")
    props = schema.get("properties") or {}
    assert key in props, f"xray-config schema missing top-level property `{key}`"
    _assert_beginner_meta(props[key], f"xray-config.{key}")
