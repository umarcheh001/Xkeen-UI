import os

from services.local_module_demo import (
    configure_local_core_binaries,
    configure_local_runtime,
    configure_local_tools,
    ensure_local_mihomo_api,
)


def test_local_demo_cores_use_executable_files_and_preserve_explicit_paths(tmp_path):
    core_dir = tmp_path / ".tmp" / "diagnostics-cores"
    core_dir.mkdir(parents=True)
    xray = core_dir / "xray"
    mihomo = core_dir / "mihomo"
    xray.write_text("core", encoding="utf-8")
    mihomo.write_text("core", encoding="utf-8")
    xray.chmod(0o755)
    mihomo.chmod(0o644)

    env = {"MIHOMO_BIN": "/custom/mihomo"}
    assert configure_local_core_binaries(tmp_path, environ=env) == {"xray": str(xray)}
    assert env == {"XKEEN_XRAY_BINARY": str(xray), "MIHOMO_BIN": "/custom/mihomo"}

    mihomo.chmod(0o755)
    assert configure_local_core_binaries(tmp_path, environ={}) == {
        "xray": str(xray), "mihomo": str(mihomo),
    }


def test_local_demo_runtime_uses_checkout_owned_mihomo_root(tmp_path, monkeypatch):
    monkeypatch.setenv("MIHOMO_ROOT", "/stale/router/path")

    configured = configure_local_runtime(tmp_path)

    expected = str(tmp_path / "xkeen-ui" / "opt" / "etc" / "mihomo")
    assert configured == {"mihomo_root": expected}
    assert os.environ["MIHOMO_ROOT"] == expected


def test_local_demo_mihomo_mock_can_be_disabled(tmp_path, monkeypatch):
    monkeypatch.setenv("XKEEN_UI_LOCAL_MIHOMO_MOCK", "0")

    assert ensure_local_mihomo_api(tmp_path) == {
        "ready": False,
        "started": False,
        "disabled": True,
    }


def test_local_tools_set_paths_and_preserve_user_overrides(tmp_path, monkeypatch):
    from unittest.mock import patch

    with patch("services.local_module_demo._ensure_local_go_tool") as build:
        build.side_effect = [
            {"ready": True, "path": "/local/xk-geodat"},
            {"ready": True, "path": "/local/happ-decrypt-universal"},
            {"ready": True, "path": "/local/xk-geodat"},
            {"ready": True, "path": "/local/happ-decrypt-universal"},
        ]
        monkeypatch.delenv("XKEEN_GEODAT_BIN", raising=False)
        monkeypatch.delenv("XKEEN_HAPP_DECRYPTOR_CMD", raising=False)
        configure_local_tools(tmp_path)
        assert os.environ["XKEEN_GEODAT_BIN"] == "/local/xk-geodat"
        assert os.environ["XKEEN_HAPP_DECRYPTOR_CMD"] == "/local/happ-decrypt-universal"

        monkeypatch.setenv("XKEEN_GEODAT_BIN", "/custom/geodat")
        monkeypatch.setenv("XKEEN_HAPP_DECRYPTOR_CMD", "/custom/decryptor")
        configure_local_tools(tmp_path)
        assert os.environ["XKEEN_GEODAT_BIN"] == "/custom/geodat"
        assert os.environ["XKEEN_HAPP_DECRYPTOR_CMD"] == "/custom/decryptor"
