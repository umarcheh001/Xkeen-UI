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

    required_block = vendor_adapter.split("export const OPTIONAL_XTERM_VENDOR_SPECS", 1)[0]
    for fragment in [
        "../../../xterm/xterm-addon-search.js",
        "../../../xterm/xterm-addon-web-links.js",
        "../../../xterm/xterm-addon-unicode11.js",
        "../../../xterm/xterm-addon-clipboard.js",
        "../../../xterm/xterm-addon-serialize.js",
    ]:
        assert fragment in vendor_adapter
        assert fragment not in required_block

    assert "../../../xterm/xterm-addon-serialize.js" not in required_block
    assert "THIS_BOUND_CLASSIC_VENDOR_SPECS" in vendor_adapter
    assert "classic-global-this" in vendor_adapter
    assert "const names = ['define', 'require', 'requirejs', 'exports', 'module'];" in vendor_adapter
    assert "runClassicVendorWithGlobalThis" in vendor_adapter
    assert "if (classicThis) await runClassicVendorWithGlobalThis(url, scope);" in vendor_adapter
    assert "../../../xterm/xterm-addon-unicode11.js" in vendor_adapter.split(
        "const THIS_BOUND_CLASSIC_VENDOR_SPECS", 1
    )[1]
    assert xterm_manager.index("Serialize is lightweight") < xterm_manager.index("Safe optional addons")


def test_terminal_safe_addons_are_not_hidden_behind_diagnostics_flag() -> None:
    xterm_manager = (
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "core" / "xterm_manager.js"
    ).read_text(encoding="utf-8")

    safe_block = xterm_manager.split("Safe optional addons", 1)[1].split(
        "WebGL renderer and ligatures remain disabled", 1
    )[0]

    for fragment in [
        "new SearchAddon.SearchAddon",
        "new WebLinksAddon.WebLinksAddon",
        "new Unicode11Addon.Unicode11Addon",
        "new ClipboardAddon.ClipboardAddon(undefined, safeClipboardProvider)",
    ]:
        assert fragment in safe_block

    assert "shouldEnableOptionalAddons()" not in safe_block
    assert "typeof navigator !== 'undefined'" in safe_block


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
