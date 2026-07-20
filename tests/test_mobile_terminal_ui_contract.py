from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
APP_ROOT = ROOT / "android-companion" / "app" / "src" / "main" / "java" / "io" / "xkeen" / "mobile" / "app"


def _source(name: str) -> str:
    return (APP_ROOT / name).read_text(encoding="utf-8")


def test_terminal_reuses_editor_fullscreen_shell():
    app = _source("CompanionApp.kt")
    navigation = _source("WorkspaceNavigationUi.kt")
    terminal = _source("TerminalWorkspaceUi.kt")

    assert "state.workspaceSection == WorkspaceSection.ShellTerminal" in app
    assert "WorkspaceSection.ShellTerminal -> TerminalWorkspaceScreen(" in navigation
    assert "isFullscreen = isEditorFullscreen" in navigation
    assert "onFullscreenChange = onEditorFullscreenChange" in navigation
    assert "Icons.Outlined.FullscreenExit else Icons.Outlined.Fullscreen" in terminal
    assert "BackHandler(enabled = !isImeVisible && (showFind.value || isFullscreen))" in terminal


def test_terminal_quick_keys_stay_above_the_ime():
    terminal = _source("TerminalWorkspaceUi.kt")

    assert ".imePadding()" in terminal
    assert "if (!isImeVisible)" in terminal
    assert terminal.index("TerminalConnectionStatus(") < terminal.index("TerminalQuickKeys(")
    assert "imeVisible = isImeVisible" in terminal


def test_terminal_keeps_core_keys_visible_before_scrollable_extras():
    terminal = _source("TerminalWorkspaceUi.kt")

    core = [
        'TerminalKey("CTRL+C", 68.dp',
        'TerminalKey("TAB", 48.dp',
        'TerminalKey("ESC", 48.dp',
        'TerminalKey("←", 42.dp',
        'TerminalKey("↑", 42.dp',
        'TerminalKey("↓", 42.dp',
        'TerminalKey("→", 42.dp',
    ]
    positions = [terminal.index(fragment) for fragment in core]

    assert positions == sorted(positions)
    assert positions[-1] < terminal.index('TerminalKey("|", 42.dp')
    assert ".horizontalScroll(scrollState)" in terminal
    assert 'TerminalKey("HOME", 60.dp) { onInput("\\u001b[H") }' in terminal
    assert 'TerminalKey("END", 54.dp) { onInput("\\u001b[F") }' in terminal
    assert 'TerminalKey("DEL", 52.dp) { onInput("\\u001b[3~") }' in terminal
    assert 'TerminalKey("CTRL+L", 68.dp) { onInput("\\u000c") }' in terminal
