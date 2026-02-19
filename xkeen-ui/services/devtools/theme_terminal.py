"""Terminal (xterm.js) theme editor (DevTools).

Split out from `services.devtools` to keep the facade smaller and make the
going refactor mechanical.

Important: this module intentionally keeps the same behavior / data formats as
before the split.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List

from services.io.atomic import _atomic_write_text

from .common import _file_has_marker, _sanitize_color


TERMINAL_THEME_CONFIG_JSON = "terminal_theme.json"
TERMINAL_THEME_CONFIG_CSS = "terminal_theme.css"
TERMINAL_THEME_CSS_MARKER = "/* xkeen-ui terminal theme v2 */"

_DEFAULT_TERMINAL_THEME_CONFIG: Dict[str, Any] = {
    "enabled": False,
    "dark": {
        "background": "#020617",
        "foreground": "#e5e7eb",
        "cursor": "#60a5fa",
        "cursor_accent": "#020617",
        # Optional separate cursor colors when cursorBlink=true in xterm options.
        "cursor_blink": "#60a5fa",
        "cursor_blink_accent": "#020617",
        # Selection colors (#RRGGBBAA allowed)
        "selection": "#60a5fa52",  # ~0.32 alpha
        "selection_foreground": "#e5e7eb",
        # Scrollbar colors for xterm viewport
        "scrollbar_track": "#0b1220",
        "scrollbar_thumb": "#475569cc",
        "scrollbar_thumb_hover": "#64748bcc",
        "palette": {
            "black": "#0b1220",
            "red": "#f87171",
            "green": "#22c55e",
            "yellow": "#fbbf24",
            "blue": "#60a5fa",
            "magenta": "#f472b6",
            "cyan": "#22d3ee",
            "white": "#e5e7eb",
            "brightBlack": "#334155",
            "brightRed": "#fecaca",
            "brightGreen": "#bbf7d0",
            "brightYellow": "#fef08a",
            "brightBlue": "#bfdbfe",
            "brightMagenta": "#fbcfe8",
            "brightCyan": "#cffafe",
            "brightWhite": "#ffffff",
        },
    },
    "light": {
        "background": "#ffffff",
        "foreground": "#111827",
        "cursor": "#0a84ff",
        "cursor_accent": "#ffffff",
        "cursor_blink": "#0a84ff",
        "cursor_blink_accent": "#ffffff",
        "selection": "#0a84ff38",  # ~0.22 alpha
        "selection_foreground": "#111827",
        "scrollbar_track": "#f3f4f6",
        "scrollbar_thumb": "#9ca3afcc",
        "scrollbar_thumb_hover": "#6b7280cc",
        "palette": {
            "black": "#111827",
            "red": "#dc2626",
            "green": "#16a34a",
            "yellow": "#b45309",
            "blue": "#2563eb",
            "magenta": "#a21caf",
            "cyan": "#0e7490",
            "white": "#e5e7eb",
            "brightBlack": "#4b5563",
            "brightRed": "#fecaca",
            "brightGreen": "#bbf7d0",
            "brightYellow": "#fef08a",
            "brightBlue": "#bfdbfe",
            "brightMagenta": "#fbcfe8",
            "brightCyan": "#cffafe",
            "brightWhite": "#ffffff",
        },
    },
}


def _terminal_theme_json_path(ui_state_dir: str) -> str:
    return os.path.join(ui_state_dir, TERMINAL_THEME_CONFIG_JSON)


def _terminal_theme_css_path(ui_state_dir: str) -> str:
    return os.path.join(ui_state_dir, TERMINAL_THEME_CONFIG_CSS)


_TERM_BASE_KEYS = ("background", "foreground", "cursor", "cursor_accent", "cursor_blink", "cursor_blink_accent", "selection", "selection_foreground", "scrollbar_track", "scrollbar_thumb", "scrollbar_thumb_hover")
_TERM_PALETTE_KEYS = (
    "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
    "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
)


def _sanitize_terminal_theme_config(cfg_in: Any) -> Dict[str, Any]:
    base = json.loads(json.dumps(_DEFAULT_TERMINAL_THEME_CONFIG))
    src = cfg_in if isinstance(cfg_in, dict) else {}

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

        # base colors
        for k in _TERM_BASE_KEYS:
            try:
                t_def[k] = _sanitize_color(t_in.get(k), t_def.get(k))
            except Exception:
                pass

        # palette
        pal_def = t_def.get("palette") if isinstance(t_def.get("palette"), dict) else {}
        pal_in = t_in.get("palette") if isinstance(t_in.get("palette"), dict) else {}
        for pk in _TERM_PALETTE_KEYS:
            try:
                pal_def[pk] = _sanitize_color(pal_in.get(pk), pal_def.get(pk))
            except Exception:
                pass
        t_def["palette"] = pal_def
        base[mode] = t_def

    return base


def _camel_to_kebab(s: str) -> str:
    out = []
    for ch in str(s or ""):
        if ch.isupper():
            out.append("-" + ch.lower())
        else:
            out.append(ch)
    return "".join(out)


def _terminal_theme_css_from_config(cfg: Dict[str, Any]) -> str:
    lines: List[str] = []
    lines.append(TERMINAL_THEME_CSS_MARKER)
    lines.append("/* Generated by DevTools: Terminal (xterm.js) */")
    lines.append("")

    if not (cfg or {}).get("enabled"):
        lines.append("/* disabled */")
        lines.append("")
        return "\n".join(lines) + "\n"

    for mode in ("dark", "light"):
        t = (cfg or {}).get(mode) if isinstance((cfg or {}).get(mode), dict) else {}
        pal = t.get("palette") if isinstance(t.get("palette"), dict) else {}
        sel = f":root[data-theme=\"{mode}\"]"
        lines.append(f"{sel} {{")
        lines.append("  --xk-term-enabled: 1;")
        lines.append(f"  --xk-term-background: {t.get('background')};")
        lines.append(f"  --xk-term-foreground: {t.get('foreground')};")
        lines.append(f"  --xk-term-cursor: {t.get('cursor')};")
        lines.append(f"  --xk-term-cursor-accent: {t.get('cursor_accent')};")

        lines.append(f"  --xk-term-cursor-blink: {t.get('cursor_blink')};")

        lines.append(f"  --xk-term-cursor-blink-accent: {t.get('cursor_blink_accent')};")
        lines.append(f"  --xk-term-selection: {t.get('selection')};")

        lines.append(f"  --xk-term-selection-foreground: {t.get('selection_foreground')};")

        lines.append(f"  --xk-term-scrollbar-track: {t.get('scrollbar_track')};")

        lines.append(f"  --xk-term-scrollbar-thumb: {t.get('scrollbar_thumb')};")

        lines.append(f"  --xk-term-scrollbar-thumb-hover: {t.get('scrollbar_thumb_hover')};")
        for pk in _TERM_PALETTE_KEYS:
            v = pal.get(pk)
            name = _camel_to_kebab(pk)
            lines.append(f"  --xk-term-{name}: {v};")
        lines.append("}")
        lines.append("")

    # Extra styling for xterm viewport (scrollbar/background); only present when theme is enabled.
    lines.append("/* Extra styling for xterm viewport */")
    lines.append(".terminal-window .xterm, .terminal-window .xterm .xterm-viewport { background-color: var(--xk-term-background) !important; }")
    lines.append(".terminal-window .xterm .xterm-viewport { scrollbar-color: var(--xk-term-scrollbar-thumb) var(--xk-term-scrollbar-track); scrollbar-width: thin; }")
    lines.append(".terminal-window .xterm .xterm-viewport::-webkit-scrollbar { width: 10px; height: 10px; }")
    lines.append(".terminal-window .xterm .xterm-viewport::-webkit-scrollbar-track { background: var(--xk-term-scrollbar-track); }")
    lines.append(".terminal-window .xterm .xterm-viewport::-webkit-scrollbar-thumb { background: var(--xk-term-scrollbar-thumb); border-radius: 10px; border: 2px solid var(--xk-term-scrollbar-track); }")
    lines.append(".terminal-window .xterm .xterm-viewport::-webkit-scrollbar-thumb:hover { background: var(--xk-term-scrollbar-thumb-hover); }")
    lines.append(".terminal-window .xterm .xterm-viewport::-webkit-scrollbar-corner { background: var(--xk-term-scrollbar-track); }")
    lines.append("")

    return "\n".join(lines) + "\n"



def terminal_theme_get(ui_state_dir: str) -> Dict[str, Any]:
    cfg = json.loads(json.dumps(_DEFAULT_TERMINAL_THEME_CONFIG))
    exists = False
    jpath = _terminal_theme_json_path(ui_state_dir)
    cpath = _terminal_theme_css_path(ui_state_dir)

    try:
        if os.path.isfile(jpath):
            with open(jpath, "r", encoding="utf-8", errors="ignore") as f:
                raw = json.load(f)
            cfg = _sanitize_terminal_theme_config(raw)
            exists = True
            try:
                if not os.path.isfile(cpath) or not _file_has_marker(cpath, TERMINAL_THEME_CSS_MARKER):
                    _atomic_write_text(cpath, _terminal_theme_css_from_config(cfg), mode=0o644)
            except Exception:
                pass
        elif os.path.isfile(cpath):
            exists = True
    except Exception:
        cfg = json.loads(json.dumps(_DEFAULT_TERMINAL_THEME_CONFIG))

    version = 0
    try:
        if os.path.isfile(cpath):
            version = int(os.path.getmtime(cpath) or 0)
    except Exception:
        version = 0

    return {"config": cfg, "exists": bool(exists), "version": version, "css_file": cpath, "json_file": jpath}


def terminal_theme_set(ui_state_dir: str, cfg_in: Any) -> Dict[str, Any]:
    cfg = _sanitize_terminal_theme_config(cfg_in)
    jpath = _terminal_theme_json_path(ui_state_dir)
    cpath = _terminal_theme_css_path(ui_state_dir)
    _atomic_write_text(jpath, json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", mode=0o600)
    _atomic_write_text(cpath, _terminal_theme_css_from_config(cfg), mode=0o644)
    version = 0
    try:
        version = int(os.path.getmtime(cpath) or 0)
    except Exception:
        version = 0
    return {"config": cfg, "exists": True, "version": version, "css_file": cpath, "json_file": jpath}


def terminal_theme_reset(ui_state_dir: str) -> Dict[str, Any]:
    for fp in (_terminal_theme_json_path(ui_state_dir), _terminal_theme_css_path(ui_state_dir)):
        try:
            if os.path.exists(fp):
                os.remove(fp)
        except Exception:
            pass
    return terminal_theme_get(ui_state_dir)


