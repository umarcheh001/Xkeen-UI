"""Диагностика отвала WebSocket-рантайма.

Регрессия 06.09.2026: у колеса gevent на роутере было обрезано имя одного `.so`
(`..._greenlet_primitives.cpython-313-aarch64-linux-gnu.s` вместо `.so`).
`pip list` показывал пакет установленным, `pip install` отвечал «Requirement already
satisfied», `run_server.py` глотал ошибку импорта в `except` и молча поднимал панель
под Werkzeug. Наружу это выглядело только как пустое окно lite-терминала.
"""

from __future__ import annotations

import importlib.util
import base64
import hashlib
import os
import json
import subprocess
import sys
from pathlib import Path

import pytest
from scripts.panel_template_source import compose_panel_template

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


@pytest.mark.parametrize("damage", [None, "hash", "size", "no_hash"])
def test_repair_restores_truncated_names_only_when_record_size_and_hash_match(tmp_path, damage):
    valid = damage is None
    expected = "gevent/_gevent_c_greenlet_primitives.cpython-313-aarch64-linux-gnu.so"
    site = _make_site_packages(tmp_path, files={expected[:-1]: "elf"}, record=[expected])
    digest = base64.urlsafe_b64encode(hashlib.sha256(b"elf").digest()).decode().rstrip("=")
    record = site / "gevent-25.9.1.dist-info/RECORD"
    record.write_bytes(f"{expected},sha256={digest},3\n".encode())
    content = {None: b"elf", "hash": b"bad", "size": b"short", "no_hash": b"elf"}[damage]
    (site / expected[:-1]).write_bytes(content)
    if damage == "no_hash":
        record.write_bytes(f"{expected},,3\n".encode())

    proc = subprocess.run(
        [sys.executable, str(CHECKER_PATH), "--site-packages", str(site), "--repair", "gevent"],
        capture_output=True,
    )

    assert proc.returncode == (0 if valid else 1), proc.stderr
    assert (site / expected).exists() is valid
    assert (site / expected[:-1]).exists() is not valid
    assert (site / (expected if valid else expected[:-1])).read_bytes() == content


def test_installer_repairs_a_truncated_package_before_attempting_network_install(tmp_path):
    expected = "gevent/extension.so"
    site = _make_site_packages(tmp_path, files={expected[:-1]: "elf"}, record=[expected])
    digest = base64.urlsafe_b64encode(hashlib.sha256(b"elf").digest()).decode().rstrip("=")
    (site / "gevent-25.9.1.dist-info/RECORD").write_bytes(f"{expected},sha256={digest},3\n".encode())
    (site / "gevent/__init__.py").write_bytes(
        b"from pathlib import Path\nassert Path(__file__).with_name('extension.so').is_file()\n"
    )
    for module in ("flask", "cryptography", "yaml", "geventwebsocket"):
        (site / (module + ".py")).write_bytes(b"")
    (site / "sitecustomize.py").write_bytes(
        b"import os, sysconfig\noriginal = sysconfig.get_paths\n"
        b"def paths(*a, **kw):\n    result = original(*a, **kw)\n"
        b"    result['purelib'] = os.environ['REPAIR_TEST_SITE']\n    return result\n"
        b"sysconfig.get_paths = paths\n"
    )
    script = tmp_path / "install.sh"
    script.write_bytes((
        'set -e\n'
        f'. "{(ROOT / "xkeen-ui/scripts/provision_env.sh").as_posix()}"\n'
        f'PYTHON_BIN="{Path(sys.executable).as_posix()}"\n'
        f'SRC_DIR="{(ROOT / "xkeen-ui").as_posix()}"\n'
        f'UI_DIR="{tmp_path.as_posix()}"\n'
        'WANT_GEVENT=1; ARCH=aarch64\n'
        'provision_opkg_update() { echo unexpected-network; return 1; }\n'
        'provision_python_libs_check\nprovision_python_libs_install\n'
        'echo "gevent=$NEED_GEVENT ws=$WS_VERDICT"\n'
    ).encode())
    proc = subprocess.run(["sh", script.as_posix()], capture_output=True, env={
        **os.environ, "PYTHONPATH": str(site), "REPAIR_TEST_SITE": str(site),
    })

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert b"gevent=0 ws=on" in proc.stdout
    assert b"unexpected-network" not in proc.stdout
    assert (site / expected).read_bytes() == b"elf"


def test_repair_does_not_follow_a_truncated_symlink_outside_site_packages(tmp_path):
    checker = _load_checker()
    site = _make_site_packages(tmp_path, files={}, record=["gevent/code.so"])
    outside = tmp_path / "outside"
    outside.write_bytes(b"elf")
    try:
        (site / "gevent").mkdir()
        (site / "gevent/code.s").symlink_to(outside)
    except OSError:
        pytest.skip("symlinks unavailable")
    digest = base64.urlsafe_b64encode(hashlib.sha256(b"elf").digest()).decode().rstrip("=")
    (site / "gevent-25.9.1.dist-info/RECORD").write_bytes(f"gevent/code.so,sha256={digest},3\n".encode())

    assert checker.repair_truncated_files(site, "gevent") == []
    assert not (site / "gevent/code.so").exists()
    assert outside.read_bytes() == b"elf"


def test_repair_does_not_rename_another_file_listed_in_record(tmp_path):
    checker = _load_checker()
    site = _make_site_packages(tmp_path, files={"gevent/code.s": "elf"}, record=[])
    digest = base64.urlsafe_b64encode(hashlib.sha256(b"elf").digest()).decode().rstrip("=")
    (site / "gevent-25.9.1.dist-info/RECORD").write_bytes((
        f"gevent/code.so,sha256={digest},3\n./gevent/code.s,sha256={digest},3\n"
    ).encode())

    assert checker.repair_truncated_files(site, "gevent") == []
    assert (site / "gevent/code.s").read_bytes() == b"elf"
    assert not (site / "gevent/code.so").exists()


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


def test_mihomo_minimal_starts_the_websocket_server_without_terminal_module():
    text = (ROOT / "xkeen-ui" / "run_server.py").read_text(encoding="utf-8")
    app_text = (ROOT / "xkeen-ui" / "app.py").read_text(encoding="utf-8")
    registry_text = (ROOT / "xkeen-ui" / "services" / "module_registry.py").read_text(encoding="utf-8")

    assert '_WS_RUNTIME_MODULES = frozenset(' in text
    assert '"core"' in text
    assert '"engine.mihomo"' in text
    assert '"engine.xray"' in text
    assert "_WS_RUNTIME_NEEDED = bool(_ACTIVE_MODULES.intersection(_WS_RUNTIME_MODULES))" in text
    assert "if GEVENT_AVAILABLE and _WS_RUNTIME_NEEDED:" in text
    assert 'if GEVENT_AVAILABLE and "tool.terminal" in _ACTIVE_MODULES and path == "/ws/command-status"' not in text
    assert 'if GEVENT_AVAILABLE and path == "/ws/command-status":' in text
    assert '{"core", "engine.xray", "engine.mihomo", "tool.advanced-diagnostics"}' in text
    assert "from services.command_jobs import get_command_job as _get_command_job" in app_text
    assert '"/ws/command-status": "core"' in registry_text


def test_terminal_window_has_a_place_to_show_the_websocket_warning():
    text = compose_panel_template(ROOT)

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
    # Библиотеки ставит общий скрипт, установщик его вызывает: читаем оба.
    return "\n".join(
        (ROOT / "xkeen-ui" / name).read_text(encoding="utf-8")
        for name in ("install.sh", "scripts/provision_env.sh")
    )


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
    assert "потоковые функции панели доступны" in text
    assert "если установлен модуль терминала" in text
    assert "Итог установки" in text
