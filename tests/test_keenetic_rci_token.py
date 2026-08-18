from __future__ import annotations

import json
import os
import urllib.error
from pathlib import Path


def test_rci_token_is_loaded_from_jsonc_and_sent_as_keenetic_header(tmp_path: Path):
    from services.keenetic_rci import RCI_TOKEN_HEADER, build_rci_request, load_rci_token

    config = tmp_path / "xkeen.json"
    config.write_text(
        '{\n  // KeeneticOS 5.2 credential\n  "xkeen": {"rci_token": "secret-token"}\n}\n',
        encoding="utf-8",
    )

    assert load_rci_token(str(config)) == "secret-token"
    request = build_rci_request("http://127.0.0.1:79/rci/show/version", token="secret-token")
    headers = {name.lower(): value for name, value in request.header_items()}
    assert headers[RCI_TOKEN_HEADER.lower()] == "secret-token"


def test_rci_probe_distinguishes_missing_and_invalid_token(monkeypatch):
    from services import keenetic_rci

    def forbidden(request, timeout):
        raise urllib.error.HTTPError(request.full_url, 403, "Forbidden", {}, None)

    monkeypatch.setattr(keenetic_rci.urllib.request, "urlopen", forbidden)

    missing = keenetic_rci.probe_rci_access(token="")
    invalid = keenetic_rci.probe_rci_access(token="wrong-token")

    assert (missing.state, missing.token_configured, missing.http_status) == ("token_required", False, 403)
    assert (invalid.state, invalid.token_configured, invalid.http_status) == ("invalid_token", True, 403)


def test_rci_probe_accepts_authenticated_response(monkeypatch):
    from services import keenetic_rci

    class Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    monkeypatch.setattr(keenetic_rci.urllib.request, "urlopen", lambda request, timeout: Response())
    result = keenetic_rci.probe_rci_access(token="valid-token")

    assert result.ok is True
    assert result.state == "available"
    assert result.token_configured is True


def test_startup_rci_check_logs_invalid_token_without_secret(monkeypatch):
    import app_factory
    from services import keenetic_rci

    records = []
    monkeypatch.setattr(
        keenetic_rci,
        "probe_rci_access",
        lambda: keenetic_rci.RciAccessStatus("invalid_token", True, 403),
    )
    monkeypatch.setattr(
        "core.logging.core_log_once",
        lambda level, key, message, **extra: records.append((level, key, message, extra)),
    )

    status = app_factory._check_keenetic_rci_access()

    assert status == {"state": "invalid_token", "ok": False, "token_configured": True, "http_status": 403}
    assert records[0][0:2] == ("warning", "keenetic_rci_token_invalid")
    assert "wrong-token" not in repr(records)


def test_xray_device_list_request_uses_token_from_xkeen_config(tmp_path: Path, monkeypatch):
    from services import xray_device_names

    config = tmp_path / "xkeen.json"
    config.write_text('{"xkeen":{"rci_token":"router-token"}}', encoding="utf-8")
    monkeypatch.setenv("XKEEN_CONFIG_FILE", str(config))
    captured = {}

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self, _limit):
            return b'{"host":[]}'

    def fake_urlopen(request, timeout):
        captured["request"] = request
        captured["timeout"] = timeout
        return Response()

    monkeypatch.setattr(xray_device_names.urllib.request, "urlopen", fake_urlopen)
    assert xray_device_names._fetch_router_device_list() == {"host": []}
    headers = {name.lower(): value for name, value in captured["request"].header_items()}
    assert headers["x-ndma-tkn"] == "router-token"


def test_config_export_redacts_rci_token(tmp_path: Path, monkeypatch):
    from services import config_exchange_local

    config = tmp_path / "xkeen.json"
    config.write_text(
        '{"xkeen":{"rci_token":"must-not-leak","killswitch":"on"}}',
        encoding="utf-8",
    )
    monkeypatch.setattr(config_exchange_local, "XKEEN_CONFIG_FILE", str(config))
    monkeypatch.setattr(config_exchange_local, "PORT_PROXYING_FILE", str(tmp_path / "ports.lst"))
    monkeypatch.setattr(config_exchange_local, "PORT_EXCLUDE_FILE", str(tmp_path / "exclude.lst"))
    monkeypatch.setattr(config_exchange_local, "IP_EXCLUDE_FILE", str(tmp_path / "ip.lst"))

    bundle = config_exchange_local.build_user_configs_bundle()
    item = next(entry for entry in bundle["files"] if entry["path"] == "xkeen/xkeen.json")
    exported = json.loads(item["content"])

    assert exported["xkeen"]["rci_token"] == ""
    assert exported["xkeen"]["killswitch"] == "on"
    assert "must-not-leak" not in json.dumps(bundle)


def test_config_import_preserves_router_local_rci_token(tmp_path: Path, monkeypatch):
    from services import config_exchange_local

    config = tmp_path / "xkeen.json"
    config.write_text(
        '{"xkeen":{"rci_token":"local-router-token","killswitch":"on"}}',
        encoding="utf-8",
    )
    monkeypatch.setattr(config_exchange_local, "XKEEN_CONFIG_FILE", str(config))

    config_exchange_local.apply_user_configs_bundle(
        {
            "files": [
                {
                    "path": "xkeen/xkeen.json",
                    "kind": "text",
                    "content": '{"xkeen":{"rci_token":"","killswitch":"off"}}',
                }
            ]
        }
    )

    restored = json.loads(config.read_text(encoding="utf-8"))
    assert restored["xkeen"]["rci_token"] == "local-router-token"
    assert restored["xkeen"]["killswitch"] == "off"


def test_shell_rci_clients_use_x_ndma_tkn_header():
    root = Path(__file__).resolve().parents[1] / "xkeen-ui" / "tools"
    for name in ("sysmon_keenetic.sh", "entware_backup.sh", "version_check.sh"):
        text = (root / name).read_text(encoding="utf-8")
        assert "X-Ndma-Tkn" in text
        assert "rci_token" in text


def test_panel_explains_keeneticos_52_rci_token_location():
    root = Path(__file__).resolve().parents[1] / "xkeen-ui" / "templates"
    for name in ("panel.html", "xkeen.html"):
        text = (root / name).read_text(encoding="utf-8")
        assert "KeeneticOS 5.2+" in text
        assert "rci_token" in text
        assert "Пользователи и доступ" in text


def test_saving_xkeen_config_restricts_file_permissions(tmp_path: Path, monkeypatch):
    from services import xkeen_lists

    config = tmp_path / "xkeen.json"
    monkeypatch.setitem(xkeen_lists._KIND_TO_PATH, xkeen_lists.KIND_CONFIG, str(config))
    xkeen_lists.set_list_content(xkeen_lists.KIND_CONFIG, '{"xkeen":{"rci_token":"secret"}}')

    assert config.read_text(encoding="utf-8").endswith('"}}')
    if os.name != "nt":
        assert config.stat().st_mode & 0o777 == 0o600
