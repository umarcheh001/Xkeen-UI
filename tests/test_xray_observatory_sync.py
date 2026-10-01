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


def _rebuild_with(subs, monkeypatch, tmp_path, xray_dir, *, planned, delivered):
    calls = []
    monkeypatch.setattr(
        subs,
        "sync_subscription_runtime_plan_delta",
        lambda **_k: {"observatory_changed": False, "has_runtime_targets": delivered},
    )
    monkeypatch.setattr(
        subs, "_undo_observatory_conversion", lambda *_a, **_k: calls.append("undo") or True
    )
    plans = iter([{"has_runtime_targets": True}, {"has_runtime_targets": planned}])
    monkeypatch.setattr(subs, "_build_runtime_sync_plan", lambda _state: next(plans))
    result = subs._rebuild_subscription_runtime(
        str(_state_dir(tmp_path)), xray_configs_dir=str(xray_dir),
        previous_state={"subscriptions": []}, state_override={"subscriptions": []},
    )
    return result, calls


def test_rebuild_undoes_the_conversion_only_when_no_targets_remain(env, tmp_path, monkeypatch):
    subs, xray_dir, _jsonc = env
    (tmp_path / "a").mkdir()
    still_active, calls = _rebuild_with(
        subs, monkeypatch, tmp_path / "a", xray_dir, planned=True, delivered=True
    )
    assert still_active["observatory_changed"] is False
    assert calls == []

    (tmp_path / "b").mkdir()
    last_gone, calls = _rebuild_with(subs, monkeypatch, tmp_path / "b", xray_dir, planned=False, delivered=False)
    assert last_gone["observatory_changed"] is True
    assert calls == ["undo"]


def test_rebuild_undoes_when_delta_reports_no_targets_but_plan_had_some(env, tmp_path, monkeypatch):
    subs, xray_dir, _jsonc = env
    result, calls = _rebuild_with(subs, monkeypatch, tmp_path, xray_dir, planned=True, delivered=False)
    assert result["observatory_changed"] is True
    assert calls == ["undo"]


def test_deleting_the_last_subscription_returns_the_original_file_end_to_end(tmp_path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()
    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (
            "vless://user@example.com:443?type=ws&security=tls&sni=edge.example.com"
            "&encryption=none&host=cdn.example.com&path=%2Fws#WS%20Germany",
            {},
        ),
    )
    _routing(xray_dir, "leastLoad")
    target = xray_dir / "07_observatory.json"
    target.write_text(PLAIN_BEFORE, encoding="utf-8")

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "sub-one",
            "tag": "subscription.example",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": True,
        },
    )
    refreshed = subs.refresh_subscription(
        str(ui_state_dir),
        "sub-one",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=None,
        restart=False,
    )
    assert refreshed["ok"] is True
    active = json.loads(target.read_text(encoding="utf-8"))
    assert "burstObservatory" in active and "observatory" not in active

    subs.delete_subscription(
        str(ui_state_dir),
        "sub-one",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        remove_file=True,
        restart_xkeen=None,
    )

    assert target.read_text(encoding="utf-8") == PLAIN_BEFORE
    assert subs.MANAGED_BASELINES_KEY not in subs.load_subscription_state(str(ui_state_dir))


# --- final review fixes -------------------------------------------------------


def test_undo_leaves_a_burst_the_owner_uploaded_while_subscribed(env, tmp_path):
    subs, xray_dir, _jsonc = env
    ui_state_dir = _state_dir(tmp_path)
    _routing(xray_dir, "leastLoad")
    target = xray_dir / "07_observatory.json"
    target.write_text(PLAIN_BEFORE, encoding="utf-8")
    subs._ensure_subscription_managed_baselines(str(ui_state_dir), str(xray_dir))
    subs.sync_observatory_subjects(xray_configs_dir=str(xray_dir), add_tags=SUB_TAGS)

    target.write_text(ETALON, encoding="utf-8")

    assert subs._undo_observatory_conversion(str(ui_state_dir), xray_configs_dir=str(xray_dir)) is False
    assert target.read_text(encoding="utf-8") == ETALON


def test_undo_never_brings_back_a_second_section_after_a_collapse(env, tmp_path):
    subs, xray_dir, _jsonc = env
    ui_state_dir = _state_dir(tmp_path)
    _routing(xray_dir, "leastLoad")
    (xray_dir / "07_observatory.json").write_text(PLAIN_BEFORE, encoding="utf-8")
    (xray_dir / "09_burst.json").write_text(
        json.dumps({"burstObservatory": {"subjectSelector": ["VPS_"], "pingConfig": {"interval": "10m"}}}),
        encoding="utf-8",
    )
    subs._ensure_subscription_managed_baselines(str(ui_state_dir), str(xray_dir))
    subs.sync_observatory_subjects(xray_configs_dir=str(xray_dir), add_tags=SUB_TAGS)
    assert _sections(xray_dir) == [("09_burst.json", "burstObservatory")]
    subs.sync_observatory_subjects(
        xray_configs_dir=str(xray_dir), add_tags=[], remove_tags=SUB_TAGS, managed_active=False
    )

    assert subs._undo_observatory_conversion(str(ui_state_dir), xray_configs_dir=str(xray_dir)) is False
    assert _sections(xray_dir) == [("09_burst.json", "burstObservatory")]


CP1251_ETALON = (
    "// обсерватория владельца: выбор объяснён в эталоне\n"
    '{ "burstObservatory": {\n'
    '    "subjectSelector": ["VPS_"],\n'
    '    "pingConfig": { "destination": "https://cp.cloudflare.com/generate_204", "interval": "10m",\n'
    '                    "sampling": 6, "timeout": "5s" } } }\n'
).encode("cp1251")


def test_windows_1251_owner_file_is_understood_and_left_alone(env):
    subs, xray_dir, jsonc_dir = env
    _routing(xray_dir, "leastLoad")
    target = xray_dir / "07_observatory.json"
    target.write_bytes(CP1251_ETALON)

    changed = subs.sync_observatory_subjects(xray_configs_dir=str(xray_dir), add_tags=SUB_TAGS)

    assert changed is False
    assert target.read_bytes() == CP1251_ETALON
    assert list(jsonc_dir.iterdir()) == []


def test_no_section_is_created_over_a_file_the_catalog_could_not_see(env, monkeypatch):
    subs, xray_dir, jsonc_dir = env
    _routing(xray_dir, "leastLoad")
    target = xray_dir / "07_observatory.json"
    target.write_text(ETALON, encoding="utf-8")
    monkeypatch.setattr(
        subs, "collect_catalog", lambda _dir: {"strategies": ["leastload"], "has_least_load": True, "sections": []}
    )

    changed = subs.sync_observatory_subjects(xray_configs_dir=str(xray_dir), add_tags=["OTHER_SUB"])

    assert changed is False
    assert target.read_text(encoding="utf-8") == ETALON
    assert list(jsonc_dir.iterdir()) == []


@pytest.mark.parametrize(
    "owner_text",
    [
        '// свои узлы\n{ "observatory": { "subjectSelector": ["VPS_", "VPS_", "manual"],\n'
        '    "probeUrl": "https://a.example/204" } }\n',
        '// селектор допишу позже\n{ "observatory": { "probeUrl": "https://a.example/204" } }\n',
        '// пока пусто\n{ "observatory": {} }\n',
    ],
    ids=["duplicate-selectors", "no-selector-key", "empty-section"],
)
def test_removal_of_absent_tags_leaves_an_untidy_owner_section_alone(env, owner_text):
    subs, xray_dir, jsonc_dir = env
    _routing(xray_dir, "leastPing")
    target = xray_dir / "07_observatory.json"
    target.write_text(owner_text, encoding="utf-8")

    changed = subs.sync_observatory_subjects(
        xray_configs_dir=str(xray_dir), add_tags=[], remove_tags=SUB_TAGS, managed_active=False
    )

    assert changed is False
    assert target.read_text(encoding="utf-8") == owner_text
    assert list(jsonc_dir.iterdir()) == []


def test_two_sections_of_the_same_kind_become_one(env):
    subs, xray_dir, _jsonc = env
    _routing(xray_dir, "leastLoad")
    (xray_dir / "07_observatory.json").write_text(
        json.dumps({"burstObservatory": {"subjectSelector": ["first_"], "pingConfig": {"interval": "5m"}}}),
        encoding="utf-8",
    )
    (xray_dir / "09_x.json").write_text(
        json.dumps({"log": {}, "burstObservatory": {"subjectSelector": ["second_"],
                                                    "pingConfig": {"interval": "10m"}}}),
        encoding="utf-8",
    )

    assert subs.sync_observatory_subjects(xray_configs_dir=str(xray_dir), add_tags=SUB_TAGS) is True

    assert _sections(xray_dir) == [("09_x.json", "burstObservatory")]
    section = json.loads((xray_dir / "09_x.json").read_text(encoding="utf-8"))["burstObservatory"]
    assert section["subjectSelector"] == ["second_", "first_", "VPS_NL_SUB", "VPS_CH_SUB"]
    assert section["pingConfig"] == {"interval": "10m"}


def test_three_sections_across_files_become_one(env):
    subs, xray_dir, _jsonc = env
    _routing(xray_dir, "leastPing")
    (xray_dir / "06_a.json").write_text(
        json.dumps({"observatory": {"subjectSelector": ["a_"]}}), encoding="utf-8"
    )
    (xray_dir / "07_observatory.json").write_text(
        json.dumps({"observatory": {"subjectSelector": ["b_"], "probeUrl": "https://b.example/204"}}),
        encoding="utf-8",
    )
    (xray_dir / "09_x.json").write_text(
        json.dumps({"burstObservatory": {"subjectSelector": ["c_"], "pingConfig": {"interval": "10m"}}}),
        encoding="utf-8",
    )

    assert subs.sync_observatory_subjects(xray_configs_dir=str(xray_dir), add_tags=["VPS_NL_SUB"]) is True

    assert _sections(xray_dir) == [("07_observatory.json", "observatory")]
    section = json.loads((xray_dir / "07_observatory.json").read_text(encoding="utf-8"))["observatory"]
    assert section["subjectSelector"] == ["b_", "a_", "c_", "VPS_NL_SUB"]
    assert section["probeUrl"] == "https://b.example/204"


def test_an_empty_plain_section_receives_the_defaults(env):
    subs, xray_dir, _jsonc = env
    _routing(xray_dir, "leastPing")
    (xray_dir / "07_observatory.json").write_text('{ "observatory": {} }\n', encoding="utf-8")

    assert subs.sync_observatory_subjects(xray_configs_dir=str(xray_dir), add_tags=SUB_TAGS) is True

    section = json.loads((xray_dir / "07_observatory.json").read_text(encoding="utf-8"))["observatory"]
    assert section == {
        "subjectSelector": SUB_TAGS,
        "probeUrl": "https://www.gstatic.com/generate_204",
        "probeInterval": "60s",
        "enableConcurrency": True,
    }


def test_observatory_is_chosen_by_the_routing_the_pass_leaves_on_disk(tmp_path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()
    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (
            "vless://user@example.com:443?type=ws&security=tls&sni=edge.example.com"
            "&encryption=none&host=cdn.example.com&path=%2Fws#WS%20Germany",
            {},
        ),
    )
    (xray_dir / "04_outbounds.json").write_text(
        json.dumps({"outbounds": [{"tag": "direct", "protocol": "freedom"}]}, indent=2) + "\n", encoding="utf-8"
    )
    (xray_dir / "05_routing.json").write_text(
        json.dumps(
            {"routing": {
                "balancers": [
                    {"tag": "heavy_load_balancer", "selector": ["VPS_"], "strategy": {"type": "leastLoad"},
                     "fallbackTag": "direct"},
                ],
                "rules": [
                    {"type": "field", "ruleTag": "heavy", "domain": ["domain:googlevideo.com"],
                     "balancerTag": "heavy_load_balancer"},
                    {"type": "field", "ruleTag": "catch_all", "network": "tcp,udp",
                     "balancerTag": "heavy_load_balancer"},
                ],
            }},
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "only",
            "tag": "subscription.example",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": True,
            "routing_auto_rule": True,
            "routing_mode": "subscription-only",
        },
    )
    result = subs.refresh_subscription(
        str(ui_state_dir),
        "only",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=None,
        restart=False,
    )

    assert result["ok"] is True
    routing = json.loads((xray_dir / "05_routing.json").read_text(encoding="utf-8"))
    strategies = [item["strategy"]["type"] for item in routing["routing"]["balancers"]]
    assert "leastLoad" not in strategies
    assert _sections(xray_dir) == [("07_observatory.json", "observatory")]
    assert result["observatory_changed"] is True
