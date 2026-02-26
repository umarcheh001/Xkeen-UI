"""Early environment bootstrap for Mihomo.

This module must remain safe to import very early: it may be imported by app.py
before importing mihomo_server_core.

PR1: move MIHOMO_ROOT selection logic here (previously in app.py).
"""

from __future__ import annotations

import os
import sys


def _dbg(msg: str) -> None:
    """Optional early bootstrap debug output.

    Enable with env `XKEEN_BOOT_DEBUG=1`.
    """
    if os.environ.get("XKEEN_BOOT_DEBUG") in ("1", "true", "yes", "on"):
        try:
            print(f"[xkeen-ui][boot] {msg}", file=sys.stderr)
        except Exception:
            return


def _mh_is_writable_dir(path: str) -> bool:
    try:
        os.makedirs(path, exist_ok=True)
        test_path = os.path.join(path, ".writetest")
        with open(test_path, "w", encoding="utf-8") as f:
            f.write("")
        os.remove(test_path)
        return True
    except Exception:
        return False


def ensure_mihomo_root_env() -> None:
    """Ensure MIHOMO_ROOT is set to a writable directory.

    Router default: /opt/etc/mihomo
    Dev/macOS fallback:
      - bundled ./opt/etc/mihomo (inside the project)
      - XDG/~/Library Application Support/ ~/.config
    """
    if "MIHOMO_ROOT" in os.environ:
        return

    router_mh = "/opt/etc/mihomo"
    if _mh_is_writable_dir(router_mh):
        os.environ["MIHOMO_ROOT"] = router_mh
        return

    here = os.path.dirname(os.path.abspath(__file__))
    bundled = os.path.join(here, "opt", "etc", "mihomo")
    if os.path.isdir(bundled):
        os.environ["MIHOMO_ROOT"] = bundled
    else:
        home = os.path.expanduser("~")
        xdg = os.environ.get("XDG_CONFIG_HOME")
        if xdg:
            base = os.path.join(xdg, "xkeen-ui")
        elif sys.platform == "darwin":
            base = os.path.join(home, "Library", "Application Support", "xkeen-ui")
        else:
            base = os.path.join(home, ".config", "xkeen-ui")
        os.environ["MIHOMO_ROOT"] = os.path.join(base, "etc", "mihomo")

    try:
        os.makedirs(os.environ["MIHOMO_ROOT"], exist_ok=True)
    except Exception as e:  # noqa: BLE001
        # Best-effort: leave a trace only when bootstrap debug is enabled.
        _dbg(f"MIHOMO_ROOT mkdir failed: {os.environ.get('MIHOMO_ROOT')} ({e})")
