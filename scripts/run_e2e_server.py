from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
RUN_SERVER = REPO_ROOT / "xkeen-ui" / "run_server.py"
TMP_DIR = REPO_ROOT / ".tmp"
STATE_DIR = TMP_DIR / "e2e-state"
HOME_DIR = TMP_DIR / "e2e-home"
LOG_DIR = TMP_DIR / "e2e-logs"
ETC_DIR = TMP_DIR / "e2e-etc"
VAR_DIR = TMP_DIR / "e2e-var"
MIHOMO_DIR = ETC_DIR / "mihomo"
XRAY_CONFIGS_DIR = ETC_DIR / "xray" / "configs"
XRAY_JSONC_DIR = STATE_DIR / "xray-jsonc"

ROUTING_FIXTURE = REPO_ROOT / "xkeen-ui" / "opt" / "etc" / "xray" / "templates" / "routing" / "05_routing_base.jsonc"
MIHOMO_TEMPLATE_DIR = REPO_ROOT / "xkeen-ui" / "opt" / "etc" / "mihomo" / "templates"


DEFAULT_UI_SETTINGS = """{
  \"schemaVersion\": 2,
  \"editor\": {
    \"engine\": \"codemirror\",
    \"codemirrorFontScale\": 100,
    \"monacoFontScale\": 100,
    \"schemaHoverEnabled\": true,
    \"beginnerModeEnabled\": true,
    \"expertModeEnabled\": false
  },
  \"format\": {\"preferPrettier\": false, \"tabWidth\": 2, \"printWidth\": 80},
  \"logs\": {\"ansi\": false, \"ws2\": false, \"view\": {}},
  \"routing\": {\"guiEnabled\": true, \"autoApply\": false, \"showActiveOutbound\": false, \"showScenarioCard\": true}
}
"""


def _reset_dir(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _seed_runtime_fixture() -> None:
    """Create a complete, disposable router-like filesystem for Playwright."""
    for path in (STATE_DIR, HOME_DIR, LOG_DIR, ETC_DIR, VAR_DIR):
        _reset_dir(path)

    routing_raw = ROUTING_FIXTURE.read_text(encoding="utf-8")
    _write(XRAY_CONFIGS_DIR / "05_routing.json", "{\n  \"routing\": {\n    \"rules\": []\n  }\n}\n")
    _write(XRAY_JSONC_DIR / "05_routing.jsonc", routing_raw)
    _write(XRAY_CONFIGS_DIR / "03_inbounds.json", "{\n  \"inbounds\": []\n}\n")
    _write(XRAY_CONFIGS_DIR / "04_outbounds.json", "{\n  \"outbounds\": []\n}\n")
    _write(XRAY_CONFIGS_DIR / "01_log.json", "{\n  \"log\": {\n    \"loglevel\": \"warning\"\n  }\n}\n")

    _write(ETC_DIR / "xkeen" / "port_proxying.lst", "#80\n#443\n#596:599\n")
    _write(ETC_DIR / "xkeen" / "port_exclude.lst", "#\n")
    _write(ETC_DIR / "xkeen" / "ip_exclude.lst", "#192.168.0.0/16\n")
    _write(ETC_DIR / "xkeen" / "xkeen.json", "{}\n")

    shutil.copytree(MIHOMO_TEMPLATE_DIR, MIHOMO_DIR / "templates")
    # ``ensure_mihomo_layout`` normally symlinks config.yaml to the active
    # profile. Windows CI/dev environments often lack the symlink privilege;
    # leave the regular file absent so the runtime can fall back cleanly and
    # never turn a failed symlink operation into a validation 400.
    _write(MIHOMO_DIR / "profiles" / "default.yaml", "proxies: []\n")
    _write(STATE_DIR / "ui-settings.json", DEFAULT_UI_SETTINGS)


def _ensure_dirs() -> None:
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    _seed_runtime_fixture()


def main() -> int:
    _ensure_dirs()

    env = os.environ.copy()
    # This process is exclusively a test server. Override potentially inherited
    # desktop/router variables so no E2E request can reach mutable user state.
    env["HOME"] = str(HOME_DIR)
    env["USERPROFILE"] = str(HOME_DIR)
    env["XDG_CONFIG_HOME"] = str(HOME_DIR / ".config")
    env["XKEEN_UI_STATE_DIR"] = str(STATE_DIR)
    env["XKEEN_LOG_DIR"] = str(LOG_DIR)
    env["XKEEN_UI_SECRET_KEY"] = "e2e-secret-key"
    env.setdefault("XKEEN_UI_PORT", str(env.get("XKEEN_E2E_PORT") or "18188"))
    env["XKEEN_RUNTIME"] = "dev"
    env["XKEEN_WS_RUNTIME"] = "1"
    env["XKEEN_XRAY_CONFIGS_DIR"] = str(XRAY_CONFIGS_DIR)
    env["XKEEN_XRAY_JSONC_DIR"] = str(XRAY_JSONC_DIR)
    env["XKEEN_XRAY_ROUTING_FILE"] = "05_routing.json"
    env["XKEEN_XRAY_INBOUNDS_FILE"] = "03_inbounds.json"
    env["XKEEN_XRAY_OUTBOUNDS_FILE"] = "04_outbounds.json"
    env["MIHOMO_ROOT"] = str(MIHOMO_DIR)

    cmd = [sys.executable, str(RUN_SERVER)]
    return subprocess.call(cmd, cwd=str(REPO_ROOT), env=env)


if __name__ == "__main__":
    raise SystemExit(main())
