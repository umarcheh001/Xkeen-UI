from __future__ import annotations

import json
import subprocess
import sys
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path

from tests.support.panel_render import render_panel


ROOT = Path(__file__).resolve().parents[1]
GENERATOR = ROOT / "scripts" / "generate_modular_panel_stage4_6_compatibility.py"
SNAPSHOT = ROOT / "docs" / "modular-panel-stage4.6-compatibility.json"
PANEL = ROOT / "xkeen-ui" / "templates" / "panel.html"


class _PanelContractParser(HTMLParser):
    """Extract the server-side DOM contract without depending on browser JS."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.ids: list[str] = []
        self.id_data_attributes: dict[str, dict[str, str | None]] = {}
        self.navigation: list[dict[str, str | None]] = []
        self.modal_ids: set[str] = set()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        identifier = attributes.get("id")
        data_attributes = {
            name: value for name, value in attributes.items() if name.startswith("data-")
        }
        if identifier:
            self.ids.append(identifier)
            self.id_data_attributes[identifier] = data_attributes

        section = attributes.get("data-xk-section")
        if tag == "button" and section:
            self.navigation.append(
                {
                    "section": section,
                    "view": attributes.get("data-view"),
                    "id": identifier,
                    "href": attributes.get("data-nav-href"),
                    "top_nav": attributes.get("data-xk-top-nav"),
                }
            )

        classes = set((attributes.get("class") or "").split())
        if identifier and "modal" in classes:
            self.modal_ids.add(identifier)


def _parse(html: str) -> _PanelContractParser:
    parser = _PanelContractParser()
    parser.feed(html)
    parser.close()
    return parser


def _generate(tmp_path: Path) -> dict[str, object]:
    json_out = tmp_path / "modular-panel-stage4.6-compatibility.json"
    result = subprocess.run(
        [
            sys.executable,
            str(GENERATOR),
            "--root",
            str(ROOT),
            "--json-out",
            str(json_out),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr or result.stdout
    return json.loads(json_out.read_text(encoding="utf-8"))


def _public_dom_contract(html: str) -> dict[str, object]:
    parsed = _parse(html)
    return {
        "ids": parsed.ids,
        "id_data_attributes": parsed.id_data_attributes,
        "navigation": parsed.navigation,
        "modal_ids": sorted(parsed.modal_ids),
    }


def test_stage4_6_contract_snapshot_is_generated_and_current(tmp_path):
    """Catch a deleted or stale compatibility baseline before profile tests run."""

    assert SNAPSHOT.is_file()
    assert json.loads(SNAPSHOT.read_text(encoding="utf-8")) == _generate(tmp_path)


def test_profile_initial_html_matches_the_compatibility_baseline(tmp_path):
    """Catch an owner gate that adds, removes, or exposes an inactive DOM surface."""

    contract = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    for profile in contract["profiles"]:
        name = profile["id"]
        html = render_panel(profile["active_module_ids"], tmp_path / name)
        parsed = _parse(html)

        assert Counter(parsed.ids).most_common(1)[0][1] == 1
        assert "{{" not in html and "{%" not in html
        assert parsed.navigation == profile["navigation"]
        assert {
            f"view-{screen}" for screen in profile["screen_sections"]
        } <= set(parsed.ids)
        assert not {
            f"view-{screen}" for screen in profile["forbidden_screen_sections"]
        } & set(parsed.ids)
        assert set(profile["required_modal_ids"]) <= parsed.modal_ids
        assert not set(profile["forbidden_modal_ids"]) & parsed.modal_ids
        assert not set(profile["forbidden_dom_ids"]) & set(parsed.ids)

        for identifier, attributes in profile["required_data_attributes"].items():
            assert parsed.id_data_attributes[identifier].items() >= attributes.items()


def test_full_and_legacy_keep_the_same_public_dom_contract(tmp_path):
    """Catch a compatibility regression in the legacy fallback path."""

    contract = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    profiles = {profile["id"]: profile for profile in contract["profiles"]}
    legacy = render_panel(profiles["legacy-full"]["active_module_ids"], tmp_path / "legacy")
    full = render_panel(profiles["full"]["active_module_ids"], tmp_path / "full")

    assert _public_dom_contract(legacy) == _public_dom_contract(full)


def test_registry_legacy_full_activation_keeps_the_full_dom_contract(tmp_path):
    """Catch drift on the path an old installation really takes.

    The page never receives ``None`` in production: without modules.json the
    registry resolves ``legacy-full`` and hands over every installed module,
    deliberately ignoring missing core binaries so no route disappears.
    """

    from services.module_registry import ModuleRegistry

    state_dir = tmp_path / "state"
    state_dir.mkdir()
    activation = ModuleRegistry(
        str(state_dir), which=lambda name: None, environ={}
    ).runtime_activation()
    assert activation["profile"] == "legacy-full"
    assert activation["legacy_compatibility"] is True

    contract = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    profiles = {profile["id"]: profile for profile in contract["profiles"]}
    assert set(activation["active_module_ids"]) == set(profiles["full"]["active_module_ids"])

    legacy = render_panel(list(activation["active_module_ids"]), tmp_path / "legacy")
    full = render_panel(profiles["full"]["active_module_ids"], tmp_path / "full")

    assert _public_dom_contract(legacy) == _public_dom_contract(full)


def test_panel_entrypoint_is_a_composition_root_not_a_surface_owner():
    """Catch a restored monolithic screen or modal directly in panel.html."""

    source = PANEL.read_text(encoding="utf-8")

    assert source.count("{% include screen_partial %}") == 1
    assert source.count("{% include modal_partial %}") == 1
    assert 'id="view-' not in source
    assert 'class="modal' not in source
