"""Global UI theme editor (DevTools).

Split out from `services.devtools` to keep the facade small and make further
refactoring mechanical.

Important: this module intentionally keeps the same behavior / data formats as
before the split.
"""

from __future__ import annotations

import json
import os
 
from typing import Any, Dict, List

from services.io.atomic import _atomic_write_text

from .common import _file_has_marker, _sanitize_color

THEME_CONFIG_JSON = "custom_theme.json"
THEME_CONFIG_CSS = "custom_theme.css"

# Bump when generated CSS structure changes (used for auto-regeneration).
# NOTE: Bump marker when generator behavior changes so existing on-disk
# custom_theme.css is regenerated automatically.
THEME_CSS_VERSION = 5
THEME_CSS_MARKER = "/* xkeen-ui custom theme v5 */"

# Defaults match the built-in dark/light palettes in static/styles.css.
_DEFAULT_THEME_CONFIG: Dict[str, Any] = {
    # Global typography (applies to both themes)
    "font_scale": 1.00,
    "mono_scale": 1.00,
    "dark": {
        "bg": "#0f172a",
        "card_bg": "#020617",
        "text": "#e5e7eb",
        "muted": "#9ca3af",
        "accent": "#60a5fa",
        "border": "#1f2937",
        # Semantic colors (levels, states)
        "sem_success": "#22c55e",
        "sem_info": "#93c5fd",
        "sem_warning": "#fbbf24",
        "sem_error": "#f87171",
        "sem_debug": "#a1a1aa",
        # Xray logs highlight (token colors)
        "log_ts": "#94a3b8",
        "log_ip": "#fde68a",
        "log_domain": "#6ee7b7",
        "log_proto": "#7dd3fc",
        "log_port": "#fb923c",
        "log_uuid": "#f472b6",
        "log_email": "#22d3ee",
        "log_inbound": "#818cf8",
        "log_outbound": "#f0abfc",
        "log_method": "#fbbf24",
        "log_path": "#bef264",
        "log_sni": "#5eead4",
        "log_alpn": "#93c5fd",
        "log_route_tproxy_vless": "#22c55e",
        "log_route_redirect_vless": "#38bdf8",
        "log_route_redirect_direct": "#a855f7",
        "log_route_reject": "#f97373",
        # Editor/action buttons (Save/Backup/Restore/etc.)
        "editor_btn_bg": "#0f172a94",
        "editor_btn_text": "#eaf2ff",
        "editor_btn_border": "#60a5fa2e",
        "editor_btn_hover_bg": "#142038eb",
        "editor_btn_hover_text": "#f8fbff",
        "editor_btn_hover_border": "#baddff57",
        "editor_btn_active_from": "#1d4ed8",
        "editor_btn_active_to": "#2563eb",
        "header_btn_bg": "#0f172a94",
        "header_btn_text": "#eaf2ff",
        "header_btn_border": "#94c5ff2e",
        "header_btn_hover_bg": "#142038f5",
        "header_btn_hover_text": "#f8fbff",
        "header_btn_hover_border": "#baddff57",
        # Modals
        "modal_overlay": "#010612bd",
        "modal_bg": "#060e1eeb",
        "modal_text": "#f8fbff",
        "modal_muted": "#bfdbfebd",
        # Body area inside modal (optional separate surface)
        "modal_body_bg": "#08132fad",
        "modal_body_border": "#60a5fa1f",
        # Tables inside modals
        "modal_table_head_bg": "#08132fb8",
        "modal_table_head_text": "#bfdbfe",
        "modal_table_border": "#60a5fa1f",
        "modal_table_row_hover_bg": "#3b82f61a",
        # Lists inside modals
        "modal_list_marker": "#7dd3fc",
        "modal_border": "#475569d1",
        "modal_header_border": "#60a5fa1f",
        "modal_close": "#dbeafe",
        "modal_close_hover": "#f8fbff",
        "header_tab_bg": "#0f172a94",
        "header_tab_text": "#dbeafe",
        "header_tab_border": "#60a5fa24",
        "header_tab_active_bg": "#2563eb",
        "header_tab_active_text": "#f8fbff",

        # File manager (FM)
        "fm_panel_bg": "#020617eb",
        "fm_panel_border": "#1f2937",
        "fm_panel_bar_bg": "#020617b8",
        "fm_panel_bar_border": "#1f293799",
        "fm_input_bg": "#020617",
        "fm_input_border": "#1f2937",
        "fm_row_header_bg": "#0206178c",
        "fm_row_header_border": "#1f293799",
        "fm_row_hover_bg": "#020617d9",
        "fm_row_selected_bg": "#2563eb2e",
        "fm_row_focus_outline": "#60a5fa8c",
        "fm_props_bg": "#020617d1",
        "fm_props_border": "#1f2937",
        "fm_menu_bg": "#020617eb",
        "fm_menu_border": "#334155",
        "fm_menu_item_hover_bg": "#60a5fa1f",
        "fm_menu_item_hover_border": "#33415599",
        "fm_menu_sep": "#33415599",
        "fm_btn_bg": "#020617",
        "fm_btn_text": "#e5e7eb",
        "fm_btn_border": "#1f2937",
        "fm_btn_hover_bg": "#020617",
        "fm_btn_hover_text": "#e5e7eb",
        "fm_btn_hover_border": "#4b5563",
        "fm_btn_active_from": "#1d4ed8",
        "fm_btn_active_to": "#2563eb",
        "radius": 12,
        "shadow": 0.40,
        "density": 1.00,
        "contrast": 1.00,
    },
    "light": {
        "bg": "#f5f5f7",
        "card_bg": "#ffffff",
        "text": "#111827",
        "muted": "#4b5563",
        "accent": "#0a84ff",
        "border": "#d1d5db",
        # Semantic colors (levels, states)
        "sem_success": "#16a34a",
        "sem_info": "#2563eb",
        "sem_warning": "#b45309",
        "sem_error": "#dc2626",
        "sem_debug": "#6b7280",
        # Xray logs highlight (token colors)
        "log_ts": "#64748b",
        "log_ip": "#a16207",
        "log_domain": "#047857",
        "log_proto": "#0369a1",
        "log_port": "#c2410c",
        "log_uuid": "#be185d",
        "log_email": "#0e7490",
        "log_inbound": "#4338ca",
        "log_outbound": "#a21caf",
        "log_method": "#92400e",
        "log_path": "#3f6212",
        "log_sni": "#0f766e",
        "log_alpn": "#1d4ed8",
        "log_route_tproxy_vless": "#16a34a",
        "log_route_redirect_vless": "#0284c7",
        "log_route_redirect_direct": "#7c3aed",
        "log_route_reject": "#dc2626",
        # Editor/action buttons (Save/Backup/Restore/etc.)
        "editor_btn_bg": "#f8fbffeb",
        "editor_btn_text": "#162033",
        "editor_btn_border": "#60a5fa29",
        "editor_btn_hover_bg": "#ffffff",
        "editor_btn_hover_text": "#162033",
        "editor_btn_hover_border": "#3f6fcb38",
        "editor_btn_active_from": "#1d4ed8",
        "editor_btn_active_to": "#3f6fcb",
        "header_btn_bg": "#f8fbffeb",
        "header_btn_text": "#162033",
        "header_btn_border": "#60a5fa29",
        "header_btn_hover_bg": "#ffffff",
        "header_btn_hover_text": "#162033",
        "header_btn_hover_border": "#3f6fcb38",
        # Modals
        "modal_overlay": "#0f172a5c",
        "modal_bg": "#fffffff5",
        "modal_text": "#162033",
        "modal_muted": "#3b4b67d1",
        # Body area inside modal (optional separate surface)
        "modal_body_bg": "#f3f8ffeb",
        "modal_body_border": "#3f6fcb1f",
        # Tables inside modals
        "modal_table_head_bg": "#f3f8fff2",
        "modal_table_head_text": "#607394",
        "modal_table_border": "#3f6fcb1f",
        "modal_table_row_hover_bg": "#60a5fa14",
        # Lists inside modals
        "modal_list_marker": "#2563eb",
        "modal_border": "#3f6fcb1f",
        "modal_header_border": "#3f6fcb1f",
        "modal_close": "#23407d",
        "modal_close_hover": "#162033",
        "header_tab_bg": "#f5f9ffd1",
        "header_tab_text": "#162033c2",
        "header_tab_border": "#3f6fcb1a",
        "header_tab_active_bg": "#3f6fcb",
        "header_tab_active_text": "#ffffff",

        # File manager (FM)
        "fm_panel_bg": "#ffffffeb",
        "fm_panel_border": "#d1d5db",
        "fm_panel_bar_bg": "#ffffffb8",
        "fm_panel_bar_border": "#d1d5db99",
        "fm_input_bg": "#ffffff",
        "fm_input_border": "#d1d5db",
        "fm_row_header_bg": "#ffffff8c",
        "fm_row_header_border": "#d1d5db99",
        "fm_row_hover_bg": "#ffffffd9",
        "fm_row_selected_bg": "#0a84ff2e",
        "fm_row_focus_outline": "#0a84ff8c",
        "fm_props_bg": "#ffffffd1",
        "fm_props_border": "#d1d5db",
        "fm_menu_bg": "#ffffffeb",
        "fm_menu_border": "#d1d5db",
        "fm_menu_item_hover_bg": "#0a84ff1f",
        "fm_menu_item_hover_border": "#d1d5db99",
        "fm_menu_sep": "#d1d5db99",
        "fm_btn_bg": "#ffffff",
        "fm_btn_text": "#111827",
        "fm_btn_border": "#d1d5db",
        "fm_btn_hover_bg": "#ffffff",
        "fm_btn_hover_text": "#111827",
        "fm_btn_hover_border": "#4b5563",
        "fm_btn_active_from": "#1d4ed8",
        "fm_btn_active_to": "#2563eb",
        "radius": 12,
        "shadow": 0.08,
        "density": 1.00,
        "contrast": 1.00,
    },
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _theme_json_path(ui_state_dir: str) -> str:
    return os.path.join(ui_state_dir, THEME_CONFIG_JSON)


def _theme_css_path(ui_state_dir: str) -> str:
    return os.path.join(ui_state_dir, THEME_CONFIG_CSS)


def _clamp_float(v: Any, lo: float, hi: float, fallback: float) -> float:
    try:
        x = float(v)
    except Exception:
        return fallback
    if x < lo:
        return lo
    if x > hi:
        return hi
    return x


def _clamp_int(v: Any, lo: int, hi: int, fallback: int) -> int:
    try:
        x = int(float(v))
    except Exception:
        return fallback
    if x < lo:
        return lo
    if x > hi:
        return hi
    return x


def _sanitize_theme_config(cfg_in: Any) -> Dict[str, Any]:
    """Sanitize incoming config.

    NOTE: Keep it very conservative – allow only hex colors + numeric knobs.
    """
    cfg: Dict[str, Any] = json.loads(json.dumps(_DEFAULT_THEME_CONFIG))

    if not isinstance(cfg_in, dict):
        return cfg

    # Global typography (0.85..1.50)
    if isinstance(cfg_in.get("font_scale"), (int, float, str)):
        cfg["font_scale"] = round(_clamp_float(cfg_in.get("font_scale"), 0.85, 1.50, float(cfg.get("font_scale") or 1.0)), 3)
    if isinstance(cfg_in.get("mono_scale"), (int, float, str)):
        cfg["mono_scale"] = round(_clamp_float(cfg_in.get("mono_scale"), 0.85, 1.50, float(cfg.get("mono_scale") or 1.0)), 3)

    for theme in ("dark", "light"):
        src = cfg_in.get(theme)
        if not isinstance(src, dict):
            continue
        dst = cfg.get(theme, {})

        dst["bg"] = _sanitize_color(src.get("bg"), dst["bg"])
        dst["card_bg"] = _sanitize_color(src.get("card_bg"), dst["card_bg"])
        dst["text"] = _sanitize_color(src.get("text"), dst["text"])
        dst["muted"] = _sanitize_color(src.get("muted"), dst["muted"])
        dst["accent"] = _sanitize_color(src.get("accent"), dst["accent"])
        dst["border"] = _sanitize_color(src.get("border"), dst["border"])
        dst["sem_success"] = _sanitize_color(src.get("sem_success"), dst["sem_success"])
        dst["sem_info"] = _sanitize_color(src.get("sem_info"), dst["sem_info"])
        dst["sem_warning"] = _sanitize_color(src.get("sem_warning"), dst["sem_warning"])
        dst["sem_error"] = _sanitize_color(src.get("sem_error"), dst["sem_error"])
        dst["sem_debug"] = _sanitize_color(src.get("sem_debug"), dst["sem_debug"])
        # Xray logs highlight (token colors)
        dst["log_ts"] = _sanitize_color(src.get("log_ts"), dst["log_ts"])
        dst["log_ip"] = _sanitize_color(src.get("log_ip"), dst["log_ip"])
        dst["log_domain"] = _sanitize_color(src.get("log_domain"), dst["log_domain"])
        dst["log_proto"] = _sanitize_color(src.get("log_proto"), dst["log_proto"])
        dst["log_port"] = _sanitize_color(src.get("log_port"), dst["log_port"])
        dst["log_uuid"] = _sanitize_color(src.get("log_uuid"), dst["log_uuid"])
        dst["log_email"] = _sanitize_color(src.get("log_email"), dst["log_email"])
        dst["log_inbound"] = _sanitize_color(src.get("log_inbound"), dst["log_inbound"])
        dst["log_outbound"] = _sanitize_color(src.get("log_outbound"), dst["log_outbound"])
        dst["log_method"] = _sanitize_color(src.get("log_method"), dst["log_method"])
        dst["log_path"] = _sanitize_color(src.get("log_path"), dst["log_path"])
        dst["log_sni"] = _sanitize_color(src.get("log_sni"), dst["log_sni"])
        dst["log_alpn"] = _sanitize_color(src.get("log_alpn"), dst["log_alpn"])
        dst["log_route_tproxy_vless"] = _sanitize_color(src.get("log_route_tproxy_vless"), dst["log_route_tproxy_vless"])
        dst["log_route_redirect_vless"] = _sanitize_color(src.get("log_route_redirect_vless"), dst["log_route_redirect_vless"])
        dst["log_route_redirect_direct"] = _sanitize_color(src.get("log_route_redirect_direct"), dst["log_route_redirect_direct"])
        dst["log_route_reject"] = _sanitize_color(src.get("log_route_reject"), dst["log_route_reject"])
        dst["editor_btn_bg"] = _sanitize_color(src.get("editor_btn_bg"), dst["editor_btn_bg"])
        dst["editor_btn_text"] = _sanitize_color(src.get("editor_btn_text"), dst["editor_btn_text"])
        dst["editor_btn_border"] = _sanitize_color(src.get("editor_btn_border"), dst["editor_btn_border"])
        dst["editor_btn_hover_bg"] = _sanitize_color(src.get("editor_btn_hover_bg"), dst["editor_btn_hover_bg"])
        dst["editor_btn_hover_text"] = _sanitize_color(src.get("editor_btn_hover_text"), dst["editor_btn_hover_text"])
        dst["editor_btn_hover_border"] = _sanitize_color(src.get("editor_btn_hover_border"), dst["editor_btn_hover_border"])
        dst["editor_btn_active_from"] = _sanitize_color(src.get("editor_btn_active_from"), dst["editor_btn_active_from"])
        dst["editor_btn_active_to"] = _sanitize_color(src.get("editor_btn_active_to"), dst["editor_btn_active_to"])
        dst["header_btn_bg"] = _sanitize_color(src.get("header_btn_bg"), dst["header_btn_bg"])
        dst["header_btn_text"] = _sanitize_color(src.get("header_btn_text"), dst["header_btn_text"])
        dst["header_btn_border"] = _sanitize_color(src.get("header_btn_border"), dst["header_btn_border"])
        dst["header_btn_hover_bg"] = _sanitize_color(src.get("header_btn_hover_bg"), dst["header_btn_hover_bg"])
        dst["header_btn_hover_text"] = _sanitize_color(src.get("header_btn_hover_text"), dst["header_btn_hover_text"])
        dst["header_btn_hover_border"] = _sanitize_color(src.get("header_btn_hover_border"), dst["header_btn_hover_border"])
        dst["modal_overlay"] = _sanitize_color(src.get("modal_overlay"), dst["modal_overlay"])
        dst["modal_bg"] = _sanitize_color(src.get("modal_bg"), dst["modal_bg"])
        dst["modal_text"] = _sanitize_color(src.get("modal_text"), dst["modal_text"])
        dst["modal_muted"] = _sanitize_color(src.get("modal_muted"), dst["modal_muted"])
        dst["modal_body_bg"] = _sanitize_color(src.get("modal_body_bg"), dst["modal_body_bg"])
        dst["modal_body_border"] = _sanitize_color(src.get("modal_body_border"), dst["modal_body_border"])
        dst["modal_table_head_bg"] = _sanitize_color(src.get("modal_table_head_bg"), dst["modal_table_head_bg"])
        dst["modal_table_head_text"] = _sanitize_color(src.get("modal_table_head_text"), dst["modal_table_head_text"])
        dst["modal_table_border"] = _sanitize_color(src.get("modal_table_border"), dst["modal_table_border"])
        dst["modal_table_row_hover_bg"] = _sanitize_color(src.get("modal_table_row_hover_bg"), dst["modal_table_row_hover_bg"])
        dst["modal_list_marker"] = _sanitize_color(src.get("modal_list_marker"), dst["modal_list_marker"])
        dst["modal_border"] = _sanitize_color(src.get("modal_border"), dst["modal_border"])
        dst["modal_header_border"] = _sanitize_color(src.get("modal_header_border"), dst["modal_header_border"])
        dst["modal_close"] = _sanitize_color(src.get("modal_close"), dst["modal_close"])
        dst["modal_close_hover"] = _sanitize_color(src.get("modal_close_hover"), dst["modal_close_hover"])
        dst["header_tab_bg"] = _sanitize_color(src.get("header_tab_bg"), dst["header_tab_bg"])
        dst["header_tab_text"] = _sanitize_color(src.get("header_tab_text"), dst["header_tab_text"])
        dst["header_tab_border"] = _sanitize_color(src.get("header_tab_border"), dst["header_tab_border"])
        dst["header_tab_active_bg"] = _sanitize_color(src.get("header_tab_active_bg"), dst["header_tab_active_bg"])
        dst["header_tab_active_text"] = _sanitize_color(src.get("header_tab_active_text"), dst["header_tab_active_text"])

        dst["fm_panel_bg"] = _sanitize_color(src.get("fm_panel_bg"), dst["fm_panel_bg"])
        dst["fm_panel_border"] = _sanitize_color(src.get("fm_panel_border"), dst["fm_panel_border"])
        dst["fm_panel_bar_bg"] = _sanitize_color(src.get("fm_panel_bar_bg"), dst["fm_panel_bar_bg"])
        dst["fm_panel_bar_border"] = _sanitize_color(src.get("fm_panel_bar_border"), dst["fm_panel_bar_border"])
        dst["fm_input_bg"] = _sanitize_color(src.get("fm_input_bg"), dst["fm_input_bg"])
        dst["fm_input_border"] = _sanitize_color(src.get("fm_input_border"), dst["fm_input_border"])
        dst["fm_row_header_bg"] = _sanitize_color(src.get("fm_row_header_bg"), dst["fm_row_header_bg"])
        dst["fm_row_header_border"] = _sanitize_color(src.get("fm_row_header_border"), dst["fm_row_header_border"])
        dst["fm_row_hover_bg"] = _sanitize_color(src.get("fm_row_hover_bg"), dst["fm_row_hover_bg"])
        dst["fm_row_selected_bg"] = _sanitize_color(src.get("fm_row_selected_bg"), dst["fm_row_selected_bg"])
        dst["fm_row_focus_outline"] = _sanitize_color(src.get("fm_row_focus_outline"), dst["fm_row_focus_outline"])
        dst["fm_props_bg"] = _sanitize_color(src.get("fm_props_bg"), dst["fm_props_bg"])
        dst["fm_props_border"] = _sanitize_color(src.get("fm_props_border"), dst["fm_props_border"])
        dst["fm_menu_bg"] = _sanitize_color(src.get("fm_menu_bg"), dst["fm_menu_bg"])
        dst["fm_menu_border"] = _sanitize_color(src.get("fm_menu_border"), dst["fm_menu_border"])
        dst["fm_menu_item_hover_bg"] = _sanitize_color(src.get("fm_menu_item_hover_bg"), dst["fm_menu_item_hover_bg"])
        dst["fm_menu_item_hover_border"] = _sanitize_color(src.get("fm_menu_item_hover_border"), dst["fm_menu_item_hover_border"])
        dst["fm_menu_sep"] = _sanitize_color(src.get("fm_menu_sep"), dst["fm_menu_sep"])
        dst["fm_btn_bg"] = _sanitize_color(src.get("fm_btn_bg"), dst["fm_btn_bg"])
        dst["fm_btn_text"] = _sanitize_color(src.get("fm_btn_text"), dst["fm_btn_text"])
        dst["fm_btn_border"] = _sanitize_color(src.get("fm_btn_border"), dst["fm_btn_border"])
        dst["fm_btn_hover_bg"] = _sanitize_color(src.get("fm_btn_hover_bg"), dst["fm_btn_hover_bg"])
        dst["fm_btn_hover_text"] = _sanitize_color(src.get("fm_btn_hover_text"), dst["fm_btn_hover_text"])
        dst["fm_btn_hover_border"] = _sanitize_color(src.get("fm_btn_hover_border"), dst["fm_btn_hover_border"])
        dst["fm_btn_active_from"] = _sanitize_color(src.get("fm_btn_active_from"), dst["fm_btn_active_from"])
        dst["fm_btn_active_to"] = _sanitize_color(src.get("fm_btn_active_to"), dst["fm_btn_active_to"])

        dst["radius"] = _clamp_int(src.get("radius"), 0, 32, int(dst["radius"]))
        # shadow is alpha (0..0.7)
        dst["shadow"] = round(_clamp_float(src.get("shadow"), 0.0, 0.7, float(dst["shadow"])), 3)
        # density: compact/spacious (0.75..1.35)
        dst["density"] = round(_clamp_float(src.get("density"), 0.75, 1.35, float(dst["density"])), 3)
        # contrast: (0.85..1.25)
        dst["contrast"] = round(_clamp_float(src.get("contrast"), 0.85, 1.25, float(dst["contrast"])), 3)

        cfg[theme] = dst

    return cfg


def _theme_css_from_config(cfg: Dict[str, Any]) -> str:
    """Generate safe CSS overrides.

    The file is loaded on every page after styles.css.
    """

    def _radius_sm(r: int) -> int:
        try:
            return max(4, min(24, int(round(r * 0.75))))
        except Exception:
            return 8

    dark = cfg.get("dark") or {}
    light = cfg.get("light") or {}

    # Global typography
    font_scale = float(cfg.get("font_scale") or 1.0)
    mono_scale = float(cfg.get("mono_scale") or 1.0)

    dark_rs = _radius_sm(int(dark.get("radius") or 12))
    light_rs = _radius_sm(int(light.get("radius") or 12))

    css: List[str] = []
    css.append(THEME_CSS_MARKER)
    css.append("/* Generated by Xkeen UI DevTools — Theme editor */")
    css.append("/* Safe override layer: only CSS variables + a few core selectors. */")
    css.append("")

    # Fallback (no data-theme attribute -> behave like dark)
    css.append(":root {")
    css.append(f"  --xk-font-scale: {font_scale};")
    css.append(f"  --xk-mono-font-scale: {mono_scale};")
    css.append(f"  --bg: {dark.get('bg')};")
    css.append(f"  --card-bg: {dark.get('card_bg')};")
    css.append(f"  --text: {dark.get('text')};")
    css.append(f"  --muted: {dark.get('muted')};")
    css.append(f"  --accent: {dark.get('accent')};")
    css.append(f"  --border: {dark.get('border')};")
    css.append(f"  --sem-success: {dark.get('sem_success')};")
    css.append(f"  --sem-info: {dark.get('sem_info')};")
    css.append(f"  --sem-warning: {dark.get('sem_warning')};")
    css.append(f"  --sem-error: {dark.get('sem_error')};")
    css.append(f"  --sem-debug: {dark.get('sem_debug')};")
    css.append(f"  --log-ts: {dark.get('log_ts')};")
    css.append(f"  --log-ip: {dark.get('log_ip')};")
    css.append(f"  --log-domain: {dark.get('log_domain')};")
    css.append(f"  --log-proto: {dark.get('log_proto')};")
    css.append(f"  --log-port: {dark.get('log_port')};")
    css.append(f"  --log-uuid: {dark.get('log_uuid')};")
    css.append(f"  --log-email: {dark.get('log_email')};")
    css.append(f"  --log-inbound: {dark.get('log_inbound')};")
    css.append(f"  --log-outbound: {dark.get('log_outbound')};")
    css.append(f"  --log-method: {dark.get('log_method')};")
    css.append(f"  --log-path: {dark.get('log_path')};")
    css.append(f"  --log-sni: {dark.get('log_sni')};")
    css.append(f"  --log-alpn: {dark.get('log_alpn')};")
    css.append(f"  --log-route-tproxy-vless: {dark.get('log_route_tproxy_vless')};")
    css.append(f"  --log-route-redirect-vless: {dark.get('log_route_redirect_vless')};")
    css.append(f"  --log-route-redirect-direct: {dark.get('log_route_redirect_direct')};")
    css.append(f"  --log-route-reject: {dark.get('log_route_reject')};")
    css.append(f"  --editor-btn-bg: {dark.get('editor_btn_bg')};")
    css.append(f"  --editor-btn-text: {dark.get('editor_btn_text')};")
    css.append(f"  --editor-btn-border: {dark.get('editor_btn_border')};")
    css.append(f"  --editor-btn-hover-bg: {dark.get('editor_btn_hover_bg')};")
    css.append(f"  --editor-btn-hover-text: {dark.get('editor_btn_hover_text')};")
    css.append(f"  --editor-btn-hover-border: {dark.get('editor_btn_hover_border')};")
    # Back-compat alias used by core button styles (styles.css)
    css.append(f"  --editor-btn-border-hover: {dark.get('editor_btn_hover_border')};")
    css.append(f"  --editor-btn-active-from: {dark.get('editor_btn_active_from')};")
    css.append(f"  --editor-btn-active-to: {dark.get('editor_btn_active_to')};")
    css.append(f"  --header-btn-bg: {dark.get('header_btn_bg')};")
    css.append(f"  --header-btn-text: {dark.get('header_btn_text')};")
    css.append(f"  --header-btn-border: {dark.get('header_btn_border')};")
    css.append(f"  --header-btn-hover-bg: {dark.get('header_btn_hover_bg')};")
    css.append(f"  --header-btn-hover-text: {dark.get('header_btn_hover_text')};")
    css.append(f"  --header-btn-hover-border: {dark.get('header_btn_hover_border')};")
    css.append(f"  --modal-overlay: {dark.get('modal_overlay')};")
    css.append(f"  --modal-bg: {dark.get('modal_bg')};")
    css.append(f"  --modal-text: {dark.get('modal_text')};")
    css.append(f"  --modal-muted: {dark.get('modal_muted')};")
    css.append(f"  --modal-body-bg: {dark.get('modal_body_bg')};")
    css.append(f"  --modal-body-border: {dark.get('modal_body_border')};")
    css.append(f"  --modal-table-head-bg: {dark.get('modal_table_head_bg')};")
    css.append(f"  --modal-table-head-text: {dark.get('modal_table_head_text')};")
    css.append(f"  --modal-table-border: {dark.get('modal_table_border')};")
    css.append(f"  --modal-table-row-hover-bg: {dark.get('modal_table_row_hover_bg')};")
    css.append(f"  --modal-list-marker: {dark.get('modal_list_marker')};")
    css.append(f"  --modal-border: {dark.get('modal_border')};")
    css.append(f"  --modal-header-border: {dark.get('modal_header_border')};")
    css.append(f"  --modal-close: {dark.get('modal_close')};")
    css.append(f"  --modal-close-hover: {dark.get('modal_close_hover')};")
    css.append(f"  --header-tab-bg: {dark.get('header_tab_bg')};")
    css.append(f"  --header-tab-text: {dark.get('header_tab_text')};")
    css.append(f"  --header-tab-border: {dark.get('header_tab_border')};")
    css.append(f"  --header-tab-active-bg: {dark.get('header_tab_active_bg')};")
    css.append(f"  --header-tab-active-text: {dark.get('header_tab_active_text')};")
    css.append(f"  --fm-panel-bg: {dark.get('fm_panel_bg')};")
    css.append(f"  --fm-panel-border: {dark.get('fm_panel_border')};")
    css.append(f"  --fm-panel-bar-bg: {dark.get('fm_panel_bar_bg')};")
    css.append(f"  --fm-panel-bar-border: {dark.get('fm_panel_bar_border')};")
    css.append(f"  --fm-input-bg: {dark.get('fm_input_bg')};")
    css.append(f"  --fm-input-border: {dark.get('fm_input_border')};")
    css.append(f"  --fm-row-header-bg: {dark.get('fm_row_header_bg')};")
    css.append(f"  --fm-row-header-border: {dark.get('fm_row_header_border')};")
    css.append(f"  --fm-row-hover-bg: {dark.get('fm_row_hover_bg')};")
    css.append(f"  --fm-row-selected-bg: {dark.get('fm_row_selected_bg')};")
    css.append(f"  --fm-row-focus-outline: {dark.get('fm_row_focus_outline')};")
    css.append(f"  --fm-props-bg: {dark.get('fm_props_bg')};")
    css.append(f"  --fm-props-border: {dark.get('fm_props_border')};")
    css.append(f"  --fm-menu-bg: {dark.get('fm_menu_bg')};")
    css.append(f"  --fm-menu-border: {dark.get('fm_menu_border')};")
    css.append(f"  --fm-menu-item-hover-bg: {dark.get('fm_menu_item_hover_bg')};")
    css.append(f"  --fm-menu-item-hover-border: {dark.get('fm_menu_item_hover_border')};")
    css.append(f"  --fm-menu-sep: {dark.get('fm_menu_sep')};")
    css.append(f"  --fm-btn-bg: {dark.get('fm_btn_bg')};")
    css.append(f"  --fm-btn-text: {dark.get('fm_btn_text')};")
    css.append(f"  --fm-btn-border: {dark.get('fm_btn_border')};")
    css.append(f"  --fm-btn-hover-bg: {dark.get('fm_btn_hover_bg')};")
    css.append(f"  --fm-btn-hover-text: {dark.get('fm_btn_hover_text')};")
    css.append(f"  --fm-btn-hover-border: {dark.get('fm_btn_hover_border')};")
    css.append(f"  --fm-btn-active-from: {dark.get('fm_btn_active_from')};")
    css.append(f"  --fm-btn-active-to: {dark.get('fm_btn_active_to')};")
    css.append(f"  --radius: {int(dark.get('radius') or 12)}px;")
    css.append(f"  --radius-sm: {dark_rs}px;")
    css.append(f"  --shadow: {float(dark.get('shadow') or 0.4)};")
    css.append("  --shadow-rgb: 0, 0, 0;")
    css.append(f"  --density: {float(dark.get('density') or 1.0)};")
    css.append(f"  --contrast: {float(dark.get('contrast') or 1.0)};")
    css.append("}")
    css.append("")

    css.append('html[data-theme="dark"] {')
    css.append(f"  --bg: {dark.get('bg')};")
    css.append(f"  --card-bg: {dark.get('card_bg')};")
    css.append(f"  --text: {dark.get('text')};")
    css.append(f"  --muted: {dark.get('muted')};")
    css.append(f"  --accent: {dark.get('accent')};")
    css.append(f"  --border: {dark.get('border')};")
    css.append(f"  --sem-success: {dark.get('sem_success')};")
    css.append(f"  --sem-info: {dark.get('sem_info')};")
    css.append(f"  --sem-warning: {dark.get('sem_warning')};")
    css.append(f"  --sem-error: {dark.get('sem_error')};")
    css.append(f"  --sem-debug: {dark.get('sem_debug')};")
    css.append(f"  --log-ts: {dark.get('log_ts')};")
    css.append(f"  --log-ip: {dark.get('log_ip')};")
    css.append(f"  --log-domain: {dark.get('log_domain')};")
    css.append(f"  --log-proto: {dark.get('log_proto')};")
    css.append(f"  --log-port: {dark.get('log_port')};")
    css.append(f"  --log-uuid: {dark.get('log_uuid')};")
    css.append(f"  --log-email: {dark.get('log_email')};")
    css.append(f"  --log-inbound: {dark.get('log_inbound')};")
    css.append(f"  --log-outbound: {dark.get('log_outbound')};")
    css.append(f"  --log-method: {dark.get('log_method')};")
    css.append(f"  --log-path: {dark.get('log_path')};")
    css.append(f"  --log-sni: {dark.get('log_sni')};")
    css.append(f"  --log-alpn: {dark.get('log_alpn')};")
    css.append(f"  --log-route-tproxy-vless: {dark.get('log_route_tproxy_vless')};")
    css.append(f"  --log-route-redirect-vless: {dark.get('log_route_redirect_vless')};")
    css.append(f"  --log-route-redirect-direct: {dark.get('log_route_redirect_direct')};")
    css.append(f"  --log-route-reject: {dark.get('log_route_reject')};")
    css.append(f"  --editor-btn-bg: {dark.get('editor_btn_bg')};")
    css.append(f"  --editor-btn-text: {dark.get('editor_btn_text')};")
    css.append(f"  --editor-btn-border: {dark.get('editor_btn_border')};")
    css.append(f"  --editor-btn-hover-bg: {dark.get('editor_btn_hover_bg')};")
    css.append(f"  --editor-btn-hover-text: {dark.get('editor_btn_hover_text')};")
    css.append(f"  --editor-btn-hover-border: {dark.get('editor_btn_hover_border')};")
    css.append(f"  --editor-btn-border-hover: {dark.get('editor_btn_hover_border')};")
    css.append(f"  --editor-btn-active-from: {dark.get('editor_btn_active_from')};")
    css.append(f"  --editor-btn-active-to: {dark.get('editor_btn_active_to')};")
    css.append(f"  --header-btn-bg: {dark.get('header_btn_bg')};")
    css.append(f"  --header-btn-text: {dark.get('header_btn_text')};")
    css.append(f"  --header-btn-border: {dark.get('header_btn_border')};")
    css.append(f"  --header-btn-hover-bg: {dark.get('header_btn_hover_bg')};")
    css.append(f"  --header-btn-hover-text: {dark.get('header_btn_hover_text')};")
    css.append(f"  --header-btn-hover-border: {dark.get('header_btn_hover_border')};")
    css.append(f"  --modal-overlay: {dark.get('modal_overlay')};")
    css.append(f"  --modal-bg: {dark.get('modal_bg')};")
    css.append(f"  --modal-text: {dark.get('modal_text')};")
    css.append(f"  --modal-muted: {dark.get('modal_muted')};")
    css.append(f"  --modal-body-bg: {dark.get('modal_body_bg')};")
    css.append(f"  --modal-body-border: {dark.get('modal_body_border')};")
    css.append(f"  --modal-table-head-bg: {dark.get('modal_table_head_bg')};")
    css.append(f"  --modal-table-head-text: {dark.get('modal_table_head_text')};")
    css.append(f"  --modal-table-border: {dark.get('modal_table_border')};")
    css.append(f"  --modal-table-row-hover-bg: {dark.get('modal_table_row_hover_bg')};")
    css.append(f"  --modal-list-marker: {dark.get('modal_list_marker')};")
    css.append(f"  --modal-border: {dark.get('modal_border')};")
    css.append(f"  --modal-header-border: {dark.get('modal_header_border')};")
    css.append(f"  --modal-close: {dark.get('modal_close')};")
    css.append(f"  --modal-close-hover: {dark.get('modal_close_hover')};")
    css.append(f"  --header-tab-bg: {dark.get('header_tab_bg')};")
    css.append(f"  --header-tab-text: {dark.get('header_tab_text')};")
    css.append(f"  --header-tab-border: {dark.get('header_tab_border')};")
    css.append(f"  --header-tab-active-bg: {dark.get('header_tab_active_bg')};")
    css.append(f"  --header-tab-active-text: {dark.get('header_tab_active_text')};")
    css.append(f"  --fm-panel-bg: {dark.get('fm_panel_bg')};")
    css.append(f"  --fm-panel-border: {dark.get('fm_panel_border')};")
    css.append(f"  --fm-panel-bar-bg: {dark.get('fm_panel_bar_bg')};")
    css.append(f"  --fm-panel-bar-border: {dark.get('fm_panel_bar_border')};")
    css.append(f"  --fm-input-bg: {dark.get('fm_input_bg')};")
    css.append(f"  --fm-input-border: {dark.get('fm_input_border')};")
    css.append(f"  --fm-row-header-bg: {dark.get('fm_row_header_bg')};")
    css.append(f"  --fm-row-header-border: {dark.get('fm_row_header_border')};")
    css.append(f"  --fm-row-hover-bg: {dark.get('fm_row_hover_bg')};")
    css.append(f"  --fm-row-selected-bg: {dark.get('fm_row_selected_bg')};")
    css.append(f"  --fm-row-focus-outline: {dark.get('fm_row_focus_outline')};")
    css.append(f"  --fm-props-bg: {dark.get('fm_props_bg')};")
    css.append(f"  --fm-props-border: {dark.get('fm_props_border')};")
    css.append(f"  --fm-menu-bg: {dark.get('fm_menu_bg')};")
    css.append(f"  --fm-menu-border: {dark.get('fm_menu_border')};")
    css.append(f"  --fm-menu-item-hover-bg: {dark.get('fm_menu_item_hover_bg')};")
    css.append(f"  --fm-menu-item-hover-border: {dark.get('fm_menu_item_hover_border')};")
    css.append(f"  --fm-menu-sep: {dark.get('fm_menu_sep')};")
    css.append(f"  --fm-btn-bg: {dark.get('fm_btn_bg')};")
    css.append(f"  --fm-btn-text: {dark.get('fm_btn_text')};")
    css.append(f"  --fm-btn-border: {dark.get('fm_btn_border')};")
    css.append(f"  --fm-btn-hover-bg: {dark.get('fm_btn_hover_bg')};")
    css.append(f"  --fm-btn-hover-text: {dark.get('fm_btn_hover_text')};")
    css.append(f"  --fm-btn-hover-border: {dark.get('fm_btn_hover_border')};")
    css.append(f"  --fm-btn-active-from: {dark.get('fm_btn_active_from')};")
    css.append(f"  --fm-btn-active-to: {dark.get('fm_btn_active_to')};")
    css.append(f"  --radius: {int(dark.get('radius') or 12)}px;")
    css.append(f"  --radius-sm: {dark_rs}px;")
    css.append(f"  --shadow: {float(dark.get('shadow') or 0.4)};")
    css.append("  --shadow-rgb: 0, 0, 0;")
    css.append(f"  --density: {float(dark.get('density') or 1.0)};")
    css.append(f"  --contrast: {float(dark.get('contrast') or 1.0)};")
    css.append("}")
    css.append("")

    css.append('html[data-theme="light"] {')
    css.append(f"  --bg: {light.get('bg')};")
    css.append(f"  --card-bg: {light.get('card_bg')};")
    css.append(f"  --text: {light.get('text')};")
    css.append(f"  --muted: {light.get('muted')};")
    css.append(f"  --accent: {light.get('accent')};")
    css.append(f"  --border: {light.get('border')};")
    css.append(f"  --sem-success: {light.get('sem_success')};")
    css.append(f"  --sem-info: {light.get('sem_info')};")
    css.append(f"  --sem-warning: {light.get('sem_warning')};")
    css.append(f"  --sem-error: {light.get('sem_error')};")
    css.append(f"  --sem-debug: {light.get('sem_debug')};")
    css.append(f"  --log-ts: {light.get('log_ts')};")
    css.append(f"  --log-ip: {light.get('log_ip')};")
    css.append(f"  --log-domain: {light.get('log_domain')};")
    css.append(f"  --log-proto: {light.get('log_proto')};")
    css.append(f"  --log-port: {light.get('log_port')};")
    css.append(f"  --log-uuid: {light.get('log_uuid')};")
    css.append(f"  --log-email: {light.get('log_email')};")
    css.append(f"  --log-inbound: {light.get('log_inbound')};")
    css.append(f"  --log-outbound: {light.get('log_outbound')};")
    css.append(f"  --log-method: {light.get('log_method')};")
    css.append(f"  --log-path: {light.get('log_path')};")
    css.append(f"  --log-sni: {light.get('log_sni')};")
    css.append(f"  --log-alpn: {light.get('log_alpn')};")
    css.append(f"  --log-route-tproxy-vless: {light.get('log_route_tproxy_vless')};")
    css.append(f"  --log-route-redirect-vless: {light.get('log_route_redirect_vless')};")
    css.append(f"  --log-route-redirect-direct: {light.get('log_route_redirect_direct')};")
    css.append(f"  --log-route-reject: {light.get('log_route_reject')};")
    css.append(f"  --editor-btn-bg: {light.get('editor_btn_bg')};")
    css.append(f"  --editor-btn-text: {light.get('editor_btn_text')};")
    css.append(f"  --editor-btn-border: {light.get('editor_btn_border')};")
    css.append(f"  --editor-btn-hover-bg: {light.get('editor_btn_hover_bg')};")
    css.append(f"  --editor-btn-hover-text: {light.get('editor_btn_hover_text')};")
    css.append(f"  --editor-btn-hover-border: {light.get('editor_btn_hover_border')};")
    css.append(f"  --editor-btn-border-hover: {light.get('editor_btn_hover_border')};")
    css.append(f"  --editor-btn-active-from: {light.get('editor_btn_active_from')};")
    css.append(f"  --editor-btn-active-to: {light.get('editor_btn_active_to')};")
    css.append(f"  --header-btn-bg: {light.get('header_btn_bg')};")
    css.append(f"  --header-btn-text: {light.get('header_btn_text')};")
    css.append(f"  --header-btn-border: {light.get('header_btn_border')};")
    css.append(f"  --header-btn-hover-bg: {light.get('header_btn_hover_bg')};")
    css.append(f"  --header-btn-hover-text: {light.get('header_btn_hover_text')};")
    css.append(f"  --header-btn-hover-border: {light.get('header_btn_hover_border')};")
    css.append(f"  --modal-overlay: {light.get('modal_overlay')};")
    css.append(f"  --modal-bg: {light.get('modal_bg')};")
    css.append(f"  --modal-text: {light.get('modal_text')};")
    css.append(f"  --modal-muted: {light.get('modal_muted')};")
    css.append(f"  --modal-body-bg: {light.get('modal_body_bg')};")
    css.append(f"  --modal-body-border: {light.get('modal_body_border')};")
    css.append(f"  --modal-table-head-bg: {light.get('modal_table_head_bg')};")
    css.append(f"  --modal-table-head-text: {light.get('modal_table_head_text')};")
    css.append(f"  --modal-table-border: {light.get('modal_table_border')};")
    css.append(f"  --modal-table-row-hover-bg: {light.get('modal_table_row_hover_bg')};")
    css.append(f"  --modal-list-marker: {light.get('modal_list_marker')};")
    css.append(f"  --modal-border: {light.get('modal_border')};")
    css.append(f"  --modal-header-border: {light.get('modal_header_border')};")
    css.append(f"  --modal-close: {light.get('modal_close')};")
    css.append(f"  --modal-close-hover: {light.get('modal_close_hover')};")
    css.append(f"  --header-tab-bg: {light.get('header_tab_bg')};")
    css.append(f"  --header-tab-text: {light.get('header_tab_text')};")
    css.append(f"  --header-tab-border: {light.get('header_tab_border')};")
    css.append(f"  --header-tab-active-bg: {light.get('header_tab_active_bg')};")
    css.append(f"  --header-tab-active-text: {light.get('header_tab_active_text')};")
    css.append(f"  --fm-panel-bg: {light.get('fm_panel_bg')};")
    css.append(f"  --fm-panel-border: {light.get('fm_panel_border')};")
    css.append(f"  --fm-panel-bar-bg: {light.get('fm_panel_bar_bg')};")
    css.append(f"  --fm-panel-bar-border: {light.get('fm_panel_bar_border')};")
    css.append(f"  --fm-input-bg: {light.get('fm_input_bg')};")
    css.append(f"  --fm-input-border: {light.get('fm_input_border')};")
    css.append(f"  --fm-row-header-bg: {light.get('fm_row_header_bg')};")
    css.append(f"  --fm-row-header-border: {light.get('fm_row_header_border')};")
    css.append(f"  --fm-row-hover-bg: {light.get('fm_row_hover_bg')};")
    css.append(f"  --fm-row-selected-bg: {light.get('fm_row_selected_bg')};")
    css.append(f"  --fm-row-focus-outline: {light.get('fm_row_focus_outline')};")
    css.append(f"  --fm-props-bg: {light.get('fm_props_bg')};")
    css.append(f"  --fm-props-border: {light.get('fm_props_border')};")
    css.append(f"  --fm-menu-bg: {light.get('fm_menu_bg')};")
    css.append(f"  --fm-menu-border: {light.get('fm_menu_border')};")
    css.append(f"  --fm-menu-item-hover-bg: {light.get('fm_menu_item_hover_bg')};")
    css.append(f"  --fm-menu-item-hover-border: {light.get('fm_menu_item_hover_border')};")
    css.append(f"  --fm-menu-sep: {light.get('fm_menu_sep')};")
    css.append(f"  --fm-btn-bg: {light.get('fm_btn_bg')};")
    css.append(f"  --fm-btn-text: {light.get('fm_btn_text')};")
    css.append(f"  --fm-btn-border: {light.get('fm_btn_border')};")
    css.append(f"  --fm-btn-hover-bg: {light.get('fm_btn_hover_bg')};")
    css.append(f"  --fm-btn-hover-text: {light.get('fm_btn_hover_text')};")
    css.append(f"  --fm-btn-hover-border: {light.get('fm_btn_hover_border')};")
    css.append(f"  --fm-btn-active-from: {light.get('fm_btn_active_from')};")
    css.append(f"  --fm-btn-active-to: {light.get('fm_btn_active_to')};")
    css.append(f"  --radius: {int(light.get('radius') or 12)}px;")
    css.append(f"  --radius-sm: {light_rs}px;")
    css.append(f"  --shadow: {float(light.get('shadow') or 0.08)};")
    css.append("  --shadow-rgb: 15, 23, 42;")
    css.append(f"  --density: {float(light.get('density') or 1.0)};")
    css.append(f"  --contrast: {float(light.get('contrast') or 1.0)};")
    css.append("}")
    css.append("")

    css.append("/* Core surfaces */")
    css.append("body {")
    css.append("  background: var(--bg) !important;")
    css.append("  color: var(--text) !important;")
    css.append("}")

    # Safety override: neutralize any legacy `filter: contrast()` rules from older theme versions.
    # NOTE: A filter on an ancestor affects all descendants and cannot be "canceled" from inside.
    # Therefore we must explicitly reset it on the usual top-level containers.
    css.append("html, body, .container { filter: none !important; }")
    css.append(".container > :not(.modal):not(.terminal-overlay):not(.xkeen-cm-help-overlay):not(.xkeen-cm-help-drawer) { filter: none !important; }")
    css.append(".modal-content, .terminal-window, .xkeen-cm-help-drawer, .global-spinner-box { filter: none !important; }")
    css.append("")

    # Contrast (safe):
    # Do NOT use CSS `filter: contrast()` on containers. It breaks transparency and alters embedded widgets (CodeMirror, file manager).
    # Instead, gently adjust a couple of core tokens (border + muted) via color-mix when available.
    css.append("/* Contrast (safe): no CSS filter; only token adjustments */")
    css.append(":root { --xk-border: var(--border); --xk-muted: var(--muted); }")
    css.append("@supports (color: color-mix(in srgb, black 50%, white)) {")
    css.append("  :root {")
    css.append("    --xk-contrast-hi: clamp(0, calc(var(--contrast) - 1), 1);")
    css.append("    --xk-contrast-lo: clamp(0, calc(1 - var(--contrast)), 1);")
    css.append("    --xk-contrast-hi-p: calc(var(--xk-contrast-hi) * 55%);")
    css.append("    --xk-contrast-lo-p: calc(var(--xk-contrast-lo) * 55%);")
    css.append("    --xk-border: color-mix(in srgb, color-mix(in srgb, var(--border) calc(100% - var(--xk-contrast-hi-p)), var(--text) var(--xk-contrast-hi-p)) calc(100% - var(--xk-contrast-lo-p)), var(--bg) var(--xk-contrast-lo-p));")
    css.append("    --xk-muted: color-mix(in srgb, color-mix(in srgb, var(--muted) calc(100% - var(--xk-contrast-hi-p)), var(--text) var(--xk-contrast-hi-p)) calc(100% - var(--xk-contrast-lo-p)), var(--bg) var(--xk-contrast-lo-p));")
    css.append("  }")
    css.append("}")
    css.append("a { color: var(--accent) !important; }")
    css.append("header p, .card p, .hint, .modal-hint, .small { color: var(--xk-muted, var(--muted)) !important; }")
    css.append("")


    css.append(".container { padding: calc(24px * var(--density)) !important; }")
    css.append(".card {")
    css.append("  background: var(--card-bg) !important;")
    css.append("  border-color: var(--xk-border, var(--border)) !important;")
    css.append("  border-radius: var(--radius) !important;")
    css.append("  padding: calc(16px * var(--density)) calc(16px * var(--density)) calc(20px * var(--density)) !important;")
    css.append("  box-shadow: 0 10px 30px rgba(var(--shadow-rgb), var(--shadow)) !important;")
    css.append("}")
    css.append(".modal {")
    css.append("  background: var(--modal-overlay) !important;")
    css.append("}")
    css.append(".modal-content {")
    css.append("  background: var(--modal-bg) !important;")
    css.append("  color: var(--modal-text) !important;")
    css.append("  border-color: var(--modal-border) !important;")
    css.append("  border-radius: var(--radius) !important;")
    css.append("  box-shadow: 0 10px 30px rgba(var(--shadow-rgb), var(--shadow)) !important;")
    css.append("}")
    css.append(".modal-header { border-bottom-color: var(--modal-header-border) !important; }")
    css.append(".modal-close { color: var(--modal-close) !important; }")
    css.append(".modal-close:hover { color: var(--modal-close-hover) !important; }")
    css.append(".modal-content .modal-hint, .modal-content .hint, .modal-content .small { color: var(--modal-muted) !important; }")
    css.append(".modal-body { background: var(--modal-body-bg) !important; }")
    css.append(".modal-body-logs { background: var(--modal-body-bg) !important; border: 1px solid var(--modal-body-border) !important; border-radius: var(--radius-sm) !important; padding: calc(8px * var(--density)) !important; }")
    css.append(".modal-content table { background: transparent !important; color: var(--modal-text) !important; }")
    css.append(".modal-content thead { background: var(--modal-table-head-bg) !important; }")
    css.append(".modal-content th { color: var(--modal-table-head-text) !important; border-bottom-color: var(--modal-table-border) !important; }")
    css.append(".modal-content td { border-bottom-color: var(--modal-table-border) !important; }")
    css.append(".modal-content tbody tr:hover { background: var(--modal-table-row-hover-bg) !important; }")
    css.append(".modal-content ul li::marker, .modal-content ol li::marker { color: var(--modal-list-marker) !important; }")
    css.append("")

    css.append("input, select, textarea, .xkeen-textarea, .CodeMirror {")
    css.append("  border-color: var(--xk-border, var(--border)) !important;")
    css.append("  border-radius: var(--radius-sm) !important;")
    css.append("  background: var(--card-bg) !important;")
    css.append("  color: var(--text) !important;")
    css.append("}")
    css.append("button { border-radius: var(--radius-sm) !important; }")

    css.append("")
    css.append("/* Global tables */")
    css.append("table { background: transparent !important; color: var(--text) !important; }")
    css.append("thead { background: var(--modal-table-head-bg) !important; }")
    css.append("th, td { border-bottom-color: var(--xk-border, var(--border)) !important; }")
    css.append("th { color: var(--xk-muted, var(--muted)) !important; background: transparent !important; }")
    css.append("tbody tr:hover { background: color-mix(in srgb, var(--card-bg) 92%, transparent) !important; }")
    css.append("")

    css.append("/* Footer */")
    css.append("footer { color: var(--xk-muted, var(--muted)) !important; }")
    css.append("")

    css.append("/* Logs blocks (outside modals) */")
    css.append(".log-block, .terminal-output { background: var(--card-bg) !important; color: var(--text) !important; border-color: var(--xk-border, var(--border)) !important; }")
    css.append("")

    css.append("/* Toast notifications */")
    css.append(".toast { background: var(--card-bg) !important; color: var(--text) !important; border-color: var(--sem-success) !important; box-shadow: 0 18px 40px color-mix(in srgb, var(--sem-success) 40%, transparent) !important; }")
    css.append(".toast-error { border-color: var(--sem-error) !important; box-shadow: 0 18px 40px color-mix(in srgb, var(--sem-error) 40%, transparent) !important; }")
    css.append("")
    css.append("/* Global spinner overlay */")
    css.append("#global-xkeen-spinner { background: var(--modal-overlay) !important; }")
    css.append(".global-spinner-box { background: var(--modal-bg) !important; border-color: var(--modal-border) !important; border-radius: var(--radius) !important; box-shadow: 0 18px 38px rgba(var(--shadow-rgb), var(--shadow)) !important; }")
    css.append(".global-spinner-text { color: var(--modal-text) !important; }")
    css.append(".global-spinner-icon { border-color: color-mix(in srgb, var(--sem-success) 35%, transparent) !important; border-top-color: var(--sem-success) !important; }")
    css.append("")

    css.append("/* Tooltips */")
    css.append(".xk-tooltip::after, .command-item::after, .xkeen-cm-tool[data-tip]::after { background: var(--modal-bg) !important; color: var(--modal-text) !important; border-color: var(--xk-border, var(--border)) !important; box-shadow: 0 10px 25px rgba(var(--shadow-rgb), var(--shadow)) !important; }")
    css.append(".xk-tooltip::before, .command-item::before { border-color: transparent transparent var(--modal-bg) transparent !important; }")
    css.append("")

    css.append("/* CodeMirror surfaces */")
    css.append(".CodeMirror-scroll { background: var(--card-bg) !important; }")
    css.append("")

    css.append("/* CodeMirror: make BOTH built-in themes (default + material-darker) follow global vars */")
    css.append(".CodeMirror, .cm-s-default.CodeMirror, .cm-s-material-darker.CodeMirror { background: var(--card-bg) !important; color: var(--text) !important; }")
    css.append(".CodeMirror-gutters { background: var(--card-bg) !important; border-right-color: var(--xk-border, var(--border)) !important; }")
    css.append(".CodeMirror-linenumber { color: color-mix(in srgb, var(--muted) 78%, transparent) !important; }")
    css.append(".CodeMirror-cursor { border-left-color: var(--accent) !important; }")
    css.append(".CodeMirror-selected, div.CodeMirror-selected { background: color-mix(in srgb, var(--accent) 22%, transparent) !important; }")
    css.append(".CodeMirror-focused .CodeMirror-selected, .CodeMirror-focused div.CodeMirror-selected { background: color-mix(in srgb, var(--accent) 28%, transparent) !important; }")
    css.append(".CodeMirror-activeline-background { background: color-mix(in srgb, var(--accent) 9%, transparent) !important; }")
    css.append(".CodeMirror-activeline-gutter { background: color-mix(in srgb, var(--accent) 7%, transparent) !important; }")
    css.append(".CodeMirror-matchingbracket { color: var(--text) !important; background: color-mix(in srgb, var(--accent) 18%, transparent) !important; outline: 1px solid color-mix(in srgb, var(--accent) 45%, transparent) !important; }")
    css.append(".CodeMirror-nonmatchingbracket { color: var(--text) !important; background: color-mix(in srgb, var(--sem-error) 18%, transparent) !important; outline: 1px solid color-mix(in srgb, var(--sem-error) 55%, transparent) !important; }")
    css.append(".cm-searching { background: color-mix(in srgb, var(--sem-warning) 35%, transparent) !important; color: var(--text) !important; }")
    css.append(".cm-searching.cm-searching-selected { background: color-mix(in srgb, var(--sem-warning) 50%, transparent) !important; }")
    css.append("")

    css.append("/* CodeMirror tokens: drive syntax colors from semantic/global vars */")
    css.append(".cm-s-default .cm-comment, .cm-s-material-darker .cm-comment { color: color-mix(in srgb, var(--muted) 82%, transparent) !important; font-style: italic; }")
    css.append(".cm-s-default .cm-string, .cm-s-material-darker .cm-string, .cm-s-default .cm-string-2, .cm-s-material-darker .cm-string-2 { color: color-mix(in srgb, var(--sem-success) 82%, var(--text) 18%) !important; }")
    css.append(".cm-s-default .cm-number, .cm-s-material-darker .cm-number { color: color-mix(in srgb, var(--sem-warning) 86%, var(--text) 14%) !important; }")
    css.append(".cm-s-default .cm-keyword, .cm-s-material-darker .cm-keyword { color: var(--accent) !important; font-weight: 600; }")
    css.append(".cm-s-default .cm-builtin, .cm-s-material-darker .cm-builtin { color: color-mix(in srgb, var(--sem-info) 88%, var(--text) 12%) !important; }")
    css.append(".cm-s-default .cm-def, .cm-s-material-darker .cm-def { color: color-mix(in srgb, var(--sem-info) 78%, var(--text) 22%) !important; }")
    css.append(".cm-s-default .cm-property, .cm-s-material-darker .cm-property { color: color-mix(in srgb, var(--sem-info) 70%, var(--text) 30%) !important; }")
    css.append(".cm-s-default .cm-atom, .cm-s-material-darker .cm-atom { color: var(--sem-warning) !important; }")
    css.append(".cm-s-default .cm-tag, .cm-s-material-darker .cm-tag { color: var(--accent) !important; }")
    css.append(".cm-s-default .cm-attribute, .cm-s-material-darker .cm-attribute { color: var(--sem-warning) !important; }")
    css.append(".cm-s-default .cm-qualifier, .cm-s-material-darker .cm-qualifier { color: color-mix(in srgb, var(--sem-warning) 70%, var(--text) 30%) !important; }")
    css.append(".cm-s-default .cm-variable, .cm-s-material-darker .cm-variable { color: var(--text) !important; }")
    css.append(".cm-s-default .cm-variable-2, .cm-s-material-darker .cm-variable-2 { color: color-mix(in srgb, var(--sem-info) 75%, var(--text) 25%) !important; }")
    css.append(".cm-s-default .cm-variable-3, .cm-s-material-darker .cm-variable-3 { color: color-mix(in srgb, var(--sem-success) 70%, var(--text) 30%) !important; }")
    css.append(".cm-s-default .cm-operator, .cm-s-material-darker .cm-operator { color: var(--text) !important; }")
    css.append(".cm-s-default .cm-meta, .cm-s-material-darker .cm-meta { color: color-mix(in srgb, var(--muted) 88%, var(--text) 12%) !important; }")
    css.append(".cm-s-default .cm-link, .cm-s-material-darker .cm-link { color: var(--accent) !important; text-decoration: underline; }")
    css.append(".cm-s-default .cm-error, .cm-s-material-darker .cm-error { color: var(--sem-error) !important; }")
    css.append("")

    css.append("/* CodeMirror dialogs (search / replace) */")
    css.append(".CodeMirror-dialog { background: var(--modal-bg) !important; color: var(--modal-text) !important; border-bottom: 1px solid var(--modal-header-border) !important; }")
    css.append(".CodeMirror-dialog input { background: var(--modal-body-bg) !important; color: var(--modal-text) !important; border: 1px solid var(--modal-body-border) !important; border-radius: var(--radius-sm) !important; }")
    css.append(".CodeMirror-dialog input:focus { border-color: var(--accent) !important; box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 26%, transparent) !important; }")
    css.append(".CodeMirror-dialog .CodeMirror-search-hint { color: var(--modal-muted) !important; }")
    css.append(".CodeMirror-dialog button { background: var(--editor-btn-bg) !important; color: var(--editor-btn-text) !important; border: 1px solid var(--editor-btn-border) !important; border-radius: var(--radius-sm) !important; }")
    css.append(".CodeMirror-dialog button:hover { background: var(--editor-btn-hover-bg) !important; color: var(--editor-btn-hover-text) !important; border-color: var(--editor-btn-hover-border) !important; }")
    css.append("")

    css.append("/* xterm.js wrapper: CSS follows global vars; palette is set in JS from CSS vars */")
    css.append(".xterm, .xterm .xterm-viewport { background: var(--card-bg) !important; color: var(--text) !important; }")
    css.append(".xterm .xterm-selection div { background: color-mix(in srgb, var(--accent) 28%, transparent) !important; }")
    css.append("")

    css.append("/* CodeMirror toolbar + help drawer */")
    css.append(".xkeen-cm-tool { background: color-mix(in srgb, var(--editor-btn-bg) 82%, transparent) !important; color: var(--editor-btn-text) !important; border-color: color-mix(in srgb, var(--editor-btn-border) 85%, transparent) !important; }")
    css.append(".xkeen-cm-tool:hover { background: color-mix(in srgb, var(--editor-btn-hover-bg) 88%, transparent) !important; color: var(--editor-btn-hover-text) !important; border-color: color-mix(in srgb, var(--editor-btn-hover-border) 85%, transparent) !important; }")
    css.append(".xkeen-cm-tool:disabled, .xkeen-cm-tool.is-disabled { border-color: color-mix(in srgb, var(--editor-btn-border) 60%, transparent) !important; }")
    css.append(".xkeen-cm-tool.is-help { color: var(--sem-error) !important; }")
    css.append(".xkeen-cm-tool.is-help:hover { border-color: color-mix(in srgb, var(--sem-error) 65%, transparent) !important; }")
    css.append(".xkeen-cm-help-overlay { background: var(--modal-overlay) !important; }")
    css.append(".xkeen-cm-help-drawer { background: var(--modal-bg) !important; color: var(--modal-text) !important; border-left-color: var(--xk-border, var(--border)) !important; box-shadow: -24px 0 48px rgba(var(--shadow-rgb), var(--shadow)) !important; }")
    css.append(".xkeen-cm-help-head { border-bottom-color: var(--modal-header-border) !important; }")
    css.append(".xkeen-cm-help-close { background: var(--editor-btn-bg) !important; color: var(--editor-btn-text) !important; border-color: var(--editor-btn-border) !important; }")
    css.append(".xkeen-cm-help-close:hover { background: var(--editor-btn-hover-bg) !important; color: var(--editor-btn-hover-text) !important; border-color: var(--editor-btn-hover-border) !important; }")
    css.append(".xkeen-cm-help-section { background: color-mix(in srgb, var(--modal-body-bg) 88%, transparent) !important; border-color: color-mix(in srgb, var(--modal-body-border) 85%, transparent) !important; }")
    css.append("")

    css.append("/* Service status lamp */")
    css.append(".service-status-lamp[data-state=\"stopped\"] { background: var(--sem-error) !important; box-shadow: 0 0 4px color-mix(in srgb, var(--sem-error) 70%, transparent) !important; }")
    css.append(".service-status-lamp[data-state=\"pending\"] { background: var(--sem-warning) !important; box-shadow: 0 0 6px color-mix(in srgb, var(--sem-warning) 70%, transparent) !important; }")
    css.append(".service-status-lamp[data-state=\"error\"] { background: var(--sem-warning) !important; box-shadow: 0 0 6px color-mix(in srgb, var(--sem-warning) 70%, transparent) !important; }")
    css.append("")

    css.append("/* Menus / popovers */")
    css.append(".dt-log-menu-panel, .xray-line-menu { background: color-mix(in srgb, var(--modal-bg) 92%, transparent) !important; color: var(--text) !important; border-color: var(--xk-border, var(--border)) !important; box-shadow: 0 18px 50px rgba(var(--shadow-rgb), var(--shadow)) !important; }")
    css.append(".fm-context-menu { background: var(--fm-menu-bg, color-mix(in srgb, var(--modal-bg) 92%, transparent)) !important; color: var(--text) !important; border-color: var(--fm-menu-border, var(--modal-border, var(--xk-border, var(--border)))) !important; box-shadow: 0 18px 50px rgba(var(--shadow-rgb), var(--shadow)) !important; }")
    css.append(".fm-context-item:hover { background: var(--fm-menu-item-hover-bg, color-mix(in srgb, var(--accent) 12%, transparent)) !important; border-color: var(--fm-menu-item-hover-border, color-mix(in srgb, var(--xk-border, var(--border)) 60%, transparent)) !important; }")
    css.append(".fm-context-sep { background: var(--fm-menu-sep, color-mix(in srgb, var(--xk-border, var(--border)) 60%, transparent)) !important; }")
    css.append("")

    css.append("/* Destructive buttons */")
    css.append(".btn-danger { border-color: color-mix(in srgb, var(--sem-error) 60%, transparent) !important; background: color-mix(in srgb, var(--sem-error) 18%, transparent) !important; color: color-mix(in srgb, var(--sem-error) 25%, white) !important; }")
    css.append(".btn-danger:hover { background: color-mix(in srgb, var(--sem-error) 26%, transparent) !important; }")
    css.append("")

    css.append("/* Focus rings (global) */")
    css.append("input:focus, select:focus, textarea:focus, .xkeen-textarea:focus, .dt-pill-field:focus, .dt-log-lines-input:focus { outline: none !important; border-color: var(--accent) !important; box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 30%, transparent) !important; }")
    css.append("button:focus-visible, .xkeen-cm-tool:focus-visible, .btn-link:focus-visible, .top-tab-btn:focus-visible, summary:focus-visible { outline: 2px solid color-mix(in srgb, var(--accent) 55%, transparent) !important; outline-offset: 2px !important; }")
    css.append(".dt-log-menu[open] > summary { border-color: var(--accent) !important; box-shadow: 0 6px 16px color-mix(in srgb, var(--accent) 22%, transparent) !important; }")
    css.append("")
    return "\n".join(css) + "\n"


def theme_get(ui_state_dir: str) -> Dict[str, Any]:
    """Load current theme config (or defaults)."""
    cfg = json.loads(json.dumps(_DEFAULT_THEME_CONFIG))
    exists = False
    jpath = _theme_json_path(ui_state_dir)
    cpath = _theme_css_path(ui_state_dir)

    try:
        if os.path.isfile(jpath):
            with open(jpath, "r", encoding="utf-8", errors="ignore") as f:
                raw = json.load(f)
            cfg = _sanitize_theme_config(raw)
            exists = True

            # Keep generated CSS in sync with current generator version.
            try:
                if not os.path.isfile(cpath) or not _file_has_marker(cpath, THEME_CSS_MARKER):
                    _atomic_write_text(cpath, _theme_css_from_config(cfg), mode=0o644)
            except Exception:
                pass
        elif os.path.isfile(cpath):
            # If only CSS exists (older version), still report exists.
            exists = True
    except Exception:
        cfg = json.loads(json.dumps(_DEFAULT_THEME_CONFIG))

    version = 0
    try:
        if os.path.isfile(cpath):
            version = int(os.path.getmtime(cpath) or 0)
    except Exception:
        version = 0

    return {
        "config": cfg,
        "exists": bool(exists),
        "version": version,
        "css_file": cpath,
        "json_file": jpath,
    }


def theme_set(ui_state_dir: str, cfg_in: Any) -> Dict[str, Any]:
    """Validate + persist theme config as JSON + generated CSS."""
    cfg = _sanitize_theme_config(cfg_in)
    jpath = _theme_json_path(ui_state_dir)
    cpath = _theme_css_path(ui_state_dir)

    _atomic_write_text(jpath, json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", mode=0o600)
    _atomic_write_text(cpath, _theme_css_from_config(cfg), mode=0o644)

    version = 0
    try:
        version = int(os.path.getmtime(cpath) or 0)
    except Exception:
        version = 0

    return {
        "config": cfg,
        "exists": True,
        "version": version,
        "css_file": cpath,
        "json_file": jpath,
    }


def theme_reset(ui_state_dir: str) -> Dict[str, Any]:
    """Remove saved custom theme (JSON + CSS)."""
    jpath = _theme_json_path(ui_state_dir)
    cpath = _theme_css_path(ui_state_dir)

    for fp in (jpath, cpath):
        try:
            if os.path.exists(fp):
                os.remove(fp)
        except Exception:
            pass


    return theme_get(ui_state_dir)
