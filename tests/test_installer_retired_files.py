"""Файлы, которые прежние сборки ставили, а эта больше не ставит, установщик убирает.

Манифест разложенных файлов (install-managed.json) появился 02.10.2026, релизы
v2.9.x его не вели. Первая модульная установка поверх такой панели угадывает,
какие файлы её, и код ядра в угаданный набор не попадает: на 10.1 так остались
пять файлов прежнего обновления, удалённых из git 11.10.2026. Поэтому сборщик
архива кладёт в архив retired-files.json — пути, которые когда-то были в
xkeen-ui/ и больше не поставляются (по истории git), — а установщик убирает их
в той же транзакции: откат их возвращает, успешный запуск удаляет. Файлы
владельца и состояния панели не трогаются.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "xkeen-ui" / "scripts" / "module_profile_install.py"
BUILDER = ROOT / "scripts" / "build_user_archive.py"

RETIRED_CODE = (
    "scripts/update_xkeen_ui.sh",
    "services/self_update/github.py",
    "static/js/features/update_notifier.js",
)
# Есть в списке, но принадлежит владельцу или состоянию панели — не трогать.
NOT_OURS = (
    "secret.key",
    "devtools.env",
    "modules.json",
    "bin/happ-decrypt-universal",
    "xray-jsonc/05_routing.jsonc",
    "templates/routing/05_routing_base.jsonc",
    "opt/etc/mihomo/backup/default.yaml",
    "opt/etc/mihomo/profiles/home.yaml",
    "opt/etc/mihomo/config.yaml",
)


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def helper():
    return _load("module_profile_install_retired", SCRIPT)


def _source(root: Path, retired: list[str] | None) -> Path:
    src = root / "source"
    files = {
        "app.py": "app = None",
        "services/module_registry.py": "# registry",
        "services/xray_subscriptions.py": "# xray subscriptions",
        "services/mihomo_subscriptions.py": "# mihomo subscriptions",
        "routes/routing/__init__.py": "# xray package",
        "routes/routing/blueprint.py": "# xray route",
        "routes/mihomo.py": "# mihomo route",
        "static/js/pages/terminal.lazy.entry.js": "terminal",
        "static/js/pages/file_manager.lazy.entry.js": "files",
        "routes/backups.py": "# backups route",
        "routes/happ_decryptor.py": "# happ route",
        "services/happ_decryptor/__init__.py": "# happ service",
        "routes/devtools.py": "# devtools route",
        "templates/devtools.html": "devtools",
        "routes/system_resources.py": "# diagnostics route",
        "static/js/features/resource_monitor.js": "diagnostics window",
        "static/js/pages/codemirror6.shared.js": "light editor",
    }
    for name, data in files.items():
        path = src / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(data, encoding="utf-8")
    if retired is not None:
        (src / "retired-files.json").write_text(json.dumps({"schema_version": 1, "paths": retired}), encoding="utf-8")
    return src


def _lay(dest: Path, paths) -> None:
    for rel in paths:
        path = dest / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"old {rel}", encoding="utf-8")


def test_retired_code_left_by_a_release_without_manifest_is_removed(tmp_path, helper):
    src = _source(tmp_path, list(RETIRED_CODE))
    dest = tmp_path / "installed"
    _lay(dest, RETIRED_CODE)

    transaction = helper.apply_profile(src, dest, "full")

    assert not [rel for rel in RETIRED_CODE if (dest / rel).exists()]
    helper.commit_profile(transaction)
    # Набор угадан, и карантин угаданного остаётся на всякий случай; но
    # вышедшие из поставки файлы — точно наши, им рядом с панелью не место.
    assert not (transaction / "retired").exists()


def test_rollback_brings_retired_files_back(tmp_path, helper):
    src = _source(tmp_path, list(RETIRED_CODE))
    dest = tmp_path / "installed"
    _lay(dest, RETIRED_CODE)

    transaction = helper.apply_profile(src, dest, "full")
    helper.rollback_profile(transaction)

    assert all((dest / rel).read_text(encoding="utf-8") == f"old {rel}" for rel in RETIRED_CODE)


def test_files_of_the_owner_and_panel_state_are_never_touched(tmp_path, helper):
    src = _source(tmp_path, list(NOT_OURS) + ["../outside.txt", "/etc/passwd"])
    dest = tmp_path / "installed"
    _lay(dest, [rel for rel in NOT_OURS if rel != "modules.json"])
    outside = tmp_path / "outside.txt"
    outside.write_text("user data", encoding="utf-8")

    helper.commit_profile(helper.apply_profile(src, dest, "full"))

    for rel in NOT_OURS:
        if rel != "modules.json":
            assert (dest / rel).read_text(encoding="utf-8") == f"old {rel}", rel
    assert outside.read_text(encoding="utf-8") == "user data"


def test_a_path_that_ships_again_is_not_removed(tmp_path, helper):
    # Путь удаляли из git, а потом вернули: новая сборка его ставит.
    src = _source(tmp_path, ["routes/mihomo.py"])
    dest = tmp_path / "installed"

    helper.commit_profile(helper.apply_profile(src, dest, "full"))

    assert (dest / "routes/mihomo.py").read_text(encoding="utf-8") == "# mihomo route"


def test_an_archive_without_the_list_installs_as_before(tmp_path, helper):
    src = _source(tmp_path, None)
    dest = tmp_path / "installed"
    _lay(dest, RETIRED_CODE)

    helper.commit_profile(helper.apply_profile(src, dest, "full"))

    assert all((dest / rel).is_file() for rel in RETIRED_CODE)


def test_a_broken_list_does_not_stop_the_install(tmp_path, helper):
    src = _source(tmp_path, None)
    (src / "retired-files.json").write_text("{not json", encoding="utf-8")
    dest = tmp_path / "installed"

    helper.commit_profile(helper.apply_profile(src, dest, "full"))

    assert (dest / "app.py").is_file()


@pytest.fixture
def builder():
    return _load("build_user_archive_retired", BUILDER)


def test_the_builder_lists_paths_that_left_the_package(tmp_path, builder):
    package = tmp_path / "xkeen-ui"
    (package / "routes").mkdir(parents=True)
    (package / "routes" / "mihomo.py").write_text("x", encoding="utf-8")

    builder.write_retired_files(
        package,
        deleted=["xkeen-ui/scripts/update_xkeen_ui.sh", "xkeen-ui/routes/mihomo.py", "docs/old.md", "xkeen-ui/a/b.py"],
    )

    listed = json.loads((package / "retired-files.json").read_text(encoding="utf-8"))
    assert listed == {"schema_version": 1, "paths": ["a/b.py", "scripts/update_xkeen_ui.sh"]}


def test_the_real_history_knows_the_removed_updater():
    builder = _load("build_user_archive_retired_real", BUILDER)
    deleted = builder.retired_from_git(ROOT)

    assert "xkeen-ui/scripts/update_xkeen_ui.sh" in deleted
    assert "xkeen-ui/services/self_update/github.py" in deleted


def test_both_builds_write_the_list_before_the_map_and_the_stamp():
    source = BUILDER.read_text(encoding="utf-8").split("def main()", 1)[1]
    workflow = (ROOT / ".github" / "workflows" / "build-user-archive.yml").read_text(encoding="utf-8")

    assert source.index("write_retired_files(package_root)") < source.index("write_module_ownership_map(package_root)")
    assert workflow.index("builder.write_retired_files(root, strict=True)") < workflow.index("builder.write_module_ownership_map(")
