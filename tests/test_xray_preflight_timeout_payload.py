from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import types
from pathlib import Path

from flask import Blueprint, Flask


ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "xkeen-ui" / "routes" / "routing" / "config.py"
ROUTES_DIR = ROOT / "xkeen-ui" / "routes"
ROUTING_DIR = ROUTES_DIR / "routing"


def _load_routing_config_module():
    prev_routes = sys.modules.get("routes")
    prev_routing = sys.modules.get("routes.routing")
    prev_config = sys.modules.get("routes.routing.config")
    prev_command_jobs = sys.modules.get("services.command_jobs")

    try:
        routes_pkg = prev_routes
        if routes_pkg is None:
            routes_pkg = types.ModuleType("routes")
            routes_pkg.__path__ = [str(ROUTES_DIR)]
            sys.modules["routes"] = routes_pkg

        routing_pkg = types.ModuleType("routes.routing")
        routing_pkg.__path__ = [str(ROUTING_DIR)]
        sys.modules["routes.routing"] = routing_pkg

        command_jobs_stub = types.ModuleType("services.command_jobs")
        command_jobs_stub.create_command_job = lambda *args, **kwargs: None
        sys.modules["services.command_jobs"] = command_jobs_stub

        spec = importlib.util.spec_from_file_location("routes.routing.config", CONFIG_PATH)
        module = importlib.util.module_from_spec(spec)
        sys.modules["routes.routing.config"] = module
        assert spec and spec.loader
        spec.loader.exec_module(module)
        return module
    finally:
        if prev_routes is not None:
            sys.modules["routes"] = prev_routes
        else:
            sys.modules.pop("routes", None)

        if prev_routing is not None:
            sys.modules["routes.routing"] = prev_routing
        else:
            sys.modules.pop("routes.routing", None)

        if prev_config is not None:
            sys.modules["routes.routing.config"] = prev_config
        else:
            sys.modules.pop("routes.routing.config", None)

        if prev_command_jobs is not None:
            sys.modules["services.command_jobs"] = prev_command_jobs
        else:
            sys.modules.pop("services.command_jobs", None)


routing_config = _load_routing_config_module()


def test_run_xray_preflight_defaults_to_30_second_timeout_for_all_routers(tmp_path, monkeypatch):
    confdir = tmp_path / "configs"
    confdir.mkdir()
    (confdir / "00_base.json").write_text('{"log":{}}\n', encoding="utf-8")

    monkeypatch.delenv("XKEEN_XRAY_TEST_TIMEOUT", raising=False)

    def fake_run(cmd, capture_output, text, timeout, check, **_kwargs):
        assert timeout == 30
        return subprocess.CompletedProcess(cmd, 0, stdout="ok", stderr="")

    monkeypatch.setattr(routing_config.subprocess, "run", fake_run)

    result = routing_config._run_xray_preflight(
        xray_configs_dir_real=str(confdir),
        sel_main=str(confdir / "03_routing.json"),
        obj={"routing": {"rules": []}},
    )

    assert result["ok"] is True
    assert result["timeout_s"] == 30


def test_run_xray_preflight_includes_timeout_limit_on_failed_check(tmp_path, monkeypatch):
    confdir = tmp_path / "configs"
    confdir.mkdir()
    (confdir / "00_base.json").write_text('{"log":{}}\n', encoding="utf-8")

    monkeypatch.setenv("XKEEN_XRAY_TEST_TIMEOUT", "9")

    def fake_run(cmd, capture_output, text, timeout, check, **_kwargs):
        assert capture_output is True
        assert text is True
        assert check is False
        assert timeout == 9
        return subprocess.CompletedProcess(cmd, 23, stdout="warn", stderr="failed to load config")

    monkeypatch.setattr(routing_config.subprocess, "run", fake_run)

    result = routing_config._run_xray_preflight(
        xray_configs_dir_real=str(confdir),
        sel_main=str(confdir / "03_routing.json"),
        obj={"routing": {"rules": []}},
    )

    assert result["ok"] is False
    assert result["returncode"] == 23
    assert result["timeout_s"] == 9
    assert result["timed_out"] is False
    assert result["cmd"].startswith("xray -test -confdir ")


def test_run_xray_preflight_timeout_uses_temp_confdir_in_command(tmp_path, monkeypatch):
    confdir = tmp_path / "configs"
    confdir.mkdir()
    (confdir / "00_base.json").write_text('{"log":{}}\n', encoding="utf-8")

    monkeypatch.setenv("XKEEN_XRAY_TEST_TIMEOUT", "11")

    def fake_run(cmd, capture_output, text, timeout, check, **_kwargs):
        raise subprocess.TimeoutExpired(cmd, timeout, output="stdout timeout", stderr="stderr timeout")

    monkeypatch.setattr(routing_config.subprocess, "run", fake_run)

    result = routing_config._run_xray_preflight(
        xray_configs_dir_real=str(confdir),
        sel_main=str(confdir / "03_routing.json"),
        obj={"routing": {"rules": []}},
    )

    assert result["ok"] is False
    assert result["error"] == "xray test timeout"
    assert result["timeout_s"] == 11
    assert result["timed_out"] is True
    assert result["cmd"].startswith("xray -test -confdir ")
    assert str(confdir) not in result["cmd"]
    assert result["stdout"] == "stdout timeout"
    assert result["stderr"] == "stderr timeout"


def test_shorten_text_preserves_xray_root_cause_from_log_tail():
    head = "\n".join(f"warning line {i}" for i in range(160))
    tail = 'router: rule uses balancerTag "balancer-s" but balancer was not found'
    text = head + "\n" + tail

    shortened = routing_config._shorten_text(text, limit=240)

    assert '[truncated]' in shortened
    assert 'warning line 0' in shortened
    assert 'balancerTag "balancer-s"' in shortened
    assert 'balancer was not found' in shortened


def test_run_xray_preflight_blocks_dangling_outbound_reference_before_xray(tmp_path, monkeypatch):
    confdir = tmp_path / "configs"
    confdir.mkdir()
    (confdir / "04_outbounds.json").write_text(
        json.dumps(
            {
                "outbounds": [
                    {"tag": "proxy", "protocol": "freedom"},
                    {"tag": "direct", "protocol": "freedom"},
                ]
            },
            ensure_ascii=False,
        ) + "\n",
        encoding="utf-8",
    )

    calls = []

    def fake_run(cmd, capture_output, text, timeout, check, **_kwargs):
        calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, stdout="should not run", stderr="")

    monkeypatch.setattr(routing_config.subprocess, "run", fake_run)

    result = routing_config._run_xray_preflight(
        xray_configs_dir_real=str(confdir),
        sel_main=str(confdir / "05_routing.json"),
        obj={"routing": {"rules": [{"type": "field", "outboundTag": "vless-reality-00"}]}},
    )

    assert result["ok"] is False
    assert result["error"] == "routing semantic validation failed"
    assert result["phase"] == "routing_semantic_validate"
    assert result["cmd"] == "panel semantic validation (routing.rules -> outbounds[].tag)"
    assert 'outboundTag "vless-reality-00"' in result["stdout"]
    assert 'Создайте outbound с tag "vless-reality-00"' in result["hint"]
    assert calls == []


def test_routing_save_logs_failed_xray_preflight_with_modal_ref(tmp_path, monkeypatch):
    seen: list[tuple[bool, str, dict[str, object]]] = []
    saved: list[tuple[str, dict[str, object], str]] = []

    monkeypatch.setattr(
        routing_config,
        "_run_xray_preflight",
        lambda **_kwargs: {
            "ok": False,
            "error": "xray test failed",
            "phase": "xray_test",
            "cmd": "xray -test -confdir /tmp/xray",
            "returncode": 23,
            "timeout_s": 15,
            "timed_out": False,
            "stderr": "missing outboundTag proxy",
            "summary": "missing outboundTag proxy",
            "hint": "Исправьте ссылку на outbound.",
        },
    )

    bp = Blueprint("routing_preflight_log_test", __name__)
    routing_config.register_config_routes(
        bp,
        routing_file=str(tmp_path / "05_routing.json"),
        routing_file_raw=str(tmp_path / "jsonc" / "05_routing.jsonc"),
        xray_configs_dir=str(tmp_path),
        xray_configs_dir_real=str(tmp_path),
        backup_dir=str(tmp_path / "backups"),
        backup_dir_real=str(tmp_path / "backups"),
        load_json=lambda path, default=None: default,
        strip_json_comments_text=lambda text: text,
        restart_xkeen=lambda source="routing": True,
        append_restart_log=lambda ok, source="api", **meta: seen.append((ok, source, meta)),
        save_operation_diagnostic=lambda ref, payload, kind="generic": saved.append((ref, payload, kind)),
    )
    app = Flask("routing-preflight-log-test")
    app.register_blueprint(bp)

    response = app.test_client().post(
        "/api/routing",
        data=json.dumps({"rules": []}),
        content_type="application/json",
    )

    assert response.status_code == 400
    payload = response.get_json()
    assert payload["preflight_ref"].startswith("pf-")
    assert payload["can_skip_preflight"] is False
    assert seen
    ok, source, meta = seen[-1]
    assert ok is False
    assert source == "xray-preflight"
    assert meta["phase"] == "xray_test"
    assert meta["returncode"] == 23
    assert meta["preflight_ref"] == payload["preflight_ref"]
    assert saved
    saved_ref, saved_payload, saved_kind = saved[-1]
    assert saved_ref == payload["preflight_ref"]
    assert saved_kind == "xray-preflight"
    assert saved_payload["preflight_ref"] == payload["preflight_ref"]
    assert saved_payload["stderr"] == "missing outboundTag proxy"
    assert saved_payload["can_skip_preflight"] is False


def test_routing_save_marks_timed_out_xray_preflight_as_skippable(tmp_path, monkeypatch):
    monkeypatch.setattr(
        routing_config,
        "_run_xray_preflight",
        lambda **_kwargs: {
            "ok": False,
            "error": "xray test timeout",
            "phase": "xray_test",
            "cmd": "xray -test -confdir /tmp/xray",
            "timeout_s": 30,
            "timed_out": True,
            "stderr": "loading geosite",
            "summary": "Проверка не завершилась за отведённое время.",
            "hint": "Увеличьте таймаут проверки Xray.",
        },
    )

    bp = Blueprint("routing_preflight_skip_hint_test", __name__)
    routing_config.register_config_routes(
        bp,
        routing_file=str(tmp_path / "05_routing.json"),
        routing_file_raw=str(tmp_path / "jsonc" / "05_routing.jsonc"),
        xray_configs_dir=str(tmp_path),
        xray_configs_dir_real=str(tmp_path),
        backup_dir=str(tmp_path / "backups"),
        backup_dir_real=str(tmp_path / "backups"),
        load_json=lambda path, default=None: default,
        strip_json_comments_text=lambda text: text,
        restart_xkeen=lambda source="routing": True,
    )
    app = Flask("routing-preflight-skip-hint-test")
    app.register_blueprint(bp)

    response = app.test_client().post(
        "/api/routing",
        data=json.dumps({"routing": {"rules": []}}),
        content_type="application/json",
    )

    assert response.status_code == 400
    payload = response.get_json()
    assert payload["timed_out"] is True
    assert payload["can_skip_preflight"] is True


def test_routing_save_can_skip_xray_preflight_when_requested(tmp_path, monkeypatch):
    calls = []

    def fail_if_called(**_kwargs):
        calls.append(_kwargs)
        return {"ok": False, "error": "should not run"}

    monkeypatch.setattr(routing_config, "_run_xray_preflight", fail_if_called)

    bp = Blueprint("routing_preflight_skip_test", __name__)
    main_file = tmp_path / "05_routing.json"
    raw_file = tmp_path / "jsonc" / "05_routing.jsonc"
    monkeypatch.setenv("XKEEN_XRAY_ROUTING_FILE_RAW", str(raw_file))
    routing_config.register_config_routes(
        bp,
        routing_file=str(main_file),
        routing_file_raw=str(raw_file),
        xray_configs_dir=str(tmp_path),
        xray_configs_dir_real=str(tmp_path),
        backup_dir=str(tmp_path / "backups"),
        backup_dir_real=str(tmp_path / "backups"),
        load_json=lambda path, default=None: default,
        strip_json_comments_text=lambda text: text,
        restart_xkeen=lambda source="routing": True,
    )
    app = Flask("routing-preflight-skip-test")
    app.register_blueprint(bp)

    response = app.test_client().post(
        "/api/routing?restart=0&skip_preflight=1",
        data=json.dumps({"routing": {"rules": []}}),
        content_type="application/json",
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    assert payload["preflight_skipped"] is True
    assert calls == []
    assert json.loads(main_file.read_text(encoding="utf-8")) == {"routing": {"rules": []}}
    assert raw_file.read_text(encoding="utf-8") == json.dumps({"routing": {"rules": []}})


def test_run_xray_preflight_refreshes_xray_dat_assets_before_check(tmp_path, monkeypatch):
    confdir = tmp_path / "configs"
    confdir.mkdir()
    (confdir / "00_base.json").write_text('{"log":{}}\n', encoding="utf-8")

    dat_dir = tmp_path / "dat"
    asset_dir = tmp_path / "asset"
    dat_dir.mkdir()
    asset_dir.mkdir()
    monkeypatch.setenv("XRAY_DAT_DIR", str(dat_dir))
    monkeypatch.setenv("XRAY_ASSET_DIR", str(asset_dir))

    calls = []

    def fake_ensure_xray_dat_assets(*, dat_dir, asset_dir, log=None, diag=None):
        calls.append(("assets", dat_dir, asset_dir, callable(log), callable(diag)))

    def fake_run(cmd, capture_output, text, timeout, check, **kwargs):
        calls.append(("run", cmd, kwargs.get("env"), kwargs.get("cwd")))
        return subprocess.CompletedProcess(cmd, 0, stdout="ok", stderr="")

    monkeypatch.setattr(routing_config, "ensure_xray_dat_assets", fake_ensure_xray_dat_assets)
    monkeypatch.setattr(routing_config.subprocess, "run", fake_run)

    result = routing_config._run_xray_preflight(
        xray_configs_dir_real=str(confdir),
        sel_main=str(confdir / "03_routing.json"),
        obj={"routing": {"rules": []}},
    )

    assert result["ok"] is True
    assert result["asset_dir"] == str(dat_dir)
    assert calls[0] == ("assets", str(dat_dir), str(asset_dir), True, False)
    assert calls[1][0] == "run"
    assert calls[1][2]["XRAY_LOCATION_ASSET"] == str(dat_dir)
    assert calls[1][2]["xray.location.asset"] == str(dat_dir)
    assert calls[1][3] == str(dat_dir)


def test_run_xray_preflight_geodata_failure_explains_dat_asset_lookup(tmp_path, monkeypatch):
    confdir = tmp_path / "configs"
    dat_dir = tmp_path / "dat"
    confdir.mkdir()
    dat_dir.mkdir()
    (confdir / "00_base.json").write_text('{"log":{}}\n', encoding="utf-8")

    monkeypatch.setenv("XRAY_DAT_DIR", str(dat_dir))

    def fake_run(cmd, capture_output, text, timeout, check, **kwargs):
        assert kwargs.get("cwd") == str(dat_dir)
        assert kwargs.get("env", {}).get("XRAY_LOCATION_ASSET") == str(dat_dir)
        stderr = (
            "Failed to start: main: failed to load config files: [05_routing.json] "
            "> infra/conf: failed to build routing configuration "
            "> common/geodata: illegal domain rule: ext:geosite_v2fly.dat:category-ads-all "
            "> common/geodata: failed to check code CATEGORY-ADS-ALL from geosite_v2fly.dat > EOF"
        )
        return subprocess.CompletedProcess(cmd, 23, stdout="", stderr=stderr)

    monkeypatch.setattr(routing_config.subprocess, "run", fake_run)

    result = routing_config._run_xray_preflight(
        xray_configs_dir_real=str(confdir),
        sel_main=str(confdir / "05_routing.json"),
        obj={"routing": {"rules": [{"type": "field", "domain": ["ext:geosite_v2fly.dat:category-ads-all"]}]}},
    )

    assert result["ok"] is False
    assert result["returncode"] == 23
    assert result["asset_dir"] == str(dat_dir)
    assert "GeoSite/GeoIP DAT" in result["hint"]
    assert "XRAY_LOCATION_ASSET" in result["hint"]
