"""UI page routes extracted from app.py.

We register routes directly on the Flask app (not via Blueprint) to preserve
endpoint names referenced from templates via url_for(...).
"""

from __future__ import annotations

import os
import re

from flask import Flask, make_response, redirect, render_template, url_for
from services.capabilities import detect_terminal_state
from services.cores import detect_available_cores


def _parse_sections_whitelist(raw: str | None) -> set[str] | None:
    s = str(raw or "").strip().lower()
    if not s or s in {"*", "all", "any"}:
        return None
    return {
        token
        for token in re.split(r"[\s,;]+", s)
        if token and token not in {"*", "all", "any"}
    }


def _detect_panel_core_ui() -> dict[str, object]:
    detected_cores = list(detect_available_cores())
    available_cores = list(detected_cores)
    core_ui_fallback = False
    if not available_cores:
        # In dev/desktop environments there may be no /opt/sbin/* binaries at all.
        # Keep the full UI visible there instead of hiding both core-specific areas.
        available_cores = ["xray", "mihomo"]
        core_ui_fallback = True
    has_xray = "xray" in available_cores
    has_mihomo = "mihomo" in available_cores

    supported_sections: list[str] = []
    if has_xray:
        supported_sections.append("routing")
    if has_mihomo:
        supported_sections.append("mihomo")
    supported_sections.extend(["xkeen"])
    if has_xray:
        supported_sections.append("xray-logs")
    supported_sections.extend(["commands", "files"])
    if has_mihomo:
        supported_sections.append("mihomo-generator")
    supported_sections.append("donate")

    requested_sections = _parse_sections_whitelist(os.environ.get("XKEEN_UI_PANEL_SECTIONS_WHITELIST"))
    effective_sections = (
        supported_sections
        if requested_sections is None
        else [section for section in supported_sections if section in requested_sections]
    )
    if not effective_sections:
        effective_sections = supported_sections

    return {
        "available_cores": available_cores,
        "detected_cores": detected_cores,
        "core_ui_fallback": core_ui_fallback,
        "has_xray": has_xray,
        "has_mihomo": has_mihomo,
        "multi_core": len(available_cores) > 1,
        "panel_sections_whitelist": ",".join(effective_sections) if effective_sections else "__none__",
    }


def _no_cache(resp):
    """Apply no-cache headers for HTML pages.

    This helps ensure that after self-update users get the new HTML that points
    at updated static assets, without requiring Ctrl+F5.
    """
    try:
        resp.headers["Cache-Control"] = "no-store, max-age=0"
        resp.headers["Pragma"] = "no-cache"
    except Exception:
        pass
    return resp


def register_pages_routes(
    app: Flask,
    *,
    ROUTING_FILE: str,
    MIHOMO_CONFIG_FILE: str,
    INBOUNDS_FILE: str,
    OUTBOUNDS_FILE: str,
    BACKUP_DIR: str,
    COMMAND_GROUPS,
    GITHUB_REPO_URL: str,
) -> None:
    """Register UI page routes on the app."""


    @app.get("/")
    def index():
        # machine info for conditional UI (e.g. hide Files tab on MIPS)
        try:
            _machine = os.uname().machine
        except Exception:
            _machine = ""
        _is_mips = str(_machine).lower().startswith("mips")
        try:
            _terminal_supports_pty = bool(detect_terminal_state(os.environ).get("pty"))
        except Exception:
            _terminal_supports_pty = not _is_mips

        # Detect active Xray profile/variant for UI hints.
        try:
            _xray_profile = "hys2" if "_hys2" in os.path.basename(ROUTING_FILE) else "classic"
        except Exception:
            _xray_profile = "classic"

        # File Manager defaults: /tmp/mnt exists on routers with mounted storage,
        # but may be absent on dev machines (and should not spam console with 403/404).
        try:
            _fm_right_default = "/tmp/mnt" if os.path.isdir("/tmp/mnt") else "/tmp"
        except Exception:
            _fm_right_default = "/tmp/mnt"

        _core_ui = _detect_panel_core_ui()
        page_ctx = {
            "machine": _machine,
            "is_mips": _is_mips,
            "terminal_supports_pty": _terminal_supports_pty,
            "xkeen_runtime_debug": str(os.environ.get("XKEEN_DEV", "")).strip().lower() in {"1", "true", "yes", "on"},
            "xkeen_terminal_enable_optional_addons": str(os.environ.get("XKEEN_ENABLE_XTERM_OPTIONAL_ADDONS", "")).strip().lower() in {"1", "true", "yes", "on"},
            "xray_profile": _xray_profile,
            "routing_file": ROUTING_FILE,
            "routing_name": os.path.basename(ROUTING_FILE),
            "mihomo_config_file": MIHOMO_CONFIG_FILE,
            "mihomo_config_exists": os.path.exists(MIHOMO_CONFIG_FILE),
            "inbounds_file": INBOUNDS_FILE,
            "inbounds_name": os.path.basename(INBOUNDS_FILE),
            "outbounds_file": OUTBOUNDS_FILE,
            "outbounds_name": os.path.basename(OUTBOUNDS_FILE),
            "backup_dir": BACKUP_DIR,
            "command_groups": COMMAND_GROUPS,
            "github_repo_url": GITHUB_REPO_URL,
            "fm_right_default": _fm_right_default,
            **_core_ui,
        }

        try:
            resp = make_response(render_template("panel.html", **page_ctx))
            return _no_cache(resp)
        except Exception:
            # Fallback to previous behaviour.
            return render_template("panel.html", **page_ctx)

    @app.get("/xkeen")
    def xkeen_page():
        try:
            return _no_cache(make_response(render_template("xkeen.html")))
        except Exception:
            return render_template("xkeen.html")

    @app.get("/mihomo_generator")
    def mihomo_generator_page():
        if not _detect_panel_core_ui().get("has_mihomo"):
            return redirect(url_for("index"))
        try:
            return _no_cache(make_response(render_template("mihomo_generator.html")))
        except Exception:
            return render_template("mihomo_generator.html")

    @app.get("/devtools")
    def devtools_page():
        # Avoid stale cached HTML holding on to old static asset versions
        try:
            resp = make_response(render_template("devtools.html"))
            return _no_cache(resp)
        except Exception:
            return render_template("devtools.html")
