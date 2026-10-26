from __future__ import annotations

import importlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from flask import Flask


ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "xkeen-ui"

if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))


def _reload(name: str):
    module = sys.modules.get(name)
    if module is not None:
        return importlib.reload(module)
    return importlib.import_module(name)


class SelfUpdateStatusRecoveryTests(unittest.TestCase):
    def test_try_acquire_lock_reclaims_stale_lock(self):
        state = _reload("services.self_update.state")

        with tempfile.TemporaryDirectory() as tmp:
            lock_file = Path(tmp) / "lock"
            lock_file.write_text(json.dumps({"pid": -1, "created_ts": time.time()}), encoding="utf-8")

            acquired, info = state.try_acquire_lock(str(lock_file))

            self.assertTrue(acquired)
            self.assertTrue(info["exists"])
            self.assertTrue(info["alive"])
            self.assertFalse(info["stale"])

            refreshed = state.read_lock(str(lock_file))
            self.assertTrue(refreshed["exists"])
            self.assertTrue(refreshed["alive"])
            self.assertFalse(refreshed["stale"])

    def test_concurrent_stale_lock_takeover_has_one_winner(self):
        state = _reload("services.self_update.state")

        with tempfile.TemporaryDirectory() as tmp:
            lock_file = Path(tmp) / "lock"
            lock_file.write_text(
                json.dumps({"pid": -1, "created_ts": time.time()}),
                encoding="utf-8",
            )
            barrier = threading.Barrier(8)
            results = []

            def acquire():
                barrier.wait()
                results.append(state.try_acquire_lock(str(lock_file))[0])

            threads = [threading.Thread(target=acquire) for _ in range(8)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=5)

            self.assertFalse(any(thread.is_alive() for thread in threads))
            self.assertEqual(results.count(True), 1)
            self.assertEqual(results.count(False), 7)

    def test_lock_transfer_and_stale_takeover_are_mutually_exclusive(self):
        state = _reload("services.self_update.state")

        with tempfile.TemporaryDirectory() as tmp:
            lock_file = Path(tmp) / "lock"
            for _attempt in range(16):
                lock_file.write_text(
                    json.dumps({"pid": -1, "created_ts": time.time()}),
                    encoding="utf-8",
                )
                barrier = threading.Barrier(2)
                outcomes = []

                def transfer():
                    barrier.wait()
                    outcomes.append(state.transfer_lock(str(lock_file), -1))

                def reclaim():
                    barrier.wait()
                    outcomes.append(state.try_acquire_lock(str(lock_file))[0])

                threads = [
                    threading.Thread(target=transfer),
                    threading.Thread(target=reclaim),
                ]
                for thread in threads:
                    thread.start()
                for thread in threads:
                    thread.join(timeout=5)

                self.assertFalse(any(thread.is_alive() for thread in threads))
                self.assertEqual(outcomes.count(True), 1)
                self.assertEqual(outcomes.count(False), 1)

    def test_lock_transfer_waits_for_short_lived_process_guard(self):
        state = _reload("services.self_update.state")

        with tempfile.TemporaryDirectory() as tmp:
            lock_file = Path(tmp) / "lock"
            ready_file = Path(tmp) / "guard-ready"
            lock_file.write_text(
                json.dumps({"pid": os.getpid(), "created_ts": time.time()}),
                encoding="utf-8",
            )
            script = """
import os
import sys
import time

guard_path, ready_path = sys.argv[1:3]
fd = os.open(guard_path, os.O_CREAT | os.O_RDWR, 0o600)
if os.name == "nt":
    import msvcrt
    if os.fstat(fd).st_size == 0:
        os.write(fd, b"0")
    os.lseek(fd, 0, os.SEEK_SET)
    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
else:
    import fcntl
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
with open(ready_path, "w", encoding="utf-8") as marker:
    marker.write("ready")
time.sleep(0.25)
"""
            blocker = subprocess.Popen(
                [sys.executable, "-c", script, str(lock_file) + ".guard", str(ready_file)]
            )
            try:
                deadline = time.monotonic() + 5
                while not ready_file.exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(ready_file.exists())

                self.assertTrue(state.transfer_lock(str(lock_file), os.getpid()))
            finally:
                blocker.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
