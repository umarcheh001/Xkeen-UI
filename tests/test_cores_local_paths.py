from __future__ import annotations

from services import cores


def test_available_cores_use_explicit_local_binary_paths(monkeypatch, tmp_path):
    xray = tmp_path / "xray"
    mihomo = tmp_path / "mihomo"
    xray.write_text("xray", encoding="utf-8")
    mihomo.write_text("mihomo", encoding="utf-8")
    xray.chmod(0o755)
    mihomo.chmod(0o755)

    monkeypatch.setenv("XKEEN_XRAY_BINARY", str(xray))
    monkeypatch.setenv("MIHOMO_BIN", str(mihomo))

    assert cores.detect_available_cores() == ["xray", "mihomo"]


def test_running_cores_fall_back_to_pgrep_when_pidof_is_missing(monkeypatch):
    calls = []

    class Result:
        returncode = 0
        stdout = "1234\n"

    def fake_run(command, **kwargs):
        calls.append(command)
        if command[0] == "pidof":
            raise FileNotFoundError(command[0])
        return Result()

    monkeypatch.setattr(cores.subprocess, "run", fake_run)

    assert cores.detect_running_cores() == ("xray", "mihomo")
    assert calls == [
        ["pidof", "xray"], ["pgrep", "-x", "xray"],
        ["pidof", "mihomo"], ["pgrep", "-x", "mihomo"],
    ]
