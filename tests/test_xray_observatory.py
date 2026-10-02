from __future__ import annotations

import json
from pathlib import Path

from services import xray_observatory as obs


def _write(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def test_catalog_collects_strategies_and_sections_from_every_file(tmp_path: Path):
    _write(
        tmp_path / "05_routing.json",
        {"routing": {"balancers": [
            {"tag": "fast", "selector": ["VPS_"], "strategy": {"type": "leastPing"}},
            {"tag": "heavy", "selector": ["VPS_"], "strategy": {"type": "leastLoad"}},
        ]}},
    )
    _write(tmp_path / "07_observatory.json", {"observatory": {"subjectSelector": ["VPS_NL"]}})
    _write(tmp_path / "09_extra.json", {"burstObservatory": {"subjectSelector": ["VPS_"]}})
    (tmp_path / "04_outbounds.json.disable").write_text("{}", encoding="utf-8")

    catalog = obs.collect_catalog(str(tmp_path))

    assert catalog["strategies"] == ["leastping", "leastload"]
    assert catalog["has_least_load"] is True
    assert [(item["file"], item["kind"]) for item in catalog["sections"]] == [
        ("07_observatory.json", "observatory"),
        ("09_extra.json", "burstObservatory"),
    ]
    # The core registers the plain observatory first, so it is the one in effect.
    assert obs.effective_kind(catalog) == "observatory"
    assert obs.effective_section(catalog, "burstObservatory")["file"] == "09_extra.json"


def test_catalog_reads_root_level_balancers_and_commented_json(tmp_path: Path):
    _write(tmp_path / "05_routing.json", {"balancers": [{"tag": "b", "strategy": {"type": "leastLoad"}}]})
    (tmp_path / "07_observatory.json").write_text(
        '// выбор объяснён в эталоне\n{ "burstObservatory": { "subjectSelector": ["VPS_"] } }\n',
        encoding="utf-8",
    )

    catalog = obs.collect_catalog(str(tmp_path))

    assert catalog["has_least_load"] is True
    assert obs.effective_kind(catalog) == "burstObservatory"


def test_catalog_of_empty_or_missing_dir_is_empty(tmp_path: Path):
    catalog = obs.collect_catalog(str(tmp_path / "missing"))

    assert catalog == {"strategies": [], "has_least_load": False, "sections": []}
    assert obs.effective_kind(catalog) == ""
    assert obs.effective_section(catalog, "observatory") is None


def test_covers_compares_by_prefix():
    assert obs.covers(["VPS_"], "VPS_NL_SUB--NL_xhttp") is True
    assert obs.covers(["VPS_NL_SUB"], "VPS_NL_SUB") is True
    assert obs.covers(["VPS_NL"], "VPS_CH_SUB") is False
    assert obs.covers([], "VPS_NL_SUB") is False


def test_burst_from_plain_keeps_selector_and_probe_address():
    plain = {
        "subjectSelector": ["VPS_NL_SUB", "VPS_CH_SUB"],
        "probeUrl": "https://cp.cloudflare.com/generate_204",
        "probeInterval": "5m",
        "enableConcurrency": True,
    }

    assert obs.burst_from_plain(plain, "https://fallback.example/204") == {
        "subjectSelector": ["VPS_NL_SUB", "VPS_CH_SUB"],
        "pingConfig": {
            "destination": "https://cp.cloudflare.com/generate_204",
            "interval": "2m",
            "sampling": 3,
            "timeout": "5s",
        },
    }
    assert obs.burst_from_plain({}, "https://fallback.example/204")["pingConfig"]["destination"] == (
        "https://fallback.example/204"
    )


def test_describe_config_maps_burst_fields_to_the_form():
    cfg = {"burstObservatory": {
        "subjectSelector": ["VPS_"],
        "pingConfig": {"destination": "https://cp.cloudflare.com/generate_204", "interval": "10m", "sampling": 6},
    }}

    assert obs.describe_config(cfg) == {
        "kind": "burstObservatory",
        "subjectSelector": ["VPS_"],
        "probeUrl": "https://cp.cloudflare.com/generate_204",
        "probeInterval": "10m",
        "enableConcurrency": True,
    }
    assert obs.describe_config({})["kind"] == ""


def test_generate_updates_an_existing_burst_section_in_place():
    cfg = {"burstObservatory": {
        "subjectSelector": ["old"],
        "pingConfig": {"destination": "https://a.example/204", "interval": "10m", "sampling": 6, "timeout": "5s"},
    }}

    result = obs.apply_generate_request(
        cfg, subject=["VPS_"], probe_url="https://b.example/204", probe_interval="", enable_concurrency=None,
        want_burst=False,
    )

    assert list(result) == ["burstObservatory"]
    assert result["burstObservatory"] == {
        "subjectSelector": ["VPS_"],
        "pingConfig": {"destination": "https://b.example/204", "interval": "10m", "sampling": 6, "timeout": "5s"},
    }


def test_generate_writes_burst_for_least_load_and_plain_otherwise():
    burst = obs.apply_generate_request(
        {}, subject=["VPS_"], probe_url=None, probe_interval=None, enable_concurrency=None, want_burst=True
    )
    plain = obs.apply_generate_request(
        {}, subject=["VPS_"], probe_url=None, probe_interval=None, enable_concurrency=None, want_burst=False
    )

    assert burst == {"burstObservatory": {
        "subjectSelector": ["VPS_"],
        "pingConfig": {"destination": "https://www.gstatic.com/generate_204", "interval": "2m", "sampling": 3,
                       "timeout": "5s"},
    }}
    assert plain == {"observatory": {
        "subjectSelector": ["VPS_"],
        "probeUrl": "https://www.gstatic.com/generate_204",
        "probeInterval": "60s",
        "enableConcurrency": True,
    }}


def test_generate_converts_plain_to_burst_when_least_load_appeared():
    cfg = {"log": {}, "observatory": {"subjectSelector": ["old"], "probeUrl": "https://a.example/204",
                                      "probeInterval": "5m", "enableConcurrency": True}}

    result = obs.apply_generate_request(
        cfg, subject=["VPS_"], probe_url=None, probe_interval=None, enable_concurrency=None, want_burst=True
    )

    assert list(result) == ["log", "burstObservatory"]
    assert result["burstObservatory"]["subjectSelector"] == ["VPS_"]
    assert result["burstObservatory"]["pingConfig"]["destination"] == "https://a.example/204"
    assert result["burstObservatory"]["pingConfig"]["interval"] == "2m"


def test_bundled_template_shows_a_valid_burst_example():
    text = (Path(__file__).resolve().parents[1]
            / "xkeen-ui/opt/etc/xray/templates/observatory/07_observatory_base.jsonc").read_text(encoding="utf-8")
    burst_part = text.split("burstObservatory", 1)[1]

    assert '"pingConfig"' in burst_part
    assert '"destination"' in burst_part
    assert "probeUrl" not in burst_part
    assert "leastLoad" in text


def test_catalog_reads_a_windows_1251_routing_file(tmp_path: Path):
    text = (
        "// балансировщик для тяжёлого трафика\n"
        '{ "routing": { "balancers": [ { "tag": "heavy", "strategy": { "type": "leastLoad" } } ] } }\n'
    )
    (tmp_path / "05_routing.json").write_bytes(text.encode("cp1251"))

    assert obs.collect_catalog(str(tmp_path))["has_least_load"] is True


def test_read_fragment_tolerates_bom_and_rejects_broken_or_non_object_files(tmp_path: Path):
    bom = tmp_path / "bom.json"
    bom.write_bytes(b"\xef\xbb\xbf" + b'{ "observatory": {} }')
    broken = tmp_path / "broken.json"
    broken.write_text('{ "observatory": ', encoding="utf-8")
    array = tmp_path / "array.json"
    array.write_text("[1, 2]", encoding="utf-8")

    assert obs.read_fragment(str(bom)) == {"observatory": {}}
    assert obs.read_fragment(str(broken)) is None
    assert obs.read_fragment(str(array)) is None
    assert obs.read_fragment(str(tmp_path / "missing.json")) is None


def test_effective_section_picks_the_last_of_two_same_kind_sections(tmp_path: Path):
    _write(tmp_path / "07_observatory.json", {"burstObservatory": {"subjectSelector": ["first"]}})
    _write(tmp_path / "09_x.json", {"burstObservatory": {"subjectSelector": ["second"]}})

    catalog = obs.collect_catalog(str(tmp_path))

    assert obs.effective_section(catalog, "burstObservatory")["file"] == "09_x.json"
    assert obs.effective_section(catalog, "burstObservatory")["section"] == {"subjectSelector": ["second"]}


def test_replace_section_keeps_key_order_and_drops_the_twin():
    source = {"log": {}, "observatory": {"a": 1}, "stats": {}, "burstObservatory": {"b": 2}, "tail": 1}

    result = obs.replace_section(source, "burstObservatory", {"subjectSelector": ["VPS_"]})

    assert list(result) == ["log", "burstObservatory", "stats", "tail"]
    assert result["burstObservatory"] == {"subjectSelector": ["VPS_"]}
    assert list(obs.replace_section({"log": {}}, "observatory", {})) == ["log", "observatory"]
    assert "burstObservatory" in source


def test_locate_follows_the_strategies_when_both_kinds_exist(tmp_path: Path):
    _write(tmp_path / "07_observatory.json", {"observatory": {"subjectSelector": ["a"]}})
    _write(tmp_path / "09_burst.json", {"burstObservatory": {"subjectSelector": ["b"]}})

    assert obs.locate_section(obs.collect_catalog(str(tmp_path)))["file"] == "07_observatory.json"

    _write(tmp_path / "05_routing.json", {"routing": {"balancers": [{"tag": "h", "strategy": {"type": "leastLoad"}}]}})
    assert obs.locate_section(obs.collect_catalog(str(tmp_path)))["file"] == "09_burst.json"
    assert obs.locate_section({"sections": [], "has_least_load": True}) is None


def test_generate_ignores_the_form_interval_when_it_creates_or_converts_a_burst():
    created = obs.apply_generate_request(
        {}, subject=["VPS_"], probe_url="https://b.example/204", probe_interval="60s", enable_concurrency=True,
        want_burst=True,
    )
    converted = obs.apply_generate_request(
        {"observatory": {"subjectSelector": ["old"], "probeUrl": "https://a.example/204", "probeInterval": "5m"}},
        subject=["VPS_"], probe_url="", probe_interval="5m", enable_concurrency=True, want_burst=True,
    )

    assert created["burstObservatory"]["pingConfig"] == {
        "destination": "https://b.example/204", "interval": "2m", "sampling": 3, "timeout": "5s",
    }
    assert converted["burstObservatory"]["pingConfig"] == {
        "destination": "https://a.example/204", "interval": "2m", "sampling": 3, "timeout": "5s",
    }


def test_generate_applies_the_form_interval_to_an_existing_burst():
    cfg = {"burstObservatory": {"subjectSelector": ["old"], "pingConfig": {"interval": "10m", "sampling": 6}}}

    result = obs.apply_generate_request(
        cfg, subject=["VPS_"], probe_url="", probe_interval="3m", enable_concurrency=None, want_burst=True
    )

    assert result["burstObservatory"]["pingConfig"] == {"interval": "3m", "sampling": 6}


BOTH_KINDS = {
    "observatory": {"subjectSelector": ["p"], "probeUrl": "https://p.example/204", "probeInterval": "5m"},
    "burstObservatory": {"subjectSelector": ["b"], "pingConfig": {"destination": "https://b.example/204",
                                                                  "interval": "10m"}},
}


def test_with_both_kinds_in_one_file_reading_and_saving_agree():
    assert obs.describe_config(BOTH_KINDS)["kind"] == "observatory"
    assert obs.describe_config(BOTH_KINDS, want_burst=False)["probeInterval"] == "5m"
    described = obs.describe_config(BOTH_KINDS, want_burst=True)
    assert described["kind"] == "burstObservatory"
    assert described["probeUrl"] == "https://b.example/204"
    assert described["probeInterval"] == "10m"

    kept_burst = obs.apply_generate_request(
        BOTH_KINDS, subject=["VPS_"], probe_url=None, probe_interval=None, enable_concurrency=None, want_burst=True
    )
    kept_plain = obs.apply_generate_request(
        BOTH_KINDS, subject=["VPS_"], probe_url=None, probe_interval=None, enable_concurrency=None, want_burst=False
    )

    assert list(kept_burst) == ["burstObservatory"]
    assert kept_burst["burstObservatory"]["pingConfig"]["interval"] == "10m"
    assert list(kept_plain) == ["observatory"]
    assert kept_plain["observatory"]["probeInterval"] == "5m"
    assert kept_plain["observatory"]["subjectSelector"] == ["VPS_"]


def test_the_default_probe_address_is_defined_once():
    from services import xray_subscriptions as subs

    source = (Path(__file__).resolve().parents[1] / "xkeen-ui/services/xray_subscriptions.py").read_text(
        encoding="utf-8"
    )

    assert subs.DEFAULT_PROBE_URL is obs.DEFAULT_PROBE_URL
    assert "\nDEFAULT_PROBE_URL =" not in source
