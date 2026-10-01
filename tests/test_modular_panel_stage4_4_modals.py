from __future__ import annotations

import re
from pathlib import Path

import pytest

from routes.pages import PANEL_COMPOSITION
from scripts.panel_template_source import compose_panel_template
from tests.support.panel_render import (
    FULL_MODULE_IDS,
    MIHOMO_MINIMAL_MODULE_IDS,
    XRAY_MINIMAL_MODULE_IDS,
    render_panel,
)


ROOT = Path(__file__).resolve().parents[1]
PANEL = ROOT / "xkeen-ui/templates/panel.html"
MODALS_DIR = ROOT / "xkeen-ui/templates/panel/modals"

# partial -> (manifest owners, owned ids)
MODAL_PARTIALS = {
    "diagnostics": (("tool.advanced-diagnostics",), ("xk-resource-dashboard-modal",)),
    "routing": (
        ("engine.xray",),
        (
            "xray-context-modal", "xray-devices-modal", "routing-dns-over-vless-modal",
            "inbounds-apply-modal", "routing-balancer-help-modal", "xray-snapshot-modal",
            "routing-template-modal", "routing-template-save-modal", "routing-template-edit-modal",
            "outbounds-generator-modal", "outbounds-pool-modal", "routing-dat-contents-modal",
        ),
    ),
    "commands": (
        ("tool.terminal",),
        (
            "terminal-overlay", "terminal-history-modal", "ssh-modal", "ssh-edit-modal",
            "ssh-confirm-modal", "ssh-transfer-modal",
        ),
    ),
    "shared": (
        ("core",),
        (
            "core-modal", "confirm-modal", "github-export-modal", "github-catalog-modal",
            "donate-modal", "ui-settings-modal",
        ),
    ),
    "mihomo": (
        ("engine.mihomo",),
        ("mihomo-dns-modal", "mihomo-import-modal", "mihomo-proxy-tools-modal", "mihomo-validation-modal"),
    ),
    "happ": (("integration.happ", "engine.mihomo"), ("mihomo-hwid-modal",)),
    "files": (
        ("tool.files",),
        (
            "fm-upload-conflict-modal", "fm-connect-modal", "fm-knownhosts-modal", "fm-create-modal",
            "fm-rename-modal", "fm-archive-modal", "fm-extract-modal", "fm-folder-picker-modal",
            "fm-archive-list-modal", "fm-mask-modal", "fm-props-modal", "fm-hash-modal",
            "fm-chmod-modal", "fm-chown-modal", "fm-dropop-modal", "fm-conflicts-modal",
            "fm-bookmarks-modal", "fm-download-multi-modal", "fm-progress-modal", "fm-ops-modal",
            "fm-volumes-modal", "fm-help-modal",
        ),
    ),
    "files_editor": (("tool.files", "tool.editor"), ("fm-editor-modal",)),
    "editor": (("tool.editor",), ("json-editor-modal",)),
    # Rendered by the core_source macro, so the static source holds no ids.
    "core_source_xray": (("engine.xray",), ()),
    "core_source_mihomo": (("engine.mihomo",), ()),
}
ALL_MODAL_IDS = {modal_id for _gate, ids in MODAL_PARTIALS.values() for modal_id in ids}
CORE_SOURCE_MODAL_IDS = {
    "core_source_xray": ("xray-core-source-modal", "xray-core-install-modal"),
    "core_source_mihomo": ("mihomo-core-source-modal", "mihomo-core-install-modal"),
}

def _modal_ids(html: str) -> set[str]:
    found = set()
    # A modal root carries the bare "modal" class ("modal-hint" etc. do not count).
    for match in re.finditer(r'<div\s+id="([^"]+)"\s+class="(?:modal(?:\s[^"]*)?|terminal-overlay)"', html):
        found.add(match.group(1))
    for match in re.finditer(r'<div\s*\n\s*id="([^"]+)"\s*\n\s*class="modal[\s"]', html):
        found.add(match.group(1))
    return found


def test_every_modal_lives_in_exactly_one_owner_partial():
    panel = PANEL.read_text(encoding="utf-8")

    assert not _modal_ids(panel), "panel.html must not keep modal markup"
    assert not re.search(r'class="modal[\s"]', panel)
    seen: dict[str, str] = {}
    for name, (_gate, ids) in MODAL_PARTIALS.items():
        markup = (MODALS_DIR / f"{name}.html").read_text(encoding="utf-8")
        assert _modal_ids(markup) == set(ids), name
        assert "{% if " not in markup, f"{name}: gates belong to panel.html"
        for modal_id in ids:
            assert modal_id not in seen, (modal_id, seen.get(modal_id), name)
            seen[modal_id] = name
    assert {path.stem for path in MODALS_DIR.glob("*.html")} == set(MODAL_PARTIALS)


@pytest.mark.parametrize("name", sorted(MODAL_PARTIALS))
def test_modal_gate_is_declared_in_composition_root(name):
    panel = PANEL.read_text(encoding="utf-8")
    owners, _ids = MODAL_PARTIALS[name]

    assert "{% for modal_partial in page_context.modal_partials %}" in panel
    assert "{% include modal_partial %}" in panel
    assert [
        entry.owners
        for entry in PANEL_COMPOSITION
        if entry.template == f"panel/modals/{name}.html"
    ] == [owners]


def test_modal_composition_keeps_the_dom_contract():
    source = compose_panel_template(ROOT)

    assert _modal_ids(source) == ALL_MODAL_IDS
    ids = re.findall(r'\bid=["\']([^"\']+)["\']', source)
    assert len(ids) == len(set(ids))
    # Modals stay inside the app container, before toast/footer and scripts.
    footer = source.index('<footer class="panel-footer">')
    for modal_id in ALL_MODAL_IDS:
        assert source.index(f'id="{modal_id}"') < footer, modal_id
    assert source.index('id="confirm-modal"') < source.index('id="json-editor-modal"')


def test_initial_html_contains_only_modals_of_active_modules(tmp_path, monkeypatch):
    monkeypatch.delenv("XKEEN_UI_PANEL_SECTIONS_WHITELIST", raising=False)

    def modal_set(module_ids, name):
        return _modal_ids(render_panel(module_ids, tmp_path / name))

    def owned(*partials):
        return {
            modal_id
            for partial in partials
            for modal_id in (*MODAL_PARTIALS[partial][1], *CORE_SOURCE_MODAL_IDS.get(partial, ()))
        }

    assert modal_set(FULL_MODULE_IDS, "full") == owned(*MODAL_PARTIALS)
    assert modal_set(XRAY_MINIMAL_MODULE_IDS, "xray") == owned(
        "routing", "shared", "core_source_xray", "editor"
    )
    assert modal_set(MIHOMO_MINIMAL_MODULE_IDS, "mihomo") == owned(
        "mihomo", "shared", "core_source_mihomo", "editor"
    )
    assert modal_set(["core"], "core") == owned("shared")

    # Composite gates: HWID needs Mihomo, the file editor needs the editor.
    with_happ = modal_set([*MIHOMO_MINIMAL_MODULE_IDS, "integration.happ"], "mihomo-happ")
    assert "mihomo-hwid-modal" in with_happ
    assert "mihomo-hwid-modal" not in modal_set([*XRAY_MINIMAL_MODULE_IDS, "integration.happ"], "xray-happ")
    files_only = modal_set(["core", "tool.files"], "files-only")
    assert owned("files") <= files_only and "fm-editor-modal" not in files_only
    assert "fm-editor-modal" in modal_set(["core", "tool.files", "tool.editor"], "files-editor")


def test_core_source_modals_belong_to_their_engine_partials():
    macro = (ROOT / "xkeen-ui/templates/panel/core_source.html").read_text(encoding="utf-8")
    shared = (MODALS_DIR / "shared.html").read_text(encoding="utf-8")
    templates = ROOT / "xkeen-ui/templates/panel"

    assert _modal_ids(macro) == {"{{ engine_id }}-core-source-modal", "{{ engine_id }}-core-install-modal"}
    assert "render_core_source" not in shared
    for name, engine in (("core_source_xray", "xray"), ("core_source_mihomo", "mihomo")):
        partial = (MODALS_DIR / f"{name}.html").read_text(encoding="utf-8")
        assert partial.count("render_core_source_modals(") == 1
        assert f"render_core_source_modals('{engine}'," in partial
    for path in templates.glob("screens/*.html"):
        assert "render_core_source" not in path.read_text(encoding="utf-8"), path.name


def test_hwid_trigger_follows_its_modal(tmp_path, monkeypatch):
    monkeypatch.delenv("XKEEN_UI_PANEL_SECTIONS_WHITELIST", raising=False)
    screen = (ROOT / "xkeen-ui/templates/panel/screens/mihomo.html").read_text(encoding="utf-8")

    # The only module condition inside a screen partial: a documented mixed boundary.
    assert screen.count("{% if has_happ %}") == 1
    without = render_panel(MIHOMO_MINIMAL_MODULE_IDS, tmp_path / "without")
    with_happ = render_panel([*MIHOMO_MINIMAL_MODULE_IDS, "integration.happ"], tmp_path / "with")
    assert 'id="mihomo-hwid-sub-btn"' not in without
    assert 'id="mihomo-hwid-modal"' not in without
    assert 'id="mihomo-hwid-sub-btn"' in with_happ
    assert 'id="mihomo-hwid-modal"' in with_happ


def test_stage4_4_closure_is_documented():
    plan = (ROOT / "README-modular-panel-plan.md").read_text(encoding="utf-8")
    contract = (ROOT / "docs/modular-panel-stage4.4-modals.md").read_text(encoding="utf-8")
    index = (ROOT / "docs/README.md").read_text(encoding="utf-8")

    assert "### Подэтап 4.4. Разделение модальных окон и module-owned markup\n\n**Статус:** закрыт 30 сентября 2026 года." in plan
    assert "modular-panel-stage4.4-modals.md" in plan
    assert "modular-panel-stage4.4-modals.md" in index
    assert "Критерий завершения **выполнен**" in contract
