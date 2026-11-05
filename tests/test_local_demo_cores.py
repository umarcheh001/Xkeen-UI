from services.local_module_demo import configure_local_core_binaries


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
