"""Диагностика отвала WebSocket-рантайма.

Регрессия 06.09.2026: у колеса gevent на роутере было обрезано имя одного `.so`
(`..._greenlet_primitives.cpython-313-aarch64-linux-gnu.s` вместо `.so`).
`pip list` показывал пакет установленным, `pip install` отвечал «Requirement already
satisfied», `run_server.py` глотал ошибку импорта в `except` и молча поднимал панель
под Werkzeug. Наружу это выглядело только как пустое окно lite-терминала.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
CHECKER_PATH = ROOT / "xkeen-ui" / "scripts" / "check_pydeps_integrity.py"


def _load_checker():
    spec = importlib.util.spec_from_file_location("check_pydeps_integrity", CHECKER_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _make_site_packages(tmp_path: Path, *, files: dict[str, str], record: list[str]) -> Path:
    """Собирает минимальный site-packages с dist-info/RECORD."""

    site = tmp_path / "site-packages"
    dist_info = site / "gevent-25.9.1.dist-info"
    dist_info.mkdir(parents=True)

    for rel, content in files.items():
        target = site / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")

    lines = ["%s,sha256=deadbeef,%d" % (rel, 1) for rel in record]
    lines.append("gevent-25.9.1.dist-info/RECORD,,")
    (dist_info / "RECORD").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (dist_info / "METADATA").write_text("Name: gevent\nVersion: 25.9.1\n", encoding="utf-8")
    return site


# --- Пункт 2: проверка целостности колеса по RECORD ---------------------------------


def test_record_check_finds_file_listed_in_record_but_missing_on_disk(tmp_path):
    checker = _load_checker()
    site = _make_site_packages(
        tmp_path,
        files={
            "gevent/__init__.py": "",
            "gevent/_gevent_c_greenlet_primitives.cpython-313-aarch64-linux-gnu.s": "elf",
        },
        record=[
            "gevent/__init__.py",
            "gevent/_gevent_c_greenlet_primitives.cpython-313-aarch64-linux-gnu.so",
        ],
    )

    report = checker.check_record_integrity(site, "gevent")

    assert report["status"] == "broken"
    assert report["missing"] == [
        "gevent/_gevent_c_greenlet_primitives.cpython-313-aarch64-linux-gnu.so"
    ]


def test_record_check_names_the_truncated_file_that_shadows_the_missing_one(tmp_path):
    checker = _load_checker()
    site = _make_site_packages(
        tmp_path,
        files={
            "gevent/__init__.py": "",
            "gevent/_gevent_c_greenlet_primitives.cpython-313-aarch64-linux-gnu.s": "elf",
        },
        record=[
            "gevent/__init__.py",
            "gevent/_gevent_c_greenlet_primitives.cpython-313-aarch64-linux-gnu.so",
        ],
    )

    report = checker.check_record_integrity(site, "gevent")

    assert report["truncated"] == {
        "gevent/_gevent_c_greenlet_primitives.cpython-313-aarch64-linux-gnu.so": (
            "gevent/_gevent_c_greenlet_primitives.cpython-313-aarch64-linux-gnu.s"
        )
    }


def test_record_check_passes_when_every_recorded_file_exists(tmp_path):
    checker = _load_checker()
    site = _make_site_packages(
        tmp_path,
        files={"gevent/__init__.py": "", "gevent/core.py": ""},
        record=["gevent/__init__.py", "gevent/core.py"],
    )

    report = checker.check_record_integrity(site, "gevent")

    assert report["status"] == "ok"
    assert report["missing"] == []


def test_record_check_reports_missing_metadata_instead_of_failing(tmp_path):
    checker = _load_checker()
    site = tmp_path / "site-packages"
    site.mkdir()

    report = checker.check_record_integrity(site, "gevent")

    assert report["status"] == "missing_metadata"


def test_record_check_ignores_pycache_entries_python_removes_on_its_own(tmp_path):
    checker = _load_checker()
    site = _make_site_packages(
        tmp_path,
        files={"gevent/__init__.py": ""},
        record=["gevent/__init__.py", "gevent/__pycache__/__init__.cpython-313.pyc"],
    )

    report = checker.check_record_integrity(site, "gevent")

    assert report["status"] == "ok"


def test_record_check_cli_exits_nonzero_and_prints_the_broken_package(tmp_path):
    site = _make_site_packages(
        tmp_path,
        files={"gevent/__init__.py": ""},
        record=["gevent/__init__.py", "gevent/missing.so"],
    )

    proc = subprocess.run(
        [sys.executable, str(CHECKER_PATH), "--site-packages", str(site), "--json", "gevent"],
        capture_output=True,
        text=True,
    )

    assert proc.returncode == 1
    payload = json.loads(proc.stdout)
    assert payload["gevent"]["missing"] == ["gevent/missing.so"]


def test_record_check_cli_is_quiet_and_green_for_a_healthy_package(tmp_path):
    site = _make_site_packages(
        tmp_path,
        files={"gevent/__init__.py": ""},
        record=["gevent/__init__.py"],
    )

    proc = subprocess.run(
        [sys.executable, str(CHECKER_PATH), "--site-packages", str(site), "gevent"],
        capture_output=True,
        text=True,
    )

    assert proc.returncode == 0


# --- Пункт 1: панель не деградирует молча -------------------------------------------


def test_terminal_state_reports_why_websocket_runtime_is_unavailable():
    from services import capabilities as caps_mod

    state = caps_mod.detect_terminal_state(
        {"XKEEN_WS_ERROR": "ModuleNotFoundError: No module named 'gevent._gevent_c_greenlet_primitives'"},
        runtime_mode="router",
        ws_runtime=False,
    )

    assert state["reason"] == "ws_unavailable"
    assert "gevent._gevent_c_greenlet_primitives" in state["ws_error"]


def test_terminal_state_keeps_ws_error_empty_while_websocket_runtime_is_alive():
    from services import capabilities as caps_mod

    state = caps_mod.detect_terminal_state({}, runtime_mode="dev", ws_runtime=True)

    assert state["reason"] is None
    assert state["ws_error"] is None


def test_app_module_keeps_the_gevent_import_error_instead_of_swallowing_it():
    text = (ROOT / "xkeen-ui" / "app.py").read_text(encoding="utf-8")

    assert "GEVENT_IMPORT_ERROR" in text
    assert "except Exception as exc:" in text
    assert "GEVENT_IMPORT_ERROR = " in text


def test_run_server_logs_the_gevent_failure_and_publishes_it_for_capabilities():
    text = (ROOT / "xkeen-ui" / "run_server.py").read_text(encoding="utf-8")

    assert "GEVENT_IMPORT_ERROR" in text
    assert "traceback.format_exc()" in text
    assert 'os.environ["XKEEN_WS_ERROR"]' in text
    assert "WebSocket-рантайм недоступен" in text
    assert "file=sys.stderr" in text


def test_terminal_window_has_a_place_to_show_the_websocket_warning():
    text = (ROOT / "xkeen-ui" / "templates" / "panel.html").read_text(encoding="utf-8")

    assert 'id="terminal-ws-notice"' in text
    assert 'class="terminal-ws-notice hidden"' in text


def test_capabilities_js_fills_the_warning_from_the_backend_reason():
    text = (ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "capabilities.js").read_text(
        encoding="utf-8"
    )

    assert "function pickWsDiagnostics(data)" in text
    assert "WS_REASON" in text
    assert "WS_ERROR" in text
    assert "function applyWsNotice()" in text
    assert "byId('terminal-ws-notice')" in text
    assert "ws_unavailable" in text


# --- Пункты 3 и 4: установщик ------------------------------------------------------


def _install_sh() -> str:
    return (ROOT / "xkeen-ui" / "install.sh").read_text(encoding="utf-8")


def test_install_script_repairs_a_package_that_pip_thinks_is_already_installed():
    text = _install_sh()

    assert "python_module_installed_but_broken() {" in text
    assert '"$PYTHON_BIN" -m pip show "$PKG" >/dev/null 2>&1 || return 1' in text
    assert 'pip_install_with_fallback "gevent-repair" --force-reinstall --no-deps' in text
    assert "Переустанавливаю его принудительно" in text


def test_install_script_verifies_wheel_integrity_before_blaming_the_network():
    text = _install_sh()

    assert "check_pydeps_integrity.py" in text
    assert "verify_python_package_files() {" in text


def test_install_script_prints_a_final_summary_of_the_websocket_verdict():
    text = _install_sh()

    assert 'INSTALL_LOG="${XKEEN_INSTALL_LOG:-/opt/var/log/xkeen-ui-install.log}"' in text
    assert "log_install() {" in text
    assert "log_install \"[=] WebSocket: ВКЛ" in text
    assert "log_install \"[=] WebSocket: ВЫКЛ" in text
    assert "Итог установки" in text
