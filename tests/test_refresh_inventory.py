"""Общая пересборка описей и проверка перед коммитом (scripts/refresh_inventory.py)."""

from __future__ import annotations

import json
from pathlib import Path

from scripts.refresh_inventory import GENERATORS, in_scope

ROOT = Path(__file__).resolve().parents[1]

# Generators that intentionally stay out of the refresh: the 3R.1 baseline is
# pinned to a historical commit, the sprite is part of `npm run frontend:build`.
NOT_REFRESHED = {"generate_modular_panel_stage3r1_baseline.py", "generate_operator_icon_sprite.py"}


def test_every_snapshot_generator_is_part_of_the_refresh():
    listed = {name for name, _ in GENERATORS}
    on_disk = {p.name for p in (ROOT / "scripts").glob("generate_*.py")}
    assert on_disk - NOT_REFRESHED <= listed, "новый генератор описи — добавьте его в GENERATORS"
    assert listed - {"sync_module_sizes.py"} <= on_disk


def test_stage0_inventory_and_sizes_run_last():
    names = [name for name, _ in GENERATORS]
    assert names[-2:] == ["generate_modular_panel_inventory.py", "sync_module_sizes.py"]


def test_scope_matches_what_the_inventory_reads():
    for rel in (
        "xkeen-ui/static/js/features/xray_log_view.js",
        "tests/test_check_release_tag.py",
        "e2e/panel_operator_stage4_logs.spec.mjs",
        "scripts/check_release_tag.py",
        ".github/workflows/ci.yml",
        "package.json",
        "docs/xray-logs-screen.md",
    ):
        assert in_scope(rel), rel
    for rel in ("README_DEVELOPER_HANDOFF.md", "RELEASING.md", "android-companion/app/build.gradle", "xkeen-ui/services/__pycache__/x.pyc"):
        assert not in_scope(rel), rel


def test_pre_commit_hook_runs_the_check_and_npm_exposes_both_commands():
    hook = (ROOT / ".githooks/pre-commit").read_text(encoding="utf-8")
    assert 'exec "$py" "$script" --check' in hook
    assert 'script="$hooks_dir/../scripts/refresh_inventory.py"' in hook
    assert "XKEEN_SKIP_INVENTORY_CHECK" in hook
    scripts = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["scripts"]
    assert scripts["inventory:refresh"] == "node scripts/run_python.mjs scripts/refresh_inventory.py"
    assert scripts["inventory:check"] == "node scripts/run_python.mjs scripts/refresh_inventory.py --check"
