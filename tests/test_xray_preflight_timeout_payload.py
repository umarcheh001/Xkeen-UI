from __future__ import annotations

import importlib.util
import subprocess
import sys
import types
from pathlib import Path


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


def test_run_xray_preflight_includes_timeout_limit_on_failed_check(tmp_path, monkeypatch):
    confdir = tmp_path / "configs"
    confdir.mkdir()
    (confdir / "00_base.json").write_text('{"log":{}}\n', encoding="utf-8")

    monkeypatch.setenv("XKEEN_XRAY_TEST_TIMEOUT", "9")

    def fake_run(cmd, capture_output, text, timeout, check):
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

    def fake_run(cmd, capture_output, text, timeout, check):
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
