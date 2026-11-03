"""The diagnostics window names the version of its own module.

The version is written into the module's own file: a module release may change only the
files of the module, so the build configuration cannot pass it in. This guard keeps that
file and module-versions.json from drifting apart.
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULE_ID = "tool.advanced-diagnostics"
VERSION_FILE = ROOT / "xkeen-ui" / "static" / "js" / "features" / "resource_monitor" / "version.js"
DASHBOARD_FILE = VERSION_FILE.with_name("dashboard.js")


def _declared_version() -> str:
    versions = json.loads((ROOT / "module-versions.json").read_text(encoding="utf-8"))
    return versions[MODULE_ID]


def test_version_file_matches_module_versions():
    text = VERSION_FILE.read_text(encoding="utf-8")
    match = re.search(r'export const MODULE_VERSION = "(\d+\.\d+\.\d+)";', text)
    assert match, "version.js должен экспортировать MODULE_VERSION как строку X.Y.Z"
    assert match.group(1) == _declared_version()


def test_window_takes_the_version_from_the_module_file():
    text = DASHBOARD_FILE.read_text(encoding="utf-8")
    assert 'import { MODULE_VERSION } from "./version.js";' in text
