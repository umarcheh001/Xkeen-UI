"""CodeMirror theme editor (DevTools).

Split out from `services.devtools` to keep the facade smaller and make the
refactor mechanical.

Important: this module intentionally keeps the same behavior / data formats as
before the split.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List

from services.io.atomic import _atomic_write_text

from .common import _file_has_marker, _sanitize_color


CODEMIRROR_THEME_CONFIG_JSON = "codemirror_theme.json"
CODEMIRROR_THEME_CONFIG_CSS = "codemirror_theme.css"
# Bump when generated CSS structure changes (used for auto-regeneration).
CODEMIRROR_THEME_CSS_MARKER = "/* xkeen-ui codemirror theme v3 */"

# ---------------------------------------------------------------------------
# Independent themes: Terminal (xterm.js) and CodeMirror
# ---------------------------------------------------------------------------

_DEFAULT_CODEMIRROR_THEME_CONFIG: Dict[str, Any] = {
    # Used for lightweight migrations of the stock (factory) palette.
    # User-changed palettes are never overwritten.
    "preset": "material-darker-v5",
    "enabled": False,
    "dark": {
        # Default palette is intentionally close to CodeMirror "material-darker"
        # so that enabling the DevTools CodeMirror theme feels like a "refine"
        # instead of a completely different editor.
        # Tuned for xkeen panel dark UI (less "muddy gray", more deep navy)
        "background": "#070c18",
        "text": "#f2f6fc",
        "gutter_bg": "#0b1020",
        "gutter_text": "#56627a",
        "cursor": "#ffd400",
        "selection": "#1e2a4433",
        # Selected text color (used for ::selection + CodeMirror-selectedtext)
        "selection_text": "#e6edf3",
        "active_line": "#101a36",
        # Search match highlight (addon/search/match-highlighter)
        "search_match": "#80cbc433",
        # Rulers (addon/display/rulers)
        "ruler": "#202b45",
        # Indent guides (addon/display/indent-guides + cm-tab guides)
        "indent_guide": "#33415f66",
        # Trailing spaces highlight (addon/edit/trailingspace)
        "trailingspace": "#ff537033",
        # Lint tooltip + line highlights (addon/lint)
        "lint_tooltip_bg": "#212121",
        "lint_tooltip_text": "#eeffff",
        "lint_tooltip_border": "#2a2a2a",
        "lint_error_line": "#ff53701a",
        "lint_warning_line": "#ffcb6b1a",
        "bracket_bg": "#82aaff26",
        "bracket_border": "#82aaff66",
        "bad_bracket_bg": "#ff537026",
        "bad_bracket_border": "#ff537066",
        "dialog_bg": "#212121",
        "dialog_text": "#eeffff",
        "dialog_border": "#2a2a2a",
        "dialog_input_bg": "#212121",
        "dialog_input_text": "#eeffff",
        "dialog_btn_bg": "#212121",
        "dialog_btn_text": "#eeffff",
        "dialog_btn_border": "#2a2a2a",
        "tokens": {
            "keyword": "#d2a6ff",
            "string": "#b7f58a",
            # Numbers should be distinct and readable on the dark background
            "number": "#ffb86c",
            "comment": "#6b8299",
            "atom": "#ff8b6a",
            "def": "#7ab0ff",
            "variable": "#ff6b7a",
            "variable2": "#f2f6fc",
            "builtin": "#ffcc80",
            "meta": "#ffcc80",
            "tag": "#ff4d6d",
            "attribute": "#d2a6ff",
            "error": "#ff4d6d",
            # JSON keys / properties ("routing", "rules"...) should be cyan-ish
            "property": "#7dd3fc",
            "operator": "#7dd3fc",
            "qualifier": "#decb6b",
            "bracket": "#f2f6fc",
            "link": "#7ab0ff",
            "header": "#ffd38a",
        },
    },
    "light": {
        "background": "#ffffff",
        "text": "#111827",
        "gutter_bg": "#ffffff",
        "gutter_text": "#6b7280",
        "cursor": "#0a84ff",
        "selection": "#0a84ff2e",
        "selection_text": "#111827",
        "active_line": "#0a84ff14",
        "search_match": "#f59e0b33",
        "ruler": "#d1d5db",
        "indent_guide": "#1118271f",
        "trailingspace": "#dc26261f",
        "lint_tooltip_bg": "#fff7ed",
        "lint_tooltip_text": "#111827",
        "lint_tooltip_border": "#d1d5db",
        "lint_error_line": "#dc262614",
        "lint_warning_line": "#f59e0b14",
        "bracket_bg": "#0a84ff2e",
        "bracket_border": "#0a84ff73",
        "bad_bracket_bg": "#dc26262e",
        "bad_bracket_border": "#dc26268c",
        "dialog_bg": "#ffffff",
        "dialog_text": "#111827",
        "dialog_border": "#d1d5db",
        "dialog_input_bg": "#f9fafb",
        "dialog_input_text": "#111827",
        "dialog_btn_bg": "#ffffff",
        "dialog_btn_text": "#111827",
        "dialog_btn_border": "#d1d5db",
        "tokens": {
            "keyword": "#1d4ed8",
            "string": "#047857",
            "number": "#a16207",
            "comment": "#6b7280",
            "atom": "#a21caf",
            "def": "#0f766e",
            "variable": "#111827",
            "variable2": "#0369a1",
            "builtin": "#b45309",
            "meta": "#4338ca",
            "tag": "#dc2626",
            "attribute": "#16a34a",
            "error": "#dc2626",
            "property": "#4338ca",
            "operator": "#111827",
            "qualifier": "#a16207",
            "bracket": "#6b7280",
            "link": "#2563eb",
            "header": "#b45309",
        },
    },
}

# ---------------------------------------------------------------------------
# Independent themes (optional): Terminal (xterm.js) and CodeMirror
# ---------------------------------------------------------------------------


def _codemirror_theme_json_path(ui_state_dir: str) -> str:
    return os.path.join(ui_state_dir, CODEMIRROR_THEME_CONFIG_JSON)


def _codemirror_theme_css_path(ui_state_dir: str) -> str:
    return os.path.join(ui_state_dir, CODEMIRROR_THEME_CONFIG_CSS)


_CM_BASE_KEYS = (
    "background", "text",
    "gutter_bg", "gutter_text",
    "cursor", "selection", "active_line",
    "selection_text",
    "search_match",
    "ruler",
    "indent_guide",
    "trailingspace",
    "lint_tooltip_bg", "lint_tooltip_text", "lint_tooltip_border",
    "lint_error_line", "lint_warning_line",
    "bracket_bg", "bracket_border",
    "bad_bracket_bg", "bad_bracket_border",
    "dialog_bg", "dialog_text", "dialog_border",
    "dialog_input_bg", "dialog_input_text",
    "dialog_btn_bg", "dialog_btn_text", "dialog_btn_border",
)

_CM_TOKEN_KEYS = (
    "keyword", "string", "number", "comment", "atom", "def",
    "variable", "variable2", "builtin", "meta", "tag", "attribute", "error",
    "property", "operator", "qualifier", "bracket", "link", "header",
)


def _sanitize_codemirror_theme_config(cfg_in: Any) -> Dict[str, Any]:
    base = json.loads(json.dumps(_DEFAULT_CODEMIRROR_THEME_CONFIG))
    src = cfg_in if isinstance(cfg_in, dict) else {}

    # preset (optional, for migrations)
    try:
        pv = src.get("preset")
        if isinstance(pv, str) and pv.strip():
            base["preset"] = pv.strip()
    except Exception:
        pass

    # enabled
    try:
        ev = src.get("enabled")
        if isinstance(ev, bool):
            base["enabled"] = ev
        elif ev is not None:
            s = str(ev).strip().lower()
            base["enabled"] = s in ("1", "true", "yes", "on", "y")
    except Exception:
        pass

    for mode in ("dark", "light"):
        t_def = base.get(mode) or {}
        t_in = src.get(mode) if isinstance(src.get(mode), dict) else {}

        for k in _CM_BASE_KEYS:
            try:
                t_def[k] = _sanitize_color(t_in.get(k), t_def.get(k))
            except Exception:
                pass

        tok_def = t_def.get("tokens") if isinstance(t_def.get("tokens"), dict) else {}
        tok_in = t_in.get("tokens") if isinstance(t_in.get("tokens"), dict) else {}
        for tk in _CM_TOKEN_KEYS:
            try:
                tok_def[tk] = _sanitize_color(tok_in.get(tk), tok_def.get(tk))
            except Exception:
                pass
        t_def["tokens"] = tok_def
        base[mode] = t_def

    return base


def _maybe_migrate_stock_palette(cfg: Dict[str, Any], raw: Any) -> Dict[str, Any]:
    """Migrate *factory* palette to the newer, less-bled preset.

    We only migrate when:
      - the old config has no 'preset' field (pre-v4), and
      - key colors still match the old factory defaults (so user didn't tune).

    This avoids overwriting user customization.
    """

    try:
        if isinstance(raw, dict) and isinstance(raw.get("preset"), str):
            # If user already has a preset, normally keep it. But we may migrate
            # the *factory* v4 preset to v5 when it still matches stock colors.
            if str(raw.get("preset")) != "material-darker-v4":
                return cfg


        dark = cfg.get("dark") if isinstance(cfg.get("dark"), dict) else {}
        tok = dark.get("tokens") if isinstance(dark.get("tokens"), dict) else {}

        # Heuristic: very old defaults used a muddy gray background and red-ish numbers.
        if (
            str(dark.get("background")).lower() == "#212121"
            and str(tok.get("string")).lower() == "#c3e88d"
            and str(tok.get("number")).lower() == "#ff5370"
        ):
            migrated = json.loads(json.dumps(_DEFAULT_CODEMIRROR_THEME_CONFIG))
            # Preserve user's enabled flag if they used it as a switch.
            if isinstance(cfg.get("enabled"), bool):
                migrated["enabled"] = cfg.get("enabled")
            return migrated

        # Heuristic: migrate factory v4 preset to v5 when unchanged by user.
        if (
            str((raw or {}).get("preset")) == "material-darker-v4"
            and str(dark.get("background")).lower() == "#0b1020"
            and str(tok.get("property")).lower() == "#89ddff"
            and str(tok.get("string")).lower() == "#c3e88d"
            and str(tok.get("number")).lower() == "#ffcb6b"
        ):
            migrated = json.loads(json.dumps(_DEFAULT_CODEMIRROR_THEME_CONFIG))
            if isinstance(cfg.get("enabled"), bool):
                migrated["enabled"] = cfg.get("enabled")
            return migrated
    except Exception:
        pass

    return cfg


def _codemirror_theme_css_from_config(cfg: Dict[str, Any]) -> str:
    lines: List[str] = []
    lines.append(CODEMIRROR_THEME_CSS_MARKER)
    lines.append("/* Generated by DevTools: CodeMirror */")
    lines.append("")

    # NOTE:
    # Historically this stylesheet acted as the *only* syntax-color source when the
    # global theme layer normalized CodeMirror surfaces to CSS variables.
    # If we output nothing when "enabled" is false, some pages end up effectively
    # monochrome (because global theme CSS has many `!important` rules).
    #
    # So we always emit a small baseline token palette (close to CodeMirror's
    # material-darker / default), and only switch to the full user-configured
    # override when the DevTools toggle is enabled.
    is_enabled = bool((cfg or {}).get("enabled"))

    def rule(sel: str, body: List[str]) -> None:
        lines.append(f"{sel} {{")
        for ln in body:
            lines.append("  " + ln)
        lines.append("}")

    def rule(sel: str, body: List[str]) -> None:
        lines.append(f"{sel} {{")
        for ln in body:
            lines.append("  " + ln)
        lines.append("}")

    def emit_tokens(mode: str, t: Dict[str, Any]) -> None:
        tok = t.get("tokens") if isinstance(t.get("tokens"), dict) else {}
        r = f":root[data-theme=\"{mode}\"]"

        token_map = {
            "keyword": ".cm-keyword",
            "string": ".cm-string",
            "number": ".cm-number",
            "comment": ".cm-comment",
            "atom": ".cm-atom",
            "def": ".cm-def",
            "variable": ".cm-variable",
            "variable2": ".cm-variable-2",
            "builtin": ".cm-builtin",
            "meta": ".cm-meta",
            "tag": ".cm-tag",
            "attribute": ".cm-attribute",
            "error": ".cm-error",
            "property": ".cm-property",
            "operator": ".cm-operator",
            "qualifier": ".cm-qualifier",
            "bracket": ".cm-bracket",
            "link": ".cm-link",
            "header": ".cm-header",
        }

        # Apply to both built-in themes (default + material-darker). Some pages
        # temporarily switch themes based on panel theme.
        for k, sel in token_map.items():
            if tok.get(k):
                rule(
                    f"{r} .cm-s-default {sel}, {r} .cm-s-material-darker {sel}",
                    [f"color: {tok.get(k)} !important;"],
                )

        # CodeMirror uses background for .cm-error in material-darker. Keep error
        # visible even if the global theme overrides backgrounds.
        if tok.get("error"):
            rule(
                f"{r} .cm-s-default .cm-error, {r} .cm-s-material-darker .cm-error",
                [
                    f"color: {tok.get('error')} !important;",
                    "background: transparent !important;",
                ],
            )


    if not is_enabled:
        lines.append("/* baseline (DevTools CodeMirror theme: Disabled) */")
        lines.append("/* Keeps syntax colors readable even when global theme normalizes surfaces. */")
        for mode in ("dark", "light"):
            t = (cfg or {}).get(mode) if isinstance((cfg or {}).get(mode), dict) else {}
            emit_tokens(mode, t)
            lines.append("")
        return "\n".join(lines) + "\n"

    for mode in ("dark", "light"):
        t = (cfg or {}).get(mode) if isinstance((cfg or {}).get(mode), dict) else {}
        r = f":root[data-theme=\"{mode}\"]"

        # Surfaces
        rule(
            f"{r} .CodeMirror, {r} .cm-s-default.CodeMirror, {r} .cm-s-material-darker.CodeMirror",
            [f"background: {t.get('background')} !important;", f"color: {t.get('text')} !important;"],
        )

        # IMPORTANT: the visible editor surface is the scroll element. Our global
        # Theme generator may set `.CodeMirror-scroll { background: ... !important; }`,
        # which would visually override the wrapper background. Keep scroll bg in sync
        # with the configured editor background.
        rule(
            f"{r} .CodeMirror-scroll",
            [f"background: {t.get('background')} !important;"],
        )
        rule(
            f"{r} .CodeMirror-gutters",
            [f"background: {t.get('gutter_bg')} !important;", "border-right: 1px solid var(--border) !important;"],
        )
        rule(f"{r} .CodeMirror-linenumber", [f"color: {t.get('gutter_text')} !important;"])
        rule(f"{r} .CodeMirror-cursor", [f"border-left-color: {t.get('cursor')} !important;"])
        rule(
            f"{r} .CodeMirror-selected, {r} div.CodeMirror-selected",
            [f"background: {t.get('selection')} !important;"],
        )

        # Native selection (when CodeMirror uses ::selection) + selected text color.
        rule(
            f"{r} .CodeMirror-line::selection, {r} .CodeMirror-line > span::selection, {r} .CodeMirror-line > span > span::selection",
            [
                f"background: {t.get('selection')} !important;",
                f"color: {t.get('selection_text')} !important;",
            ],
        )
        rule(
            f"{r} .CodeMirror-line::-moz-selection, {r} .CodeMirror-line > span::-moz-selection, {r} .CodeMirror-line > span > span::-moz-selection",
            [
                f"background: {t.get('selection')} !important;",
                f"color: {t.get('selection_text')} !important;",
            ],
        )
        rule(
            f"{r} span.CodeMirror-selectedtext",
            [f"color: {t.get('selection_text')} !important;"],
        )

        # Search match highlight (match-highlighter addon uses .cm-searching)
        rule(
            f"{r} .cm-searching",
            [f"background-color: {t.get('search_match')} !important;"],
        )

        # Rulers (addon/display/rulers)
        rule(
            f"{r} .CodeMirror-ruler",
            [f"border-left-color: {t.get('ruler')} !important;"],
        )

        # Indent guides (addon/display/indent-guides + cm-tab guides in our UI)
        rule(
            f"{r} .xkeen-cm .cm-indent-guide::before, {r} .xkeen-cm .CodeMirror-code .cm-tab::before",
            [f"border-left-color: {t.get('indent_guide')} !important;"],
        )

        # Trailing spaces highlight (addon/edit/trailingspace)
        rule(
            f"{r} .cm-trailingspace",
            [f"background-color: {t.get('trailingspace')} !important;"],
        )

        # Lint addon (tooltip + highlighted lines)
        rule(
            f"{r} .CodeMirror-lint-tooltip",
            [
                f"background-color: {t.get('lint_tooltip_bg')} !important;",
                f"color: {t.get('lint_tooltip_text')} !important;",
                f"border-color: {t.get('lint_tooltip_border')} !important;",
            ],
        )
        rule(
            f"{r} .CodeMirror-lint-line-error",
            [f"background-color: {t.get('lint_error_line')} !important;"],
        )
        rule(
            f"{r} .CodeMirror-lint-line-warning",
            [f"background-color: {t.get('lint_warning_line')} !important;"],
        )
        rule(
            f"{r} .CodeMirror-activeline-background",
            [f"background: {t.get('active_line')} !important;"],
        )
        rule(
            f"{r} .CodeMirror-activeline-gutter",
            [f"background: {t.get('active_line')} !important;"],
        )
        rule(
            f"{r} .CodeMirror-matchingbracket",
            [
                f"background: {t.get('bracket_bg')} !important;",
                f"outline: 1px solid {t.get('bracket_border')} !important;",
                "color: inherit !important;",
            ],
        )
        rule(
            f"{r} .CodeMirror-nonmatchingbracket",
            [
                f"background: {t.get('bad_bracket_bg')} !important;",
                f"outline: 1px solid {t.get('bad_bracket_border')} !important;",
                "color: inherit !important;",
            ],
        )

        # Tokens
        emit_tokens(mode, t)

        # Dialog (search/replace)
        rule(
            f"{r} .CodeMirror-dialog",
            [
                f"background: {t.get('dialog_bg')} !important;",
                f"color: {t.get('dialog_text')} !important;",
                f"border-bottom: 1px solid {t.get('dialog_border')} !important;",
            ],
        )
        rule(
            f"{r} .CodeMirror-dialog input",
            [
                f"background: {t.get('dialog_input_bg')} !important;",
                f"color: {t.get('dialog_input_text')} !important;",
                f"border: 1px solid {t.get('dialog_border')} !important;",
            ],
        )
        rule(
            f"{r} .CodeMirror-dialog button",
            [
                f"background: {t.get('dialog_btn_bg')} !important;",
                f"color: {t.get('dialog_btn_text')} !important;",
                f"border: 1px solid {t.get('dialog_btn_border')} !important;",
            ],
        )

        lines.append("")

    return "\n".join(lines) + "\n"


def codemirror_theme_get(ui_state_dir: str) -> Dict[str, Any]:
    cfg = json.loads(json.dumps(_DEFAULT_CODEMIRROR_THEME_CONFIG))
    exists = False
    jpath = _codemirror_theme_json_path(ui_state_dir)
    cpath = _codemirror_theme_css_path(ui_state_dir)

    try:
        if os.path.isfile(jpath):
            with open(jpath, "r", encoding="utf-8", errors="ignore") as f:
                raw = json.load(f)
            cfg = _sanitize_codemirror_theme_config(raw)
            cfg = _maybe_migrate_stock_palette(cfg, raw)
            exists = True
            try:
                if not os.path.isfile(cpath) or not _file_has_marker(cpath, CODEMIRROR_THEME_CSS_MARKER):
                    _atomic_write_text(cpath, _codemirror_theme_css_from_config(cfg), mode=0o644)
            except Exception:
                pass
        elif os.path.isfile(cpath):
            exists = True
    except Exception:
        cfg = json.loads(json.dumps(_DEFAULT_CODEMIRROR_THEME_CONFIG))

    version = 0
    try:
        if os.path.isfile(cpath):
            version = int(os.path.getmtime(cpath) or 0)
    except Exception:
        version = 0

    return {"config": cfg, "exists": bool(exists), "version": version, "css_file": cpath, "json_file": jpath}


def codemirror_theme_set(ui_state_dir: str, cfg_in: Any) -> Dict[str, Any]:
    cfg = _sanitize_codemirror_theme_config(cfg_in)
    jpath = _codemirror_theme_json_path(ui_state_dir)
    cpath = _codemirror_theme_css_path(ui_state_dir)
    _atomic_write_text(jpath, json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", mode=0o600)
    _atomic_write_text(cpath, _codemirror_theme_css_from_config(cfg), mode=0o644)
    version = 0
    try:
        version = int(os.path.getmtime(cpath) or 0)
    except Exception:
        version = 0
    return {"config": cfg, "exists": True, "version": version, "css_file": cpath, "json_file": jpath}


def codemirror_theme_reset(ui_state_dir: str) -> Dict[str, Any]:
    for fp in (_codemirror_theme_json_path(ui_state_dir), _codemirror_theme_css_path(ui_state_dir)):
        try:
            if os.path.exists(fp):
                os.remove(fp)
        except Exception:
            pass
    return codemirror_theme_get(ui_state_dir)
