from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_devtools_env_exposes_request_size_limit_knobs():
    env_py = (ROOT / "xkeen-ui" / "services" / "devtools" / "env.py").read_text(encoding="utf-8")
    env_js = (ROOT / "xkeen-ui" / "static" / "js" / "features" / "devtools" / "env.js").read_text(encoding="utf-8")
    app_factory = (ROOT / "xkeen-ui" / "app_factory.py").read_text(encoding="utf-8")
    geodat_py = (ROOT / "xkeen-ui" / "routes" / "routing" / "geodat.py").read_text(encoding="utf-8")

    assert '"XKEEN_UI_MAX_CONTENT_LENGTH"' in env_py
    assert '"XKEEN_JSON_BODY_MAX_BYTES"' in env_py
    assert '"XKEEN_JSON_HEAVY_MAX_BYTES"' in env_py
    assert '"XKEEN_MIHOMO_JSON_MAX_BYTES"' in env_py
    assert '"XKEEN_GEODAT_UPLOAD_MAX_BYTES"' in env_py
    assert '"XKEEN_ROUTING_SAVE_MAX_BYTES"' in env_py
    assert '"XKEEN_CONFIG_EXCHANGE_MAX_BYTES"' in env_py
    assert "ENV_HELP.XKEEN_UI_MAX_CONTENT_LENGTH" in env_js
    assert "ENV_HELP.XKEEN_JSON_BODY_MAX_BYTES" in env_js
    assert "ENV_HELP.XKEEN_JSON_HEAVY_MAX_BYTES" in env_js
    assert "ENV_HELP.XKEEN_MIHOMO_JSON_MAX_BYTES" in env_js
    assert "ENV_HELP.XKEEN_GEODAT_UPLOAD_MAX_BYTES" in env_js
    assert 'if k == "XKEEN_ROUTING_SAVE_MAX_BYTES":' in env_py
    assert 'if k == "XKEEN_CONFIG_EXCHANGE_MAX_BYTES":' in env_py
    assert "ENV_HELP.XKEEN_ROUTING_SAVE_MAX_BYTES" in env_js
    assert "ENV_HELP.XKEEN_CONFIG_EXCHANGE_MAX_BYTES" in env_js
    assert "install_request_size_guards(app)" in app_factory
    assert "read_uploaded_file_bytes_limited" in geodat_py
    assert "get_geodat_upload_max_bytes" in geodat_py
    assert "ENV_NO_RESTART_KEYS.add('XKEEN_ROUTING_SAVE_MAX_BYTES')" in env_js
    assert "ENV_NO_RESTART_KEYS.add('XKEEN_CONFIG_EXCHANGE_MAX_BYTES')" in env_js
    assert "ENV_NO_RESTART_KEYS.add('XKEEN_UI_MAX_CONTENT_LENGTH')" in env_js
    assert "ENV_NO_RESTART_KEYS.add('XKEEN_JSON_BODY_MAX_BYTES')" in env_js


def test_routing_and_config_exchange_use_streaming_request_limit_helpers():
    routing_py = (ROOT / "xkeen-ui" / "routes" / "routing" / "config.py").read_text(encoding="utf-8")
    exchange_py = (ROOT / "xkeen-ui" / "routes" / "config_exchange.py").read_text(encoding="utf-8")
    limits_py = (ROOT / "xkeen-ui" / "services" / "request_limits.py").read_text(encoding="utf-8")

    assert "read_request_bytes_limited" in routing_py
    assert '"payload too large", "max_bytes": max_bytes' in routing_py
    assert "read_uploaded_file_bytes_limited" in exchange_py
    assert "read_request_json_limited" in exchange_py
    assert '_api_error("payload too large", 413, ok=False, max_bytes=max_bytes)' in exchange_py
    assert "classify_json_request_max_bytes" in limits_py
    assert "install_request_size_guards" in limits_py
