from pathlib import Path


def test_self_update_runner_keeps_stable_shell_pid_in_lock_and_status():
    runner_text = Path("xkeen-ui/scripts/update_xkeen_ui.sh").read_text(encoding="utf-8")

    assert 'RUNNER_PID="$$"' in runner_text
    assert 'export XKEEN_UI_UPDATE_RUNNER_PID="$RUNNER_PID"' in runner_text
    assert 'os.environ.get("XKEEN_UI_UPDATE_RUNNER_PID")' in runner_text
    assert '"pid": runner_pid' in runner_text
    assert "d = {\"pid\": runner_pid, \"created_ts\": created_ts}" in runner_text
    assert "d = {\"pid\": runner_pid, \"created_ts\": time.time()}" in runner_text
    assert 'd.setdefault("pid", runner_pid)' in runner_text
    assert "d.setdefault('pid', runner_pid)" in runner_text
    assert '"pid": os.getpid(),' not in runner_text
    assert 'd = {"pid": os.getpid(),' not in runner_text


def test_self_update_runner_releases_lock_only_on_final_exit():
    runner_text = Path("xkeen-ui/scripts/update_xkeen_ui.sh").read_text(encoding="utf-8")

    assert "trap cleanup EXIT" in runner_text
    assert "trap cleanup EXIT INT TERM" not in runner_text


def test_self_update_runner_has_actionable_busybox_tar_backup_failure_and_skip_flag():
    runner_text = Path("xkeen-ui/scripts/update_xkeen_ui.sh").read_text(encoding="utf-8")

    assert 'SKIP_BACKUP="${XKEEN_UI_UPDATE_SKIP_BACKUP:-0}"' in runner_text
    assert "tar_supports_exclude()" in runner_text
    assert "backup_tar_unsupported" in runner_text
    assert "opkg update && opkg install tar" in runner_text
    assert "Backup skipped by user request" in runner_text
