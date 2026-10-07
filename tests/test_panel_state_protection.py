"""Служебные данные панели нельзя стереть из её же файлового менеджера."""

from __future__ import annotations

from pathlib import Path

import pytest

from services import xray_subscriptions as subs
from services.fs_common import local


@pytest.fixture
def panel(tmp_path: Path):
    state = tmp_path / "opt" / "etc" / "xkeen-ui"
    store = Path(subs.paused_store_dir(str(state)))
    store.mkdir(parents=True)
    (store / "04_outbounds.alpha.json").write_text("{}", encoding="utf-8")
    (state / subs.STATE_FILENAME).write_text("{}", encoding="utf-8")
    (state / "notes.txt").write_text("mine", encoding="utf-8")
    (tmp_path / "opt" / "etc" / "other").mkdir()
    saved = dict(local._PANEL_PROTECTED)
    local._PANEL_PROTECTED.clear()
    for path, subtree in subs.protected_state_paths(str(state)):
        local.protect_local_path(path, subtree=subtree)
    yield state
    local._PANEL_PROTECTED.clear()
    local._PANEL_PROTECTED.update(saved)


def _roots(tmp_path: Path) -> list[str]:
    return [str(tmp_path)]


def _protected(panel: Path, tmp_path: Path) -> list[Path]:
    store = Path(subs.paused_store_dir(str(panel)))
    return [
        store / "04_outbounds.alpha.json",
        store,
        store.parent,
        panel / subs.STATE_FILENAME,
        panel,
        # Каталог выше унёс бы с собой всё перечисленное.
        tmp_path / "opt" / "etc",
        tmp_path / "opt",
    ]


@pytest.mark.parametrize("hard", [False, True])
def test_delete_is_refused_with_an_explanation(panel: Path, tmp_path: Path, hard: bool):
    for path in _protected(panel, tmp_path):
        with pytest.raises(PermissionError) as excinfo:
            local._local_soft_delete(str(path), _roots(tmp_path), hard=hard)
        assert str(excinfo.value) == local.PROTECTED_PANEL_DATA_MESSAGE, path
        assert path.exists(), path


def test_what_is_not_panel_data_is_deleted_as_before(panel: Path, tmp_path: Path):
    local._local_soft_delete(str(panel / "notes.txt"), _roots(tmp_path), hard=True)
    local._local_soft_delete(str(tmp_path / "opt" / "etc" / "other"), _roots(tmp_path), hard=True)

    assert not (panel / "notes.txt").exists()
    assert not (tmp_path / "opt" / "etc" / "other").exists()


def test_rename_move_and_overwrite_see_the_same_protection(panel: Path, tmp_path: Path):
    for path in _protected(panel, tmp_path):
        assert local._local_is_protected_entry_abs(str(path)), path
        assert local.local_protection_error(str(path)) == local.PROTECTED_PANEL_DATA_MESSAGE
    # Новый файл в хранилище отложенных узлов тоже не создать.
    stray = Path(subs.paused_store_dir(str(panel))) / "stray.json"
    assert local._local_is_protected_entry_abs(str(stray))

    assert not local._local_is_protected_entry_abs(str(panel / "notes.txt"))
    assert not local._local_is_protected_entry_abs(str(panel / "new-file.txt"))
    assert local.local_protection_error(str(panel / "notes.txt")) == ""


def test_the_explanation_says_what_the_data_is_for():
    assert "служебные данные панели" in local.PROTECTED_PANEL_DATA_MESSAGE
    assert "файлового менеджера" in local.PROTECTED_PANEL_DATA_MESSAGE
