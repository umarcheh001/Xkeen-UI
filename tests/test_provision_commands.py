"""Общий скрипт можно запустить командой — так его зовёт обновление из панели.

Установщик подключает `scripts/provision_env.sh` и вызывает его функции между
шагами своего экрана. У обновления из панели экрана нет: оно запускает тот же
файл с командой `prepare` (до первого изменённого файла — библиотеки) и
`apply` (после раскладки файлов — всё, что лежит вне каталога панели).
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
LIB = ROOT / "xkeen-ui" / "scripts" / "provision_env.sh"
TEMPLATE = ROOT / "xkeen-ui" / "scripts" / "panel_init.sh"
OUR_SERVICE = TEMPLATE.read_text(encoding="utf-8").replace("__XKEEN_UI_PORT__", "8091")

FAKE_PYTHON = """#!/bin/sh
echo "$*" >> "$FAKE_PY_LOG"
if [ "$1" = "-c" ]; then
  module="${2#import }"
  case " $FAKE_MODULES " in *" $module "*) exit 0 ;; esac
  exit 1
fi
[ "$1" = "-m" ] && [ "$2" = "pip" ] && exit 1
exit 0
"""


def _panel(tmp_path: Path, *, modules: tuple[str, ...] = ("core", "engine.xray", "tool.editor")) -> Path:
    ui = tmp_path / "xkeen-ui"
    (ui / "scripts").mkdir(parents=True)
    (ui / "scripts" / "provision_env.sh").write_bytes(LIB.read_bytes())
    (ui / "scripts" / "panel_init.sh").write_bytes(TEMPLATE.read_bytes())
    (ui / "tools").mkdir()
    (ui / "tools" / "sysmon_keenetic.sh").write_text("#!/bin/sh\n", encoding="utf-8")
    for folder, name in (("routing", "05_routing_base.jsonc"), ("observatory", "07_observatory_base.jsonc")):
        source = ui / "opt" / "etc" / "xray" / "templates" / folder
        source.mkdir(parents=True)
        (source / name).write_text("{ shipped }\n", encoding="utf-8")
    mihomo = ui / "opt" / "etc" / "mihomo" / "templates"
    mihomo.mkdir(parents=True)
    (mihomo / "custom.yaml").write_text("shipped\n", encoding="utf-8")
    (ui / "install-profile.json").write_text(
        json.dumps({"schema_version": 1, "profile": "custom", "module_ids": list(modules), "editor_variant": "light"}),
        encoding="utf-8",
    )
    return ui


def _run(tmp_path: Path, ui: Path, command: str, **env: str) -> subprocess.CompletedProcess:
    bin_dir = tmp_path / "fake-bin"
    bin_dir.mkdir(exist_ok=True)
    python = bin_dir / "python3"
    python.write_bytes(FAKE_PYTHON.encode("utf-8"))
    os.chmod(python, 0o755)
    for folder in ("bin", "init.d", "mihomo-templates", "dat", "sbin"):
        (tmp_path / folder).mkdir(exist_ok=True)
    return subprocess.run(
        ["sh", (ui / "scripts" / "provision_env.sh").as_posix(), command],
        capture_output=True,
        text=True,
        encoding="utf-8",
        env={
            **os.environ,
            "UI_DIR": ui.as_posix(),
            "PYTHON_BIN": python.as_posix(),
            "FAKE_PY_LOG": (tmp_path / "python.log").as_posix(),
            "FAKE_MODULES": "flask cryptography gevent geventwebsocket",
            "XKEEN_UI_BIN_DIR": (tmp_path / "bin").as_posix(),
            "XKEEN_UI_INIT_SCRIPT": (tmp_path / "init.d" / "S99xkeen-ui-umarcheh001").as_posix(),
            "XKEEN_UI_MIHOMO_TEMPLATES_DIR": (tmp_path / "mihomo-templates").as_posix(),
            "XKEEN_UI_XRAY_DAT_DIR": (tmp_path / "dat").as_posix(),
            "XKEEN_UI_XRAY_BIN_DIR": (tmp_path / "sbin").as_posix(),
            "XKEEN_UI_XRAY_CONFIG_DIR": (tmp_path / "configs").as_posix(),
            "XKEEN_UI_LEGACY_XRAY_TEMPLATES_DIR": (tmp_path / "legacy-templates").as_posix(),
            "TMPDIR": tmp_path.as_posix(),
            **env,
        },
    )


# --- apply ---------------------------------------------------------------------------


def test_apply_brings_what_lies_outside_the_panel_folder(tmp_path):
    ui = _panel(tmp_path)
    service = tmp_path / "init.d" / "S99xkeen-ui-umarcheh001"
    (tmp_path / "init.d").mkdir()
    service.write_text(OUR_SERVICE.replace("warm_bytecode_cache() {", "old_warm() {"), encoding="utf-8")

    proc = _run(tmp_path, ui, "apply")

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert (tmp_path / "bin" / "sysmon").is_file()
    assert (ui / "templates" / "routing" / "05_routing_base.jsonc").read_text(encoding="utf-8") == "{ shipped }\n"
    assert (ui / "templates" / "observatory" / "07_observatory_base.jsonc").is_file()
    # Служба заменена текстом из панели, порт остался прежним.
    assert service.read_bytes() == OUR_SERVICE.encode("utf-8")


def test_apply_installs_templates_only_of_installed_engines(tmp_path):
    ui = _panel(tmp_path, modules=("core", "engine.mihomo", "tool.editor"))

    proc = _run(tmp_path, ui, "apply")

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert (tmp_path / "mihomo-templates" / "custom.yaml").read_text(encoding="utf-8") == "shipped\n"
    assert not (ui / "templates" / "routing").exists()


def test_apply_never_writes_over_a_service_that_is_not_ours(tmp_path):
    ui = _panel(tmp_path)
    service = tmp_path / "init.d" / "S99xkeen-ui-umarcheh001"
    (tmp_path / "init.d").mkdir()
    service.write_text("#!/bin/sh\n# somebody else's panel\n", encoding="utf-8")

    proc = _run(tmp_path, ui, "apply")

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert service.read_text(encoding="utf-8") == "#!/bin/sh\n# somebody else's panel\n"


def test_apply_does_not_invent_a_service_when_there_is_none(tmp_path):
    ui = _panel(tmp_path)

    proc = _run(tmp_path, ui, "apply")

    # Службу заводит установщик: он знает порт. Обновление её только обновляет.
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert list((tmp_path / "init.d").iterdir()) == []


def test_apply_leaves_an_up_to_date_service_untouched(tmp_path):
    ui = _panel(tmp_path)
    service = tmp_path / "init.d" / "S99xkeen-ui-umarcheh001"
    (tmp_path / "init.d").mkdir()
    # Байтами: на Windows запись текстом подменила бы переводы строк.
    service.write_bytes(OUR_SERVICE.encode("utf-8"))
    os.utime(service, (1_600_000_000, 1_600_000_000))

    proc = _run(tmp_path, ui, "apply")

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert int(service.stat().st_mtime) == 1_600_000_000


# --- prepare -------------------------------------------------------------------------


def test_prepare_passes_when_the_libraries_are_there(tmp_path):
    ui = _panel(tmp_path)

    proc = _run(tmp_path, ui, "prepare")

    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_prepare_fails_with_the_reason_when_a_library_cannot_be_brought(tmp_path):
    ui = _panel(tmp_path)

    proc = _run(
        tmp_path, ui, "prepare",
        FAKE_MODULES="flask gevent geventwebsocket",
        PATH=(tmp_path / "fake-bin").as_posix() + os.pathsep + "/usr/bin" + os.pathsep + "/bin",
    )

    assert proc.returncode != 0
    # Последняя строка с «[!]» — причина, которую обновление покажет в панели.
    reasons = [line for line in proc.stdout.splitlines() if line.startswith("[!]")]
    assert reasons and ("Entware" in reasons[-1] or "opkg" in reasons[-1])


# --- сам режим команды ---------------------------------------------------------------


def test_sourcing_the_script_runs_nothing(tmp_path):
    ui = _panel(tmp_path)
    script = tmp_path / "source.sh"
    script.write_bytes(f'. "{(ui / "scripts" / "provision_env.sh").as_posix()}"\necho sourced\n'.encode("utf-8"))

    proc = subprocess.run(
        ["sh", script.as_posix(), "apply"], capture_output=True, text=True, encoding="utf-8",
        env={**os.environ, "UI_DIR": ui.as_posix(), "XKEEN_UI_BIN_DIR": (tmp_path / "bin").as_posix()},
    )

    assert proc.stdout.strip() == "sourced"
    assert not (tmp_path / "bin").exists()


def test_an_unknown_command_is_refused(tmp_path):
    ui = _panel(tmp_path)

    proc = _run(tmp_path, ui, "destroy")

    assert proc.returncode == 2
