"""Core-source controls belong to the shared core-management dialog."""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SHARED_MODAL = (ROOT / "xkeen-ui/templates/panel/modals/shared.html").read_text(
    encoding="utf-8"
)
ROUTING = (ROOT / "xkeen-ui/templates/panel/screens/routing.html").read_text(
    encoding="utf-8"
)
MIHOMO = (ROOT / "xkeen-ui/templates/panel/screens/mihomo.html").read_text(
    encoding="utf-8"
)
SOURCE = (ROOT / "xkeen-ui/templates/panel/core_source.html").read_text(
    encoding="utf-8"
)
CSS = (ROOT / "xkeen-ui/static/panel-operator.css").read_text(encoding="utf-8")


def test_source_controls_are_rendered_by_the_shared_core_modal():
    modal_start = SHARED_MODAL.index('id="core-modal"')
    modal_end = SHARED_MODAL.index('id="confirm-modal"')
    modal = SHARED_MODAL[modal_start:modal_end]
    templates = ROOT / "xkeen-ui/templates/panel"

    # The dialog hosts the controls of every active engine; which engines are
    # active is decided by the composition manifest, not by this template.
    assert "{% for core_source_control_partial in page_context.core_source_control_partials %}" in modal
    assert "{% include core_source_control_partial %}" in modal
    for engine, label in (("xray", "Xray"), ("mihomo", "Mihomo")):
        slot = (templates / f"slots/core_source_{engine}.html").read_text(encoding="utf-8")
        dialogs = (templates / f"modals/core_source_{engine}.html").read_text(encoding="utf-8")
        assert f"render_core_source_controls('{engine}', '{label}')" in slot
        assert f"render_core_source_modals('{engine}', '{label}')" in dialogs
    assert 'data-core-source data-core-engine="{{ engine_id }}"' in SOURCE


def test_editor_screens_do_not_render_source_controls_above_workspaces():
    assert "render_core_source" not in ROUTING
    assert "render_core_source" not in MIHOMO


def test_source_modal_notice_describes_verified_published_releases():
    assert "опубликованный релиз с совпавшей SHA-256" in SOURCE
    assert "только стабильный релиз" not in SOURCE


def test_core_management_actions_and_dialogs_keep_operator_spacing():
    for fragment in (
        ".xk-core-source-control",
        "display: inline-flex !important;",
        "align-items: center;",
        "background: var(--op-surface-2)",
        "#core-modal .xk-core-modal-body",
        "padding: 16px",
        ".xk-core-source-modal .modal-body",
        "padding: 16px 18px",
    ):
        assert fragment in CSS
