"""UI page routes extracted from app.py.

We register routes directly on the Flask app (not via Blueprint) to preserve
endpoint names referenced from templates via url_for(...).
"""

from __future__ import annotations

import os

from flask import Flask, render_template, make_response


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

        # Detect active Xray profile/variant for UI hints.
        try:
            _xray_profile = "hys2" if "_hys2" in os.path.basename(ROUTING_FILE) else "classic"
        except Exception:
            _xray_profile = "classic"

        return render_template(
            "panel.html",
            machine=_machine,
            is_mips=_is_mips,
            xray_profile=_xray_profile,
            routing_file=ROUTING_FILE,
            routing_name=os.path.basename(ROUTING_FILE),
            mihomo_config_file=MIHOMO_CONFIG_FILE,
            inbounds_file=INBOUNDS_FILE,
            inbounds_name=os.path.basename(INBOUNDS_FILE),
            outbounds_file=OUTBOUNDS_FILE,
            outbounds_name=os.path.basename(OUTBOUNDS_FILE),
            backup_dir=BACKUP_DIR,
            command_groups=COMMAND_GROUPS,
            github_repo_url=GITHUB_REPO_URL,
        )

    @app.get("/xkeen")
    def xkeen_page():
        return render_template("xkeen.html")

    @app.get("/mihomo_generator")
    def mihomo_generator_page():
        return render_template("mihomo_generator.html")

    @app.get("/devtools")
    def devtools_page():
        # Avoid stale cached HTML holding on to old static asset versions
        try:
            resp = make_response(render_template("devtools.html"))
            resp.headers["Cache-Control"] = "no-store, max-age=0"
            resp.headers["Pragma"] = "no-cache"
            return resp
        except Exception:
            return render_template("devtools.html")
