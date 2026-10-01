# tests/test_xray_observatory_sync.py
from __future__ import annotations

import json
from pathlib import Path

import pytest

ETALON = (
    "// burstObservatory: leastLoad читает разброс задержки, его даёт только она\n"
    '{ "burstObservatory": {\n'
    '    "subjectSelector": ["VPS_"],\n'
    '    "pingConfig": {\n'
    '      "destination": "https://cp.cloudflare.com/generate_204",\n'
    '      "interval": "10m", "sampling": 6, "timeout": "5s" } } }\n'
)
SUB_TAGS = ["VPS_NL_SUB", "VPS_CH_SUB"]


@pytest.fixture
def env(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    xray_dir = tmp_path / "configs"
    jsonc_dir = tmp_path / "jsonc"
    xray_dir.mkdir()
    jsonc_dir.mkdir()
    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    return subs, xray_dir, jsonc_dir


def _routing(xray_dir: Path, *strategies: str) -> None:
    balancers = [
        {"tag": f"b{idx}", "selector": ["VPS_"], "strategy": {"type": kind}}
        for idx, kind in enumerate(strategies)
    ]
    (xray_dir / "05_routing.json").write_text(
        json.dumps({"routing": {"balancers": balancers, "rules": []}}, indent=2) + "\n", encoding="utf-8"
    )


def _sections(xray_dir: Path) -> list[tuple[str, str]]:
    found = []
    for path in sorted(xray_dir.glob("*.json")):
        obj = json.loads(path.read_text(encoding="utf-8"))
        for kind in ("observatory", "burstObservatory"):
            if kind in obj:
                found.append((path.name, kind))
    return found


def test_covering_burst_file_is_left_byte_for_byte(env):
    subs, xray_dir, jsonc_dir = env
    _routing(xray_dir, "leastPing", "leastLoad")
    target = xray_dir / "07_observatory.json"
    target.write_text(ETALON, encoding="utf-8")

    changed = subs.sync_observatory_subjects(xray_configs_dir=str(xray_dir), add_tags=SUB_TAGS)

    assert changed is False
    assert target.read_text(encoding="utf-8") == ETALON
    assert list(jsonc_dir.iterdir()) == []


def test_burst_selector_is_extended_and_ping_config_kept(env):
    subs, xray_dir, _jsonc = env
    _routing(xray_dir, "leastLoad")
    ping = {"destination": "https://cp.cloudflare.com/generate_204", "interval": "10m", "sampling": 6, "timeout": "5s"}
    (xray_dir / "07_observatory.json").write_text(
        json.dumps({"burstObservatory": {"subjectSelector": ["OTHER_"], "pingConfig": ping}}), encoding="utf-8"
    )

    assert subs.sync_observatory_subjects(xray_configs_dir=str(xray_dir), add_tags=SUB_TAGS) is True

    section = json.loads((xray_dir / "07_observatory.json").read_text(encoding="utf-8"))["burstObservatory"]
    assert section["subjectSelector"] == ["OTHER_", "VPS_NL_SUB", "VPS_CH_SUB"]
    assert section["pingConfig"] == ping


def test_plain_observatory_becomes_burst_when_least_load_exists(env):
    subs, xray_dir, _jsonc = env
    _routing(xray_dir, "leastPing", "leastLoad")
    (xray_dir / "07_observatory.json").write_text(
        json.dumps({"observatory": {
            "subjectSelector": ["manual"],
            "probeUrl": "https://cp.cloudflare.com/generate_204",
            "probeInterval": "5m",
            "enableConcurrency": True,
        }}),
        encoding="utf-8",
    )

    assert subs.sync_observatory_subjects(xray_configs_dir=str(xray_dir), add_tags=SUB_TAGS) is True

    assert _sections(xray_dir) == [("07_observatory.json", "burstObservatory")]
    section = json.loads((xray_dir / "07_observatory.json").read_text(encoding="utf-8"))["burstObservatory"]
    assert section == {
        "subjectSelector": ["manual", "VPS_NL_SUB", "VPS_CH_SUB"],
        "pingConfig": {
            "destination": "https://cp.cloudflare.com/generate_204",
            "interval": "2m",
            "sampling": 3,
            "timeout": "5s",
        },
    }


def test_without_least_load_a_plain_observatory_is_written(env):
    subs, xray_dir, _jsonc = env
    _routing(xray_dir, "leastPing", "random")

    assert subs.sync_observatory_subjects(xray_configs_dir=str(xray_dir), add_tags=SUB_TAGS) is True

    assert _sections(xray_dir) == [("07_observatory.json", "observatory")]
    section = json.loads((xray_dir / "07_observatory.json").read_text(encoding="utf-8"))["observatory"]
    assert section["subjectSelector"] == SUB_TAGS
    assert section["probeInterval"] == "60s"


def test_least_load_without_any_section_creates_burst(env):
    subs, xray_dir, _jsonc = env
    _routing(xray_dir, "leastLoad")

    assert subs.sync_observatory_subjects(xray_configs_dir=str(xray_dir), add_tags=SUB_TAGS) is True

    assert _sections(xray_dir) == [("07_observatory.json", "burstObservatory")]
    section = json.loads((xray_dir / "07_observatory.json").read_text(encoding="utf-8"))["burstObservatory"]
    assert section["subjectSelector"] == SUB_TAGS
    assert section["pingConfig"]["interval"] == "2m"
    assert section["pingConfig"]["sampling"] == 3


def test_owner_burst_without_least_load_is_not_replaced(env):
    subs, xray_dir, _jsonc = env
    _routing(xray_dir, "leastPing")
    (xray_dir / "07_observatory.json").write_text(ETALON, encoding="utf-8")

    assert subs.sync_observatory_subjects(xray_configs_dir=str(xray_dir), add_tags=["OTHER_SUB"]) is True

    assert _sections(xray_dir) == [("07_observatory.json", "burstObservatory")]
    section = json.loads((xray_dir / "07_observatory.json").read_text(encoding="utf-8"))["burstObservatory"]
    assert section["subjectSelector"] == ["VPS_", "OTHER_SUB"]
    assert section["pingConfig"]["interval"] == "10m"


def test_two_sections_collapse_into_the_needed_one(env):
    subs, xray_dir, _jsonc = env
    _routing(xray_dir, "leastLoad")
    (xray_dir / "07_observatory.json").write_text(
        json.dumps({"observatory": {"subjectSelector": ["plain_only"], "probeUrl": "https://a.example/204"}}),
        encoding="utf-8",
    )
    (xray_dir / "09_burst.json").write_text(
        json.dumps({"burstObservatory": {"subjectSelector": ["VPS_"], "pingConfig": {"interval": "10m"}}}),
        encoding="utf-8",
    )

    assert subs.sync_observatory_subjects(xray_configs_dir=str(xray_dir), add_tags=SUB_TAGS) is True

    assert _sections(xray_dir) == [("09_burst.json", "burstObservatory")]
    section = json.loads((xray_dir / "09_burst.json").read_text(encoding="utf-8"))["burstObservatory"]
    assert section["subjectSelector"] == ["VPS_", "plain_only"]
    assert section["pingConfig"] == {"interval": "10m"}


def test_section_in_a_foreign_file_is_edited_in_place(env):
    subs, xray_dir, _jsonc = env
    _routing(xray_dir, "leastLoad")
    (xray_dir / "09_burst.json").write_text(
        json.dumps({"burstObservatory": {"subjectSelector": ["OTHER_"], "pingConfig": {"interval": "10m"}}}),
        encoding="utf-8",
    )

    assert subs.sync_observatory_subjects(xray_configs_dir=str(xray_dir), add_tags=SUB_TAGS) is True

    assert not (xray_dir / "07_observatory.json").exists()
    assert _sections(xray_dir) == [("09_burst.json", "burstObservatory")]


def test_removal_drops_only_our_tags_and_keeps_the_kind(env):
    subs, xray_dir, _jsonc = env
    _routing(xray_dir, "leastLoad")
    subs.sync_observatory_subjects(xray_configs_dir=str(xray_dir), add_tags=["manual", *SUB_TAGS])

    changed = subs.sync_observatory_subjects(
        xray_configs_dir=str(xray_dir), add_tags=[], remove_tags=SUB_TAGS, managed_active=False
    )

    assert changed is True
    assert _sections(xray_dir) == [("07_observatory.json", "burstObservatory")]
    section = json.loads((xray_dir / "07_observatory.json").read_text(encoding="utf-8"))["burstObservatory"]
    assert section["subjectSelector"] == ["manual"]


def test_removal_leaves_an_untouched_owner_file_alone(env):
    subs, xray_dir, jsonc_dir = env
    _routing(xray_dir, "leastLoad")
    target = xray_dir / "07_observatory.json"
    target.write_text(ETALON, encoding="utf-8")

    changed = subs.sync_observatory_subjects(
        xray_configs_dir=str(xray_dir), add_tags=[], remove_tags=SUB_TAGS, managed_active=False
    )

    assert changed is False
    assert target.read_text(encoding="utf-8") == ETALON
    assert list(jsonc_dir.iterdir()) == []


def test_removal_without_any_section_creates_nothing(env):
    subs, xray_dir, _jsonc = env
    _routing(xray_dir, "leastLoad")

    changed = subs.sync_observatory_subjects(
        xray_configs_dir=str(xray_dir), add_tags=[], remove_tags=SUB_TAGS, managed_active=False
    )

    assert changed is False
    assert not (xray_dir / "07_observatory.json").exists()


def test_probe_url_is_read_from_either_kind(env):
    subs, xray_dir, _jsonc = env
    (xray_dir / "07_observatory.json").write_text(ETALON, encoding="utf-8")

    assert subs._probe_url_for_subscription(str(xray_dir)) == "https://cp.cloudflare.com/generate_204"


PLAIN_BEFORE = (
    "{\n"
    '  "observatory": {\n'
    '    "subjectSelector": ["manual"],\n'
    '    "probeUrl": "https://cp.cloudflare.com/generate_204",\n'
    '    "probeInterval": "5m"\n'
    "  }\n"
    "}\n"
)


def _state_dir(tmp_path: Path) -> Path:
    path = tmp_path / "state"
    path.mkdir()
    return path


def test_last_subscription_leaving_restores_the_original_kind(env, tmp_path):
    subs, xray_dir, _jsonc = env
    ui_state_dir = _state_dir(tmp_path)
    _routing(xray_dir, "leastLoad")
    target = xray_dir / "07_observatory.json"
    target.write_text(PLAIN_BEFORE, encoding="utf-8")
    subs._ensure_subscription_managed_baselines(str(ui_state_dir), str(xray_dir))

    subs.sync_observatory_subjects(xray_configs_dir=str(xray_dir), add_tags=SUB_TAGS)
    assert _sections(xray_dir) == [("07_observatory.json", "burstObservatory")]
    subs.sync_observatory_subjects(
        xray_configs_dir=str(xray_dir), add_tags=[], remove_tags=SUB_TAGS, managed_active=False
    )

    undone = subs._undo_observatory_conversion(str(ui_state_dir), xray_configs_dir=str(xray_dir))

    assert undone is True
    assert target.read_text(encoding="utf-8") == PLAIN_BEFORE


def test_same_kind_keeps_owner_edits_made_while_subscribed(env, tmp_path):
    subs, xray_dir, _jsonc = env
    ui_state_dir = _state_dir(tmp_path)
    _routing(xray_dir, "leastPing")
    target = xray_dir / "07_observatory.json"
    target.write_text(PLAIN_BEFORE, encoding="utf-8")
    subs._ensure_subscription_managed_baselines(str(ui_state_dir), str(xray_dir))

    edited = PLAIN_BEFORE.replace('"5m"', '"1m"')
    target.write_text(edited, encoding="utf-8")

    assert subs._undo_observatory_conversion(str(ui_state_dir), xray_configs_dir=str(xray_dir)) is False
    assert target.read_text(encoding="utf-8") == edited


def test_file_created_by_the_panel_is_not_removed_by_the_undo(env, tmp_path):
    subs, xray_dir, _jsonc = env
    ui_state_dir = _state_dir(tmp_path)
    _routing(xray_dir, "leastLoad")
    subs._ensure_subscription_managed_baselines(str(ui_state_dir), str(xray_dir))
    subs.sync_observatory_subjects(xray_configs_dir=str(xray_dir), add_tags=SUB_TAGS)

    assert subs._undo_observatory_conversion(str(ui_state_dir), xray_configs_dir=str(xray_dir)) is False
    assert (xray_dir / "07_observatory.json").exists()


def test_rebuild_undoes_the_conversion_only_when_no_targets_remain(env, tmp_path, monkeypatch):
    subs, xray_dir, _jsonc = env
    ui_state_dir = _state_dir(tmp_path)
    calls = []
    monkeypatch.setattr(
        subs, "sync_subscription_runtime_plan_delta", lambda **_k: {"observatory_changed": False}
    )
    monkeypatch.setattr(
        subs, "_undo_observatory_conversion", lambda *_a, **_k: calls.append("undo") or True
    )

    plans = iter([{"has_runtime_targets": True}, {"has_runtime_targets": True}])
    monkeypatch.setattr(subs, "_build_runtime_sync_plan", lambda _state: next(plans))
    still_active = subs._rebuild_subscription_runtime(
        str(ui_state_dir), xray_configs_dir=str(xray_dir),
        previous_state={"subscriptions": []}, state_override={"subscriptions": []},
    )

    plans = iter([{"has_runtime_targets": True}, {"has_runtime_targets": False}])
    last_gone = subs._rebuild_subscription_runtime(
        str(ui_state_dir), xray_configs_dir=str(xray_dir),
        previous_state={"subscriptions": []}, state_override={"subscriptions": []},
    )

    assert still_active["observatory_changed"] is False
    assert last_gone["observatory_changed"] is True
    assert calls == ["undo"]
