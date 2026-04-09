from pathlib import Path


def test_devtools_env_defaults_shell_to_zero_and_marks_live_apply():
    env_py = Path("xkeen-ui/services/devtools/env.py").read_text(encoding="utf-8")
    env_js = Path("xkeen-ui/static/js/features/devtools/env.js").read_text(encoding="utf-8")

    shell_block = env_py.split('if k == "XKEEN_ALLOW_SHELL":', 1)[1].split("\n", 2)
    assert 'return "0"' in "\n".join(shell_block[:2])

    assert "ENV_HELP.XKEEN_ALLOW_SHELL = 'Arbitrary shell" in env_js
    assert "ENV_NO_RESTART_KEYS.add('XKEEN_ALLOW_SHELL');" in env_js
    assert "ENV_RESTART_KEYS.delete('XKEEN_ALLOW_SHELL');" in env_js


def test_terminal_runtime_tracks_shell_policy_and_renders_disabled_notice():
    runtime_text = Path("xkeen-ui/static/js/terminal/runtime.js").read_text(encoding="utf-8")
    core_text = Path("xkeen-ui/static/js/terminal/_core.js").read_text(encoding="utf-8")
    caps_text = Path("xkeen-ui/static/js/terminal/capabilities.js").read_text(encoding="utf-8")
    controller_text = Path("xkeen-ui/static/js/terminal/modules/terminal_controller.js").read_text(encoding="utf-8")
    command_job_text = Path("xkeen-ui/static/js/util/command_job.js").read_text(encoding="utf-8")

    assert "state.hasShell = !!(policy && policy.enabled);" in runtime_text
    assert "shellPolicy: null," in core_text
    assert "let HAS_SHELL = true;" in caps_text
    assert "function hasShell() {" in caps_text
    assert "function getShellPolicy() {" in caps_text
    assert "setTerminalCapabilityState(HAS_WS, HAS_PTY, SHELL_POLICY);" in caps_text
    assert "function buildShellDisabledNotice(ctx, requestedCommand) {" in controller_text
    assert "await refreshCapabilities(c, { force: true });" in controller_text
    assert "Shell-команды в UI отключены по умолчанию." in controller_text
    assert "XKEEN_ALLOW_SHELL" in controller_text
    assert "setInputsEnabled(c, false, titleText);" in controller_text
    assert "CJ.describeRunCommandError = function describeRunCommandError" in command_job_text


def test_commands_route_uses_dynamic_shell_policy_payload():
    text = Path("xkeen-ui/routes/commands.py").read_text(encoding="utf-8")

    assert "is_full_shell_enabled()" in text
    assert '"error": "shell_disabled"' in text
    assert '"message": str(shell_policy.get("message") or "Shell-команды в UI отключены.")' in text
    assert '"shell": shell_policy,' in text
