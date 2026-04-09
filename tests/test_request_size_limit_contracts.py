from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_devtools_env_exposes_request_size_limit_knobs():
    env_py = (ROOT / "xkeen-ui" / "services" / "devtools" / "env.py").read_text(encoding="utf-8")
    env_js = (ROOT / "xkeen-ui" / "static" / "js" / "features" / "devtools" / "env.js").read_text(encoding="utf-8")

    assert '"XKEEN_ROUTING_SAVE_MAX_BYTES"' in env_py
    assert '"XKEEN_CONFIG_EXCHANGE_MAX_BYTES"' in env_py
    assert 'if k == "XKEEN_ROUTING_SAVE_MAX_BYTES":' in env_py
    assert 'if k == "XKEEN_CONFIG_EXCHANGE_MAX_BYTES":' in env_py
    assert "ENV_HELP.XKEEN_ROUTING_SAVE_MAX_BYTES" in env_js
    assert "ENV_HELP.XKEEN_CONFIG_EXCHANGE_MAX_BYTES" in env_js
    assert "ENV_NO_RESTART_KEYS.add('XKEEN_ROUTING_SAVE_MAX_BYTES')" in env_js
    assert "ENV_NO_RESTART_KEYS.add('XKEEN_CONFIG_EXCHANGE_MAX_BYTES')" in env_js


def test_routing_and_config_exchange_use_streaming_request_limit_helpers():
    routing_py = (ROOT / "xkeen-ui" / "routes" / "routing" / "config.py").read_text(encoding="utf-8")
    exchange_py = (ROOT / "xkeen-ui" / "routes" / "config_exchange.py").read_text(encoding="utf-8")

    assert "read_request_bytes_limited" in routing_py
    assert '"payload too large", "max_bytes": max_bytes' in routing_py
    assert "read_uploaded_file_bytes_limited" in exchange_py
    assert "read_request_json_limited" in exchange_py
    assert '_api_error("payload too large", 413, ok=False, max_bytes=max_bytes)' in exchange_py
