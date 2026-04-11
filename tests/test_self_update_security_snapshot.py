from __future__ import annotations

import importlib
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "xkeen-ui"

if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))


def _reload(name: str):
    module = sys.modules.get(name)
    if module is not None:
        return importlib.reload(module)
    return importlib.import_module(name)


class SelfUpdateSecuritySnapshotTests(unittest.TestCase):
    def test_security_snapshot_uses_defaults_without_missing_imports(self):
        security = _reload("services.self_update.security")
        with patch.dict(os.environ, {}, clear=True):
            snapshot = security.security_snapshot()

        self.assertEqual(snapshot["allow_http"], "0")
        self.assertEqual(snapshot["max_bytes"], "62914560")
        self.assertEqual(snapshot["max_checksum_bytes"], "1048576")
        self.assertEqual(snapshot["api_timeout"], "10")
        self.assertEqual(snapshot["sha_strict"], "1")
        self.assertEqual(snapshot["require_sha"], "1")
        self.assertIn("github.com", snapshot["allow_hosts"])


if __name__ == "__main__":
    unittest.main()
