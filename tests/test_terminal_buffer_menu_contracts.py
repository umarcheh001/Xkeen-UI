from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_terminal_buffer_menu_keeps_all_download_formats_visible() -> None:
    template = (ROOT / "xkeen-ui" / "templates" / "panel.html").read_text(encoding="utf-8")
    vendor_adapter = (
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "vendors" / "xterm_import_adapter.js"
    ).read_text(encoding="utf-8")
    xterm_manager = (
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "core" / "xterm_manager.js"
    ).read_text(encoding="utf-8")

    for fragment in [
        'id="terminal-btn-download"',
        'id="terminal-btn-download-html"',
        'id="terminal-btn-snapshot-vt"',
    ]:
        assert fragment in template

    assert "../../../xterm/xterm-addon-serialize.js" in vendor_adapter
    assert xterm_manager.index("Serialize is lightweight") < xterm_manager.index("All other addons are opt-in")


def test_terminal_buffer_actions_keep_legacy_ui_method_aliases() -> None:
    actions = (
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "modules" / "buffer_actions.js"
    ).read_text(encoding="utf-8")

    for fragment in [
        "copySelection: () => copy(ctx)",
        "pasteFromClipboard: () => paste(ctx)",
        "downloadText: () => downloadTxt(ctx)",
        "downloadHtml: () => downloadHtml(ctx)",
        "downloadVtSnapshot: () => downloadVtSnapshot(ctx)",
    ]:
        assert fragment in actions
