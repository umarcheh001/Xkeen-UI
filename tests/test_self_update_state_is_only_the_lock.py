"""Самообновлятор снят 11.10.2026: от services.self_update.state остались замок и папка.

Его status.json и update.log больше никто не пишет и не читает; установщик и
обновление их удаляют (provision_drop_retired_updater_files).
"""

from __future__ import annotations

from services.self_update import state


def test_update_paths_name_only_what_is_used(tmp_path):
    assert set(state.get_update_paths(str(tmp_path))) == {"update_dir", "lock_file"}


def test_the_retired_updater_left_no_code_behind():
    for name in (
        "read_status", "write_status", "reconcile_runtime_status", "read_update_log_tail",
        "tail_lines_fast", "ensure_update_dir", "get_backup_dir", "list_backups",
    ):
        assert not hasattr(state, name), name
