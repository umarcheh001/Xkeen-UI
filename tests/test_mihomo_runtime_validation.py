from types import SimpleNamespace


def test_validate_config_expands_legacy_bare_binary(monkeypatch, tmp_path):
    from services import mihomo_runtime as runtime

    commands = []
    monkeypatch.setattr(runtime, "MIHOMO_ROOT", tmp_path)
    monkeypatch.setattr(runtime, "ensure_mihomo_layout", lambda: None)
    monkeypatch.setenv("MIHOMO_VALIDATE_CMD", "/opt/sbin/mihomo")

    def fake_run(command, **_kwargs):
        commands.append(command)
        return SimpleNamespace(stdout="validated", stderr="", returncode=0)

    monkeypatch.setattr(runtime.subprocess, "run", fake_run)

    result = runtime.validate_config(new_content="mixed-port: 7890\n")

    assert "[exit code: 0]" in result
    assert commands == [
        f"/opt/sbin/mihomo -t -d {tmp_path} -f {tmp_path / 'config-validate.yaml'}"
    ]


def test_validate_config_preserves_explicit_template(monkeypatch, tmp_path):
    from services import mihomo_runtime as runtime

    commands = []
    monkeypatch.setattr(runtime, "MIHOMO_ROOT", tmp_path)
    monkeypatch.setattr(runtime, "ensure_mihomo_layout", lambda: None)
    monkeypatch.setenv("MIHOMO_VALIDATE_CMD", "custom-validator --input {config}")

    def fake_run(command, **_kwargs):
        commands.append(command)
        return SimpleNamespace(stdout="validated", stderr="", returncode=0)

    monkeypatch.setattr(runtime.subprocess, "run", fake_run)

    runtime.validate_config(new_content="mixed-port: 7890\n")

    assert commands == [
        f"custom-validator --input {tmp_path / 'config-validate.yaml'}"
    ]
