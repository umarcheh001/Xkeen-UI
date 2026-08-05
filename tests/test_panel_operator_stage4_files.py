from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "xkeen-ui/templates/panel.html"
CSS = ROOT / "xkeen-ui/static/panel-operator.css"
RENDER = ROOT / "xkeen-ui/static/js/features/file_manager/render.js"
LISTING = ROOT / "xkeen-ui/static/js/features/file_manager/listing.js"
DRAGDROP = ROOT / "xkeen-ui/static/js/features/file_manager/dragdrop.js"
STATE = ROOT / "xkeen-ui/static/js/features/file_manager/state.js"
CHROME = ROOT / "xkeen-ui/static/js/features/file_manager/chrome.js"
STYLES = ROOT / "xkeen-ui/static/styles.css"
PLAN = ROOT / "docs/panel-operator-redesign-completion-plan.md"
DOC = ROOT / "docs/panel-operator-stage4-files.md"
INDEX = ROOT / "docs/README.md"


def test_files_markup_exposes_toolbar_and_dual_grid_contract():
    text = TEMPLATE.read_text(encoding="utf-8")
    view = text[text.index('id="view-files"') : text.index('id="view-xray-logs"')]

    for fragment in (
        'aria-labelledby="fm-title" data-fm-workspace="1"',
        'class="fm-header-actions fm-toolbar" role="toolbar"',
        'class="fm-panel-bar fm-toolbar" role="toolbar"',
        'class="fm-list" tabindex="0" role="grid" aria-multiselectable="true"',
        'class="fm-footer-actions fm-toolbar" role="toolbar"',
        'data-state="loading"',
        'aria-busy="true"',
    ):
        assert fragment in view

    assert 'aria-label="Target"' not in view
    assert "filename='panel-operator.css', v='20260805f'" in text


def test_files_runtime_exposes_loading_empty_error_selection_focus_and_drop_states():
    render = RENDER.read_text(encoding="utf-8")
    listing = LISTING.read_text(encoding="utf-8")
    dragdrop = DRAGDROP.read_text(encoding="utf-8")
    state = STATE.read_text(encoding="utf-8")

    for fragment in (
        "function setPanelState(pd, state)",
        "className = 'fm-panel-state fm-loading'",
        "className = 'fm-panel-state fm-empty'",
        "className = 'fm-panel-state fm-panel-error'",
        "empty.dataset.state = hasFilter ? 'filtered-empty'",
        "row.setAttribute('aria-selected', selected ? 'true' : 'false');",
        "list.setAttribute('aria-activedescendant', f.id);",
        "c.setAttribute('aria-sort'",
    ):
        assert fragment in render

    for fragment in (
        "p.loading = true;",
        "p.loading = false;",
        "pd.list.setAttribute('aria-busy', 'true');",
        "pd.list.setAttribute('aria-busy', 'false');",
    ):
        assert fragment in listing

    for fragment in (
        "candidate.classList.toggle('is-dragging'",
        "pd.list.dataset.dropState",
        "pd.list.dataset.dropEffect",
        "clearDropUi();",
    ):
        assert fragment in dragdrop

    assert "d.root.dataset.active = s === side ? 'true' : 'false';" in state


def test_files_operator_layer_finishes_rows_states_and_drag_feedback():
    css = CSS.read_text(encoding="utf-8")
    stage = css[css.index("/* File manager: one dual-pane workspace") : css.index("/* Terminal:")]

    for fragment in (
        ".fm-toolbar",
        '.fm-list[aria-busy="true"]',
        ".fm-row.is-selected.is-focused",
        '.fm-row[draggable="true"].is-dragging',
        ".fm-list.is-drop-target::after",
        ".fm-panel-state",
        '.fm-empty[data-state="filtered-empty"]',
        "border-left: 2px solid var(--op-border-strong) !important;",
        "font-size: calc(13px * var(--xk-font-scale, 1));",
        "color-mix(in srgb, var(--op-accent) 24%, var(--op-border-strong))",
        "color-mix(in srgb, var(--op-accent) 2%, var(--op-editor))",
        "inset 2px 0 0 color-mix(in srgb, var(--op-accent) 34%, var(--op-border-strong)) !important;",
    ):
        assert fragment in stage

    for legacy in ("linear-gradient(", "transform: translateY"):
        assert legacy not in stage


def test_files_bottom_resize_and_same_folder_drop_cancel_are_explicit():
    chrome = CHROME.read_text(encoding="utf-8")
    styles = STYLES.read_text(encoding="utf-8")
    dragdrop = DRAGDROP.read_text(encoding="utf-8")

    assert "{ side: 'bottom', className: 'fm-resize-handle-bottom', cursor: 'ns-resize' }" in chrome
    assert "cfg.side === 'bottom'" in chrome
    assert "maxH: 4096" in chrome
    assert "Math.round(window.innerHeight * 0.90)" not in chrome
    assert ".fm-resize-handle-bottom{" in styles
    assert "cursor: ns-resize;" in styles

    operator = CSS.read_text(encoding="utf-8")
    card = operator[operator.index("body.panel-page .fm-card,") : operator.index("body.panel-page .fm-header {")]
    assert "max-height: none;" in card

    guard = dragdrop.index("if (sameLocalDir || sameRemoteDir) return;")
    modal = dragdrop.index("chosenOp = await openDropOpModal", guard)
    assert guard < modal
    assert "Источник и назначение совпадают" not in dragdrop


def test_file_bookmark_controls_use_centered_operator_icons_without_emoji_actions():
    css = CSS.read_text(encoding="utf-8")
    bookmarks = (ROOT / "xkeen-ui/static/js/features/file_manager/bookmarks.js").read_text(encoding="utf-8")
    template = TEMPLATE.read_text(encoding="utf-8")

    for fragment in (
        ".fm-bookmarks-control",
        ".fm-bookmarks-glyph",
        "place-items: center;",
        ".fm-bm-row",
        "grid-template-columns: minmax(140px, .6fr)",
    ):
        assert fragment in css

    assert "iconHtml('bookmark')" in bookmarks
    assert "📌" not in bookmarks
    assert "⭐" not in template
    assert "{{ op_icon('bookmark') }}" in template



def test_files_closure_is_documented():
    plan = PLAN.read_text(encoding="utf-8")
    doc = DOC.read_text(encoding="utf-8")
    index = INDEX.read_text(encoding="utf-8")

    assert "Задача «Files» закрыта 29 июля 2026 года" in plan
    assert "[x] **Files:**" in plan
    assert "panel-operator-stage4-files.md" in plan
    assert "Статус: **задача «Files» Этапа 4 закрыта 29 июля 2026 года**." in doc
    assert "## State contract" in doc
    assert "## Автоматические проверки" in doc
    assert "panel-operator-stage4-files.md" in index
