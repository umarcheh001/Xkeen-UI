"""Список пакетов Entware не может подвесить установку.

`opkg update` качает списки с зеркала, записанного в настройках роутера, и ждёт
его без ограничения. На роутере с нестабильным зеркалом установка панели висела
десять минут без единой строки на экране. Теперь у запроса есть предел времени,
а если зеркало не ответило, списки берутся один раз с официального источника —
через временный файл настроек, настройки самого роутера не меняются.
"""

from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
LIB = ROOT / "xkeen-ui" / "scripts" / "provision_env.sh"

MIRROR_CONF = """src/gz entware http://mirrors.example.invalid/entware/aarch64-k3.10
src/gz keendev http://mirrors.example.invalid/entware/aarch64-k3.10/keenetic
dest root /
lists_dir ext /opt/var/opkg-lists
arch all 100
arch aarch64-3.10 150
"""
OFFICIAL_CONF = MIRROR_CONF.replace("http://mirrors.example.invalid/entware/", "http://bin.entware.net/")

# Подставной opkg: что делать, говорит FAKE_OPKG, вызовы пишутся в журнал.
FAKE_OPKG = """#!/bin/sh
echo "$*" >> "$FAKE_LOG"
with_conf=0
for arg in "$@"; do [ "$arg" = "-f" ] && with_conf=1; done
case "$FAKE_OPKG:$with_conf" in
  ok:*) exit 0 ;;
  fail:*) exit 1 ;;
  hang:0) exec sleep 30 ;;
  hang:1) exit 0 ;;
  hang-always:*) exec sleep 30 ;;
  fail-mirror:0) exit 1 ;;
  fail-mirror:1) exit 0 ;;
  partial:*) mkdir -p "$FAKE_LISTS"; echo "Package: python3" > "$FAKE_LISTS/entware"; exit 2 ;;
  children:*) sh -c 'sleep 30 & echo $! > "$FAKE_CHILD"; wait' & wait ;;
  litter:*) mkdir -p "$FAKE_TMP/opkg-$$"; echo x > "$FAKE_TMP/opkg-$$/list"; exec sleep 30 ;;
  stubborn:*) sh -c 'trap "" TERM; sleep 30 & echo $! > "$FAKE_CHILD"; wait' & wait ;;
esac
exit 0
"""


@pytest.fixture
def stand(tmp_path):
    opkg = tmp_path / "opkg"
    opkg.write_bytes(FAKE_OPKG.encode("utf-8"))
    os.chmod(opkg, 0o755)
    conf = tmp_path / "opkg.conf"
    conf.write_text(MIRROR_CONF, encoding="utf-8")
    return tmp_path, opkg, conf


def _run(stand, body: str, mode: str, **env: str) -> tuple[subprocess.CompletedProcess, list[str], float]:
    tmp_path, opkg, conf = stand
    log = tmp_path / "opkg.log"
    script = tmp_path / "call.sh"
    script.write_bytes(
        "\n".join(["set -e", f'. "{LIB.as_posix()}"', f'OPKG_BIN="{opkg.as_posix()}"', body, ""]).encode("utf-8")
    )
    started = time.monotonic()
    proc = subprocess.run(
        ["sh", script.as_posix()],
        capture_output=True,
        text=True,
        encoding="utf-8",
        env={
            **os.environ,
            "FAKE_OPKG": mode,
            "FAKE_LOG": log.as_posix(),
            "XKEEN_OPKG_CONF": conf.as_posix(),
            "XKEEN_OPKG_UPDATE_TIMEOUT": "2",
            "TMPDIR": tmp_path.as_posix(),
            **env,
        },
    )
    calls = log.read_text(encoding="utf-8").splitlines() if log.exists() else []
    return proc, calls, time.monotonic() - started


def test_a_mirror_that_answers_is_asked_once(stand):
    proc, calls, _elapsed = _run(stand, 'provision_opkg_update && echo "conf=[$PROVISION_OPKG_CONF]"', "ok")

    assert proc.returncode == 0, proc.stderr
    assert calls == ["update"]
    assert "conf=[]" in proc.stdout


def test_a_mirror_that_hangs_is_given_up_on_and_the_official_source_is_used(stand):
    tmp_path, _opkg, conf = stand

    # Содержимое печатает сама оболочка: её путь к временной папке на Windows
    # не тот, каким его видит Python.
    proc, calls, elapsed = _run(
        stand, 'provision_opkg_update && echo "conf=[$PROVISION_OPKG_CONF]" && cat "$PROVISION_OPKG_CONF"', "hang"
    )

    assert proc.returncode == 0, proc.stdout + proc.stderr
    # Предел — две секунды, а не тридцать, которые зеркало молчало бы.
    assert elapsed < 15
    assert calls[0] == "update" and calls[1].startswith("-f ") and calls[1].endswith(" update")
    assert "conf=[]" not in proc.stdout
    text = proc.stdout.split("conf=[", 1)[1].split("]\n", 1)[1]
    assert "src/gz entware http://bin.entware.net/aarch64-k3.10\n" in text
    assert "src/gz keendev http://bin.entware.net/aarch64-k3.10/keenetic\n" in text
    assert "mirrors.example.invalid" not in text
    assert "arch aarch64-3.10 150" in text
    # Свои списки, чтобы не подменять списки настроенного зеркала.
    assert "lists_dir ext /opt/var/opkg-lists" not in text
    # Настройки роутера не тронуты.
    assert conf.read_text(encoding="utf-8") == MIRROR_CONF
    assert "не ответил" in proc.stdout or "официальн" in proc.stdout


def test_packages_are_then_installed_from_the_source_that_answered(stand):
    proc, calls, _elapsed = _run(stand, "provision_opkg_update && provision_opkg install python3-cryptography", "hang")

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert calls[-1].startswith("-f ") and calls[-1].endswith(" install python3-cryptography")


def test_without_trouble_packages_are_installed_as_before(stand):
    proc, calls, _elapsed = _run(stand, "provision_opkg_update && provision_opkg install lftp", "ok")

    assert proc.returncode == 0, proc.stderr
    assert calls == ["update", "install lftp"]


def test_a_mirror_that_fails_at_once_is_replaced_too(stand):
    proc, calls, _elapsed = _run(stand, "provision_opkg_update", "fail-mirror")

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert len(calls) == 2 and calls[1].startswith("-f ")


def test_the_official_source_is_not_asked_twice(stand):
    _tmp_path, _opkg, conf = stand
    conf.write_text(OFFICIAL_CONF, encoding="utf-8")

    proc, calls, _elapsed = _run(stand, "provision_opkg_update || echo refused", "fail")

    assert "refused" in proc.stdout
    assert calls == ["update"]


def test_when_nothing_answers_the_failure_is_reported_in_time(stand):
    proc, calls, elapsed = _run(stand, "provision_opkg_update || echo refused", "hang-always")

    assert "refused" in proc.stdout
    assert elapsed < 20
    assert len(calls) == 2
    assert "mirrors.example.invalid" in proc.stdout


def test_the_owner_can_forbid_the_other_source(stand):
    proc, calls, _elapsed = _run(stand, "provision_opkg_update || echo refused", "fail-mirror", XKEEN_OPKG_FALLBACK="0")

    assert "refused" in proc.stdout
    assert calls == ["update"]


def test_the_temporary_settings_are_removed_afterwards(stand):
    tmp_path, _opkg, _conf = stand

    proc, _calls, _elapsed = _run(stand, "provision_opkg_update; provision_opkg_cleanup; echo done", "hang")

    assert "done" in proc.stdout
    assert not [path.name for path in tmp_path.iterdir() if path.name.startswith("xkeen-opkg")]


def test_a_dead_third_party_source_does_not_hide_that_entware_answered(stand):
    tmp_path, _opkg, conf = stand
    lists = tmp_path / "lists"
    conf.write_text(MIRROR_CONF.replace("/opt/var/opkg-lists", lists.as_posix()), encoding="utf-8")

    proc, calls, _elapsed = _run(
        stand, 'provision_opkg_update && echo "conf=[$PROVISION_OPKG_CONF]"', "partial", FAKE_LISTS=lists.as_posix()
    )

    # opkg ответил ошибкой из-за стороннего источника, но список Entware свежий:
    # это не повод ни останавливаться, ни идти к другому источнику.
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert calls == ["update"]
    assert "conf=[]" in proc.stdout


def test_an_old_list_does_not_pass_for_a_fresh_one(stand):
    tmp_path, _opkg, conf = stand
    lists = tmp_path / "lists"
    lists.mkdir()
    stale = lists / "entware"
    stale.write_text("Package: python3\n", encoding="utf-8")
    os.utime(stale, (1_600_000_000, 1_600_000_000))
    conf.write_text(MIRROR_CONF.replace("/opt/var/opkg-lists", lists.as_posix()), encoding="utf-8")

    proc, calls, _elapsed = _run(stand, "provision_opkg_update || echo refused", "fail", XKEEN_OPKG_FALLBACK="0")

    assert "refused" in proc.stdout
    assert calls == ["update"]


def _state_of_what_the_hung_command_started(stand, mode: str) -> str:
    tmp_path, _opkg, _conf = stand
    child = tmp_path / "child.pid"

    proc, calls, elapsed = _run(
        stand,
        'provision_run_limited 2 "$OPKG_BIN" update && echo "rc=0" || echo "rc=$?"; sleep 1; '
        # Не `kill -0`: снятый процесс, которого ещё никто не забрал, на Linux
        # числится существующим. Смотрим состояние: нет записи или «Z» — снят.
        f'state="$(cat "/proc/$(cat "{child.as_posix()}")/stat" 2>/dev/null || true)"; echo "state=[$state]"; '
        'case "$state" in ""|*") Z "*) echo gone ;; *) echo alive ;; esac',
        mode,
        FAKE_CHILD=child.as_posix(),
    )

    # Тест пропускается на Windows, и разбирать его приходится по журналу сервера:
    # всё, что нужно для разбора, должно быть в самом сообщении.
    report = "\n".join([proc.stdout, f"stderr: {proc.stderr}", f"calls: {calls}, elapsed: {elapsed:.1f}"])
    assert "rc=124" in proc.stdout, report
    return report


@pytest.mark.skipif(os.name == "nt", reason="дерево процессов проверяется на Linux")
def test_what_the_hung_command_started_is_stopped_with_it(stand):
    report = _state_of_what_the_hung_command_started(stand, "children")

    assert "gone" in report, report


@pytest.mark.skipif(os.name == "nt", reason="дерево процессов проверяется на Linux")
def test_what_ignores_the_polite_request_is_stopped_all_the_same(stand):
    # Вежливую просьбу завершиться процесс вправе не услышать: загрузка, которую
    # запустил зависший запрос, не должна после этого остаться висеть.
    report = _state_of_what_the_hung_command_started(stand, "stubborn")

    assert "gone" in report, report


def test_a_request_that_was_cut_off_does_not_leave_its_temporary_folder(stand):
    tmp_path, _opkg, _conf = stand
    scratch = tmp_path / "opkg-tmp"
    earlier = scratch / "opkg-earlier"
    earlier.mkdir(parents=True)

    proc, calls, _elapsed = _run(
        stand,
        "provision_opkg_update || echo refused",
        "litter",
        FAKE_TMP=scratch.as_posix(),
        XKEEN_OPKG_TMP_DIR=scratch.as_posix(),
        XKEEN_OPKG_FALLBACK="0",
    )

    assert "refused" in proc.stdout, proc.stdout + proc.stderr
    assert calls == ["update"]
    # Снятый opkg свой каталог не убирает: за него это делает тот, кто снял.
    # Чужой каталог, лежавший там раньше, остаётся.
    assert sorted(path.name for path in scratch.iterdir()) == ["opkg-earlier"]


def test_the_temporary_folder_of_opkg_is_read_from_its_settings(stand):
    tmp_path, _opkg, conf = stand
    conf.write_text(MIRROR_CONF + "option tmp_dir /somewhere/else\n", encoding="utf-8")

    proc, _calls, _elapsed = _run(stand, f'provision_opkg_tmp_dir "{conf.as_posix()}"', "ok")

    assert proc.stdout.strip() == "/somewhere/else"
