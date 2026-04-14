from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_SRC = REPO_ROOT / "xkeen-ui" / "tools" / "version_check.sh"
ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def _find_sh() -> str | None:
    candidates = [
        shutil.which("sh"),
        r"C:\Program Files\Git\bin\sh.exe",
        r"C:\Program Files\Git\usr\bin\sh.exe",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return str(candidate)
    return None


SH_PATH = _find_sh()
pytestmark = pytest.mark.skipif(not SH_PATH, reason="POSIX shell is not available")


def _write_exec(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


def _strip_ansi(text: str) -> str:
    return ANSI_RE.sub("", text)


def _run_version_check(
    tmp_path: Path,
    component: str,
    *,
    build_info: dict[str, str] | None = None,
    xkeen_output: str | None = None,
    opkg_lines: list[str] | None = None,
    cache_ns: str = "v2",
    legacy_cache_entries: dict[str, str] | None = None,
    curl_payloads: dict[str, str] | None = None,
    offline: bool = True,
) -> str:
    project_dir = tmp_path / "xkeen-ui"
    tools_dir = project_dir / "tools"
    bin_dir = tmp_path / "bin"
    cache_dir = tmp_path / "cache"

    tools_dir.mkdir(parents=True)
    bin_dir.mkdir()
    cache_dir.mkdir()

    script_dst = tools_dir / "version_check.sh"
    script_dst.write_text(SCRIPT_SRC.read_text(encoding="utf-8"), encoding="utf-8")
    script_dst.chmod(script_dst.stat().st_mode | stat.S_IEXEC)

    if build_info is not None:
        (project_dir / "BUILD.json").write_text(json.dumps(build_info), encoding="utf-8")

    if xkeen_output is not None:
        _write_exec(
            bin_dir / "xkeen",
            "#!/bin/sh\n"
            "if [ \"$1\" = \"-v\" ] || [ \"$1\" = \"--version\" ]; then\n"
            f"  printf '%s\\n' '{xkeen_output}'\n"
            "  exit 0\n"
            "fi\n"
            "exit 1\n",
        )

    if opkg_lines is not None:
        body = ["#!/bin/sh", "if [ \"$1\" = \"list-installed\" ]; then"]
        for line in opkg_lines:
            body.append(f"  printf '%s\\n' '{line}'")
        body.extend(["  exit 0", "fi", "exit 0", ""])
        _write_exec(bin_dir / "opkg", "\n".join(body))

    if curl_payloads is not None:
        body = [
            "#!/bin/sh",
            "url=\"$@\"",
        ]
        for url, payload in curl_payloads.items():
            body.extend(
                [
                    f"printf '%s' \"$url\" | grep -F -- '{url}' >/dev/null 2>&1 && {{ printf '%s' '{payload}'; exit 0; }}",
                ]
            )
        body.extend(["exit 1", ""])
        _write_exec(bin_dir / "curl", "\n".join(body))

    if legacy_cache_entries:
        for key, value in legacy_cache_entries.items():
            (cache_dir / key).write_text(value, encoding="utf-8")

    env = os.environ.copy()
    env["PATH"] = str(bin_dir) + os.pathsep + env.get("PATH", "")
    env["XKEEN_UI_CACHE_DIR"] = str(cache_dir)
    env["XKEEN_UI_CACHE_NS"] = cache_ns

    args = [SH_PATH, str(script_dst)]
    if offline:
        args.append("--offline")
    args.extend(["--component", component])

    result = subprocess.run(
        args,
        cwd=str(REPO_ROOT),
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    return _strip_ansi(result.stdout)


def test_version_check_reads_panel_version_from_build_json(tmp_path: Path) -> None:
    output = _run_version_check(
        tmp_path,
        "xkeen-ui",
        build_info={"version": "v1.7.7", "repo": "umarcheh001/Xkeen-UI"},
    )

    assert "xkeen-ui" in output
    assert "1.7.7" in output
    assert "7.7" not in output.replace("1.7.7", "")
    assert "╔" in output
    assert "╚" in output


def test_version_check_reads_xkeen_version_from_cli_output(tmp_path: Path) -> None:
    output = _run_version_check(
        tmp_path,
        "xkeen",
        xkeen_output="XKeen 1.1.3.10 Beta (build time: 2026-03-01 15:09:25 MSK)",
    )

    assert "xkeen" in output
    assert "1.1.3.10 Beta" in output
    assert "3.10 Beta" not in output.replace("1.1.3.10 Beta", "")


def test_version_check_lists_installed_entware_packages(tmp_path: Path) -> None:
    output = _run_version_check(
        tmp_path,
        "entware",
        opkg_lines=[
            "bash - 5.2.37-1",
            "xray-core - 25.10.15-1",
        ],
    )

    assert "2" in output
    assert "bash" in output
    assert "5.2.37-1" in output
    assert "xray-core" in output
    assert "25.10.15-1" in output


def test_version_check_ignores_legacy_cached_bad_ui_version(tmp_path: Path) -> None:
    output = _run_version_check(
        tmp_path,
        "xkeen-ui",
        build_info={"version": "v1.7.7", "repo": "umarcheh001/Xkeen-UI"},
        legacy_cache_entries={"github_umarcheh001_Xkeen-UI": "7.7"},
        curl_payloads={
            "https://api.github.com/repos/umarcheh001/Xkeen-UI/releases/latest":
                '{"tag_name":"v1.7.7"}'
        },
        offline=False,
    )

    assert "1.7.7" in output
    assert "7.7" not in output.replace("1.7.7", "")
