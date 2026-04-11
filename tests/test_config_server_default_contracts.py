from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_config_server_base_uses_explicit_helper_and_no_insecure_http_default():
    service_text = (ROOT / "xkeen-ui" / "services" / "config_exchange_github.py").read_text(encoding="utf-8")
    route_text = (ROOT / "xkeen-ui" / "routes" / "config_exchange.py").read_text(encoding="utf-8")
    env_text = (ROOT / "xkeen-ui" / "services" / "devtools" / "env.py").read_text(encoding="utf-8")
    app_factory_text = (ROOT / "xkeen-ui" / "app_factory.py").read_text(encoding="utf-8")

    assert 'CONFIG_SERVER_BASE_ENV = "XKEEN_CONFIG_SERVER_BASE"' in service_text
    assert 'def get_config_server_base() -> str:' in service_text
    assert 'return str(os.environ.get(CONFIG_SERVER_BASE_ENV) or "").strip()' in service_text
    assert 'CONFIG_SERVER_BASE =' not in service_text
    assert 'if not gh.get_config_server_base():' in route_text
    assert 'if k == "XKEEN_CONFIG_SERVER_BASE":\n        return ""' in env_text
    assert '"XKEEN_CONFIG_SERVER_BASE", "http://' not in service_text
    assert '"XKEEN_CONFIG_SERVER_BASE", "http://' not in app_factory_text
