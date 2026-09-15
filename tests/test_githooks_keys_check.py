"""Git hooks that run scripts/check_keys_upstream.py after `git pull` (enabled with `git config core.hooksPath .githooks`)."""

from __future__ import annotations

import os
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
HOOKS = ROOT / ".githooks"


def _find_sh() -> str | None:
    for candidate in (shutil.which("sh"), r"C:\Program Files\Git\bin\sh.exe", r"C:\Program Files\Git\usr\bin\sh.exe"):
        if candidate and Path(candidate).exists():
            return str(candidate)
    return None


SH = _find_sh()
needs_sh = pytest.mark.skipif(not SH, reason="POSIX shell is not available")


def _fake_repo(tmp_path: Path, python_exit: int | None) -> tuple[Path, Path, Path]:
    """Copy of the hooks next to a stub script; a stub python on PATH records its arguments."""
    repo = tmp_path / "repo"
    (repo / "scripts").mkdir(parents=True)
    (repo / "scripts" / "check_keys_upstream.py").write_text("# stub\n", encoding="utf-8")
    shutil.copytree(HOOKS, repo / ".githooks")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "python.log"
    if python_exit is not None:
        stub = bin_dir / "python3"
        stub.write_text(
            "#!/bin/sh\n"
            'if [ "$1" = "--version" ]; then echo "Python 3.12"; exit 0; fi\n'
            f'echo "$@" >> "{log.as_posix()}"\n'
            'echo "Ключи у автора изменились: crypt5-keys.json."\n'
            f"exit {python_exit}\n",
            encoding="utf-8",
        )
        stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
    return repo, bin_dir, log


def _run_hook(repo: Path, bin_dir: Path, name: str, *args: str, env_extra: dict[str, str] | None = None):
    # The hooks use only shell built-ins, so PATH holds nothing but the stub python. Adding the
    # directory of sh would leak a real python3 on Linux runners (/usr/bin) and break the checks.
    env = {"PATH": str(bin_dir), "GIT_DIR_FOR_TEST": str(repo)}
    env.update(env_extra or {})
    return subprocess.run(
        [SH, str(repo / ".githooks" / name), *args],
        cwd=str(repo),
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )


@needs_sh
def test_post_merge_runs_the_check_and_never_fails_the_pull(tmp_path):
    repo, bin_dir, log = _fake_repo(tmp_path, python_exit=1)

    result = _run_hook(repo, bin_dir, "post-merge", "0")

    assert result.returncode == 0
    assert "scripts/check_keys_upstream.py" in log.read_text(encoding="utf-8")
    assert "[проверка ключей]" in result.stdout
    assert "изменились" in result.stdout


@needs_sh
@pytest.mark.parametrize("arg,expected_calls", [("rebase", 1), ("amend", 0)])
def test_post_rewrite_checks_only_after_rebase(tmp_path, arg, expected_calls):
    repo, bin_dir, log = _fake_repo(tmp_path, python_exit=0)

    result = _run_hook(repo, bin_dir, "post-rewrite", arg)

    assert result.returncode == 0
    calls = log.read_text(encoding="utf-8").splitlines() if log.exists() else []
    assert len(calls) == expected_calls


@needs_sh
def test_hook_skips_quietly_without_python(tmp_path):
    repo, bin_dir, log = _fake_repo(tmp_path, python_exit=None)

    result = _run_hook(repo, bin_dir, "post-merge", "0")

    assert result.returncode == 0
    assert not log.exists()
    assert "Python" in result.stdout


@needs_sh
def test_hook_can_be_switched_off(tmp_path):
    repo, bin_dir, log = _fake_repo(tmp_path, python_exit=0)

    result = _run_hook(repo, bin_dir, "post-merge", "0", env_extra={"XKEEN_SKIP_KEYS_CHECK": "1"})

    assert result.returncode == 0
    assert not log.exists()
    assert result.stdout == ""


def test_hooks_are_executable_in_git():
    listed = subprocess.run(
        ["git", "ls-files", "-s", ".githooks"], cwd=str(ROOT), text=True, capture_output=True, check=True
    ).stdout.splitlines()
    modes = {line.split("\t", 1)[1]: line.split()[0] for line in listed}
    for name in (".githooks/post-merge", ".githooks/post-rewrite", ".githooks/keys-check.sh"):
        assert modes.get(name) == "100755", f"{name} must be tracked as executable"
