from __future__ import annotations

import json
from pathlib import Path

import pytest
from flask import Flask

import routes.xray_configs as xray_configs_mod


def _load_json(path: str, default=None):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return default


def _save_json(path: str, data) -> None:
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _write(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _routing(configs: Path, *strategies: str) -> None:
    _write(
        configs / "05_routing.json",
        {"routing": {"balancers": [
            {"tag": f"b{idx}", "selector": ["VPS_"], "strategy": {"type": kind}}
            for idx, kind in enumerate(strategies)
        ]}},
    )


def _sections(configs: Path) -> list[tuple[str, str]]:
    found = []
    for path in sorted(configs.glob("*.json")):
        obj = json.loads(path.read_text(encoding="utf-8"))
        for kind in ("observatory", "burstObservatory"):
            if kind in obj:
                found.append((path.name, kind))
    return found


@pytest.fixture
def panel(tmp_path: Path, monkeypatch):
    configs = tmp_path / "configs"
    jsonc_dir = tmp_path / "jsonc"
    configs.mkdir()
    jsonc_dir.mkdir()
    monkeypatch.setattr(xray_configs_mod, "XRAY_CONFIGS_DIR", str(configs))
    monkeypatch.setattr(xray_configs_mod, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(xray_configs_mod, "ensure_xray_jsonc_dir", lambda: None)

    app = Flask(__name__)
    app.config["TESTING"] = True
    app.register_blueprint(
        xray_configs_mod.create_xray_configs_blueprint(
            restart_xkeen=lambda **_kwargs: False,
            load_json=_load_json,
            save_json=_save_json,
            strip_json_comments_text=lambda text: text,
            snapshot_xray_config_before_overwrite=lambda _path: None,
            ui_state_dir=str(tmp_path / "state"),
        )
    )
    return app.test_client(), configs, jsonc_dir


def test_generate_converts_plain_to_burst_and_keeps_the_panel_interval(panel):
    client, configs, jsonc_dir = panel
    _routing(configs, "leastPing", "leastLoad")
    _write(
        configs / "07_observatory.json",
        {"observatory": {"subjectSelector": ["old"], "probeUrl": "https://a.example/204", "probeInterval": "5m"}},
    )

    response = client.post(
        "/api/xray/observatory/generate",
        json={"subjectSelector": ["VPS_"], "probeUrl": "https://a.example/204", "probeInterval": "60s",
              "enableConcurrency": True},
    )

    body = response.get_json()
    assert response.status_code == 200
    assert body["file"] == "07_observatory.json"
    assert body["config"]["kind"] == "burstObservatory"
    assert body["config"]["probeInterval"] == "2m"
    assert _sections(configs) == [("07_observatory.json", "burstObservatory")]
    written = json.loads((configs / "07_observatory.json").read_text(encoding="utf-8"))
    assert written["burstObservatory"] == {
        "subjectSelector": ["VPS_"],
        "pingConfig": {"destination": "https://a.example/204", "interval": "2m", "sampling": 3, "timeout": "5s"},
    }
    assert (jsonc_dir / "07_observatory.jsonc").exists()


def test_generate_creates_a_burst_with_the_panel_interval(panel):
    client, configs, _jsonc = panel
    _routing(configs, "leastLoad")

    response = client.post(
        "/api/xray/observatory/generate", json={"subjectSelector": ["VPS_"], "probeInterval": "5m"}
    )

    body = response.get_json()
    assert body["existed"] is False
    assert body["file"] == "07_observatory.json"
    written = json.loads((configs / "07_observatory.json").read_text(encoding="utf-8"))
    assert written["burstObservatory"]["pingConfig"]["interval"] == "2m"


def test_generate_edits_the_file_that_holds_the_section(panel):
    client, configs, jsonc_dir = panel
    _routing(configs, "leastLoad")
    ping = {"destination": "https://cp.cloudflare.com/generate_204", "interval": "10m", "sampling": 6}
    _write(configs / "09_burst.json", {"burstObservatory": {"subjectSelector": ["OLD_"], "pingConfig": ping}})

    response = client.post(
        "/api/xray/observatory/generate", json={"subjectSelector": ["VPS_"], "probeInterval": "3m"}
    )

    body = response.get_json()
    assert response.status_code == 200
    assert body["file"] == "09_burst.json"
    assert body["existed"] is True
    assert body["jsonc"] == "09_burst.jsonc"
    assert not (configs / "07_observatory.json").exists()
    assert not (jsonc_dir / "07_observatory.jsonc").exists()
    assert _sections(configs) == [("09_burst.json", "burstObservatory")]
    written = json.loads((configs / "09_burst.json").read_text(encoding="utf-8"))
    assert written["burstObservatory"]["subjectSelector"] == ["VPS_"]
    # The section existed before this call, so the form's interval applies.
    assert written["burstObservatory"]["pingConfig"] == {**ping, "interval": "3m"}
    assert (jsonc_dir / "09_burst.jsonc").exists()


def test_generate_leaves_an_empty_default_file_alone_when_the_section_lives_elsewhere(panel):
    client, configs, _jsonc = panel
    _routing(configs, "leastLoad")
    _write(configs / "07_observatory.json", {"log": {}})
    _write(configs / "09_burst.json", {"burstObservatory": {"subjectSelector": ["OLD_"], "pingConfig": {}}})

    client.post("/api/xray/observatory/generate", json={"subjectSelector": ["VPS_"]})

    assert json.loads((configs / "07_observatory.json").read_text(encoding="utf-8")) == {"log": {}}
    assert _sections(configs) == [("09_burst.json", "burstObservatory")]


def test_generate_without_overwrite_reports_the_file_it_would_use(panel):
    client, configs, _jsonc = panel
    _routing(configs, "leastLoad")
    before = {"burstObservatory": {"subjectSelector": ["OLD_"], "pingConfig": {"interval": "10m"}}}
    _write(configs / "09_burst.json", before)

    response = client.post(
        "/api/xray/observatory/generate", json={"subjectSelector": ["VPS_"], "overwrite": False}
    )

    body = response.get_json()
    assert body == {"ok": True, "existed": True, "overwritten": False, "file": "09_burst.json"}
    assert json.loads((configs / "09_burst.json").read_text(encoding="utf-8")) == before


def test_config_describes_a_burst_file(panel):
    client, configs, _jsonc = panel
    _routing(configs, "leastLoad")
    _write(
        configs / "07_observatory.json",
        {"burstObservatory": {
            "subjectSelector": ["VPS_"],
            "pingConfig": {"destination": "https://cp.cloudflare.com/generate_204", "interval": "10m"},
        }},
    )

    body = client.get("/api/xray/observatory/config").get_json()

    assert body["exists"] is True
    assert body["file"] == "07_observatory.json"
    assert body["config"] == {
        "kind": "burstObservatory",
        "subjectSelector": ["VPS_"],
        "probeUrl": "https://cp.cloudflare.com/generate_204",
        "probeInterval": "10m",
        "enableConcurrency": True,
    }


def test_config_reads_the_section_from_the_file_that_holds_it(panel):
    client, configs, _jsonc = panel
    _routing(configs, "leastLoad")
    _write(
        configs / "09_burst.json",
        {"burstObservatory": {"subjectSelector": ["VPS_"], "pingConfig": {"destination": "https://d.example/204",
                                                                           "interval": "10m"}}},
    )

    body = client.get("/api/xray/observatory/config").get_json()

    assert body["exists"] is True
    assert body["file"] == "09_burst.json"
    assert body["jsonc"] == "09_burst.jsonc"
    assert body["config"]["kind"] == "burstObservatory"
    assert body["config"]["probeUrl"] == "https://d.example/204"
    assert body["config"]["probeInterval"] == "10m"


def test_config_and_generate_agree_when_one_file_holds_both_kinds(panel):
    client, configs, _jsonc = panel
    _routing(configs, "leastLoad")
    _write(
        configs / "07_observatory.json",
        {
            "observatory": {"subjectSelector": ["p"], "probeUrl": "https://p.example/204", "probeInterval": "5m"},
            "burstObservatory": {"subjectSelector": ["b"], "pingConfig": {"destination": "https://b.example/204",
                                                                          "interval": "10m"}},
        },
    )

    described = client.get("/api/xray/observatory/config").get_json()["config"]
    client.post("/api/xray/observatory/generate", json={"subjectSelector": ["VPS_"]})

    assert described["kind"] == "burstObservatory"
    assert described["probeInterval"] == "10m"
    assert _sections(configs) == [("07_observatory.json", "burstObservatory")]


def test_config_without_any_section_points_at_the_default_file(panel):
    client, configs, _jsonc = panel

    body = client.get("/api/xray/observatory/config").get_json()

    assert body["exists"] is False
    assert body["file"] == "07_observatory.json"
    assert body["config"]["kind"] == ""
