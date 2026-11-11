from __future__ import annotations

import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "check_xkeen_commands.py"


def run_check(path: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable, str(SCRIPT), str(path)], capture_output=True, text=True, encoding="utf-8")


def test_reports_commands_from_help_and_old_catalog_entries(tmp_path: Path) -> None:
    help_file = tmp_path / "xkeen help.txt"
    help_file.write_text("\x1b[33mОбновление\x1b[0m\n\t-uk\tXKeen\n\t-newflag\tНовое\n\t-newflag\tНовое\n\t-i auto\tустановка\n", encoding="utf-8")
    result = run_check(help_file)
    assert result.returncode == 0
    assert "-newflag" in result.stdout
    assert "-drk" in result.stdout
    assert "-uk" not in result.stdout
    assert "-i " not in result.stdout


def test_rejects_empty_or_unrecognized_help(tmp_path: Path) -> None:
    help_file = tmp_path / "bad.txt"
    help_file.write_text("Ошибка запуска -uk\n", encoding="utf-8")
    result = run_check(help_file)
    assert result.returncode != 0
    assert "справ" in result.stderr.lower()


def test_missing_file_reports_error(tmp_path: Path) -> None:
    result = run_check(tmp_path / "missing.txt")
    assert result.returncode != 0
    assert "traceback" not in result.stderr.lower()
