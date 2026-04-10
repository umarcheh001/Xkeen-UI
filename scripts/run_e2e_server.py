from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
RUN_SERVER = REPO_ROOT / "xkeen-ui" / "run_server.py"
TMP_DIR = REPO_ROOT / ".tmp"
STATE_DIR = TMP_DIR / "e2e-state"
HOME_DIR = TMP_DIR / "e2e-home"
LOG_DIR = TMP_DIR / "e2e-logs"


def _ensure_dirs() -> None:
    for path in (TMP_DIR, STATE_DIR, HOME_DIR, LOG_DIR):
        path.mkdir(parents=True, exist_ok=True)


def main() -> int:
    _ensure_dirs()

    env = os.environ.copy()
    env.setdefault("HOME", str(HOME_DIR))
    env.setdefault("USERPROFILE", str(HOME_DIR))
    env.setdefault("XDG_CONFIG_HOME", str(HOME_DIR / ".config"))
    env.setdefault("XKEEN_UI_STATE_DIR", str(STATE_DIR))
    env.setdefault("XKEEN_LOG_DIR", str(LOG_DIR))
    env.setdefault("XKEEN_UI_SECRET_KEY", "e2e-secret-key")
    env.setdefault("XKEEN_UI_PORT", str(env.get("XKEEN_E2E_PORT") or "18188"))

    cmd = [sys.executable, str(RUN_SERVER)]
    return subprocess.call(cmd, cwd=str(REPO_ROOT), env=env)


if __name__ == "__main__":
    raise SystemExit(main())
