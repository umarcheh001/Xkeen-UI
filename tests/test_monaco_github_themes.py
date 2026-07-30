from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
THEMES_DIR = ROOT / "xkeen-ui/static/js/vendor/monaco-themes"
MODULE = ROOT / "xkeen-ui/static/js/vendor/monaco_github_themes.js"
MONACO_SHARED = ROOT / "xkeen-ui/static/js/ui/monaco_shared.js"
OPERATOR_CSS = ROOT / "xkeen-ui/static/panel-operator.css"


def test_github_monaco_theme_sources_are_vendored_with_mit_attribution():
    notice = (THEMES_DIR / "NOTICE.md").read_text(encoding="utf-8-sig")
    license_text = (THEMES_DIR / "LICENSE").read_text(encoding="utf-8-sig")

    assert "brijeshb42/monaco-themes" in notice
    assert "MIT" in notice
    assert "MIT License" in license_text

    for filename, base in (("GitHub-Dark.json", "vs-dark"), ("GitHub-Light.json", "vs")):
        theme = json.loads((THEMES_DIR / filename).read_text(encoding="utf-8-sig"))
        assert theme["base"] == base
        assert theme["inherit"] is True
        assert any(rule.get("token") == "comment" for rule in theme["rules"])


def test_monaco_uses_github_syntax_rules_without_replacing_operator_console_chrome():
    module = MODULE.read_text(encoding="utf-8-sig")
    monaco = MONACO_SHARED.read_text(encoding="utf-8-sig")

    assert "GITHUB_DARK_TOKEN_RULES" in module
    assert "GITHUB_LIGHT_TOKEN_RULES" in module
    assert "rules: GITHUB_DARK_TOKEN_RULES," in monaco
    assert "rules: GITHUB_LIGHT_TOKEN_RULES," in monaco
    assert "'editor.background': darkUi.editorBg," in monaco
    assert "'editor.background': lightUi.editorBg," in monaco
    assert "'editorWidget.background': darkUi.modalBg," in monaco
    assert "'editorWidget.background': lightUi.modalBg," in monaco


def test_monaco_yaml_alias_sigil_uses_a_scoped_operator_console_decoration():
    monaco = MONACO_SHARED.read_text(encoding="utf-8-sig")
    css = OPERATOR_CSS.read_text(encoding="utf-8-sig")

    assert "function _collectYamlAliasSigilDecorations" in monaco
    assert "function _installYamlAliasSigilDecorations" in monaco
    assert "xk-monaco-yaml-alias-sigil" in monaco
    assert "cleanupYamlAliasSigils" in monaco
    assert "body.panel-page .monaco-editor .xk-monaco-yaml-alias-sigil" in css
