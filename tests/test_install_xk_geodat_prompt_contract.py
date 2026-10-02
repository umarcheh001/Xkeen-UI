from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "xkeen-ui" / "scripts" / "install_xk_geodat.sh"


def test_install_xk_geodat_prompt_only_accepts_explicit_yes() -> None:
    text = SCRIPT.read_text(encoding="utf-8")

    assert 'normalize_install_answer()' in text
    assert 'case "$ans_norm" in' in text
    assert '""|y|yes) INSTALL="1" ;;' in text
    assert 'n|no)     INSTALL="0" ;;' in text
    assert 'INSTALL="0"' in text
    assert 'ответ не распознан — пропуск' in text
    assert '*)         INSTALL="1" ;;' not in text


def _backup_functions() -> str:
    text = SCRIPT.read_text(encoding="utf-8")
    start = text.index("# -------------------- Backup/restore")
    end = text.index("# -------------------- Control")
    return text[start:end]


def _run_sh(script: str, workdir: Path) -> None:
    import shutil
    import subprocess

    import pytest

    shell = shutil.which("sh")
    if not shell:
        pytest.skip("нужен POSIX sh")
    subprocess.run([shell, "-c", script], cwd=workdir, check=True, capture_output=True)


def test_successful_install_leaves_no_backup_copy(tmp_path: Path) -> None:
    (tmp_path / "xk-geodat").write_text("old", encoding="utf-8")
    _run_sh(
        'DEST="$PWD/xk-geodat"\n'
        + _backup_functions()
        + '\nbackup_existing\nprintf new > "$DEST"\ndrop_backup\n',
        tmp_path,
    )

    assert (tmp_path / "xk-geodat").read_text(encoding="utf-8") == "new"
    assert not (tmp_path / "xk-geodat.bak").exists()


def test_failed_install_still_brings_the_old_binary_back(tmp_path: Path) -> None:
    (tmp_path / "xk-geodat").write_text("old", encoding="utf-8")
    _run_sh(
        'DEST="$PWD/xk-geodat"\n' + _backup_functions() + '\nbackup_existing\nrestore_backup\n',
        tmp_path,
    )

    assert (tmp_path / "xk-geodat").read_text(encoding="utf-8") == "old"


def test_every_successful_install_path_drops_the_backup() -> None:
    lines = SCRIPT.read_text(encoding="utf-8").splitlines()
    installed = [i for i, line in enumerate(lines) if 'echo "xk-geodat: installed to $DEST"' in line]

    assert len(installed) == 2
    for index in installed:
        assert lines[index + 1].strip() == "drop_backup"
