"""Проба `tar --exclude` не должна запускаться на каждый запрос панели.

`/api/devtools/update/info` дёргается при каждой загрузке страницы, а проба
создаёт временный каталог и запускает настоящий `tar -czf`. На роутере это
секунды и лишняя запись во флеш при каждом открытии панели.
"""

from __future__ import annotations

import importlib
import os
import sys
import tempfile
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


class _OkProcess:
    returncode = 0
    stderr = ""


class TarExcludeProbeCacheTests(unittest.TestCase):
    def setUp(self):
        self.devtools = _reload("routes.devtools")
        self.tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmpdir.cleanup)
        self.tar_bin = os.path.join(self.tmpdir.name, "tar")
        with open(self.tar_bin, "w", encoding="utf-8") as handle:
            handle.write("#!/bin/sh\n")

    def _run_probe(self, calls: list, which_result: str | None = None):
        def fake_run(*args, **kwargs):
            calls.append(args[0] if args else None)
            return _OkProcess()

        with patch.object(
            self.devtools.shutil, "which", return_value=which_result or self.tar_bin
        ), patch.object(self.devtools.subprocess, "run", fake_run):
            return self.devtools._tar_supports_exclude()

    def test_probe_runs_tar_only_once_for_repeated_calls(self):
        calls: list = []

        first = self._run_probe(calls)
        second = self._run_probe(calls)
        third = self._run_probe(calls)

        self.assertTrue(first)
        self.assertTrue(second)
        self.assertTrue(third)
        self.assertEqual(len(calls), 1, "tar должен запускаться один раз на процесс")

    def test_probe_runs_again_when_tar_binary_changes(self):
        calls: list = []
        self._run_probe(calls)

        other_bin = os.path.join(self.tmpdir.name, "tar-full")
        with open(other_bin, "w", encoding="utf-8") as handle:
            handle.write("#!/bin/sh\n")

        # Пользователь поставил полноценный tar (`opkg install tar`) — панель
        # обязана увидеть это без перезапуска.
        self._run_probe(calls, which_result=other_bin)

        self.assertEqual(len(calls), 2)

    def test_update_info_endpoint_does_not_spawn_tar_on_every_request(self):
        calls: list = []

        def fake_run(*args, **kwargs):
            calls.append(args[0] if args else None)
            return _OkProcess()

        app = Flask("devtools-tar-probe-cache")
        app.register_blueprint(self.devtools.create_devtools_blueprint(self.tmpdir.name))

        with patch.object(
            self.devtools.shutil, "which", return_value=self.tar_bin
        ), patch.object(self.devtools.subprocess, "run", fake_run), patch.object(
            self.devtools, "get_build_info", return_value={"version": "1.0.0"}
        ), patch.object(
            self.devtools, "security_snapshot", return_value={}
        ):
            client = app.test_client()
            for _ in range(5):
                response = client.get("/api/devtools/update/info")
                self.assertEqual(response.status_code, 200)
                self.assertTrue(response.get_json()["capabilities"]["tar_exclude"])

        self.assertEqual(len(calls), 1, "пять загрузок панели — одна проба tar")


if __name__ == "__main__":
    unittest.main()
