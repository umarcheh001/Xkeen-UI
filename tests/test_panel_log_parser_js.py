"""Разбор логов панели для экрана DevTools → «Логи панели».

Строки — настоящие, с роутера 45.1 (23.10.2026), кроме отмеченных «пример».
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
MODULE = "./xkeen-ui/static/js/features/panel_log_parser.js"


def run_js(body: str, data) -> object:
    if shutil.which("node") is None:
        pytest.skip("node is not available in this environment")
    script = f"""
    import * as parser from '{MODULE}';
    const data = {json.dumps(data, ensure_ascii=False)};
    const out = (() => {{ {body} }})();
    console.log(JSON.stringify(out));
    """
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT,
        check=True,
        capture_output=True,
        encoding="utf-8",
    )
    return json.loads(result.stdout)


def build(kind: str, lines: list[str], fold: bool = True) -> list[dict]:
    return run_js("return parser.buildPanelLogRecords(data.kind, data.lines, { fold: data.fold });",
                  {"kind": kind, "lines": lines, "fold": fold})


DNS = (
    "{ts} [INFO] DNS-over-VLESS: правило устройств восстановлено — оно снова стоит первым, а было на месте 2. "
    "Событий прошивки за последние полторы минуты нет — вероятно, правила переставил сам XKeen. "
    "| event=dns_over_vless.capture_restored, repairs=jump, jump_was=2, "
    "above=-A PREROUTING -m set --match-set xkeen_deny_mac src -m comment --comment xkeen_rule -j RETURN, macs=8"
)
MEMORY = (
    "2026-09-17 22:12:04,003 [WARNING] memory guard reclaimed runtime memory | mode=auto, rss_before=59117568, "
    "rss_after=48656384, budget_bytes=258998272, available_bytes=26996736, collected=0, trimmed=True, "
    "cleared={'xray_logs': 1, 'mihomo': 0, 'geodat': 0, 'egress': 1}"
)


def test_panel_log_kind_follows_the_file_name():
    out = run_js("return data.map((n) => parser.panelLogKind(n));",
                 ["core", "core.1", "update", "restart", "stdout", "stderr", "xkeen-ui", "ws", "access"])
    assert out == ["core", "core", "update", "restart", "text", "text", "text", "core", "core"]


def test_core_line_is_split_into_time_level_source_message_and_parameters():
    rec = build("core", ["2026-10-02 15:37:46,664 [INFO] routing.save.async_restart | restart_job_id=a55a75049b2b, remote_addr=192.168.10.72"])[0]
    assert (rec["date"], rec["time"], rec["level"]) == ("2026-10-02", "15:37:46", "info")
    assert rec["source"] == "Маршрутизация"
    assert rec["msg"] == "routing.save.async_restart"
    assert rec["kv"] == [["restart_job_id", "a55a75049b2b"], ["remote_addr", "192.168.10.72"]]


def test_values_with_commas_inside_stay_whole():
    rec = build("core", [MEMORY])[0]
    assert rec["level"] == "warning"
    assert rec["source"] == "Память"
    assert dict(rec["kv"])["cleared"] == "{'xray_logs': 1, 'mihomo': 0, 'geodat': 0, 'egress': 1}"
    assert dict(rec["kv"])["trimmed"] == "True"


def test_sources_get_names_a_user_recognises():
    lines = [
        DNS.format(ts="2026-10-23 15:22:29,328"),
        "2026-10-23 17:05:10,982 [INFO] xkeen-ui init | pid=27779, ui_state_dir=/opt/etc/xkeen-ui, ws_runtime=False",
        "2026-09-18 21:01:14,938 [INFO] xray subscriptions auto-refresh | total=7, ok=7, restarted=True",
        "2026-09-18 23:00:42,422 [INFO] fileops.job_create | job_id=job_851e340abc54, op=delete, sources=2",
        "2026-09-18 22:59:04,649 [INFO] self_update: started runner | pid=12161, runner=/opt/etc/xkeen-ui/scripts/update_xkeen_ui.sh",
        "2026-10-02 14:52:28,289 [INFO] snapshot.delete_all | deleted=2, failed=0, remote_addr=192.168.10.14",
        "2026-09-17 21:43:25,173 [INFO] xkeen.stop | source=api-stop",
        "2026-10-07 18:02:53,897 [INFO] routing: automigrated json-with-comments to jsonc | main=/opt/etc/xray/configs/07_observatory.json",
        "2026-10-07 18:02:54,000 [INFO] fs.chmod | path=/opt/etc/x",
        "2026-10-07 18:02:55,000 [INFO] remotefs.upload | path=/x",
        "2026-10-07 18:02:56,000 [INFO] devtools.log_truncate | name=core",
        "2026-10-07 18:02:57,000 [WARNING] happ decryptor: no key for link | id=1",
    ]
    sources = [r["source"] for r in build("core", lines, fold=False)]
    assert sources == [
        "DNS-over-VLESS", "Запуск панели", "Подписки", "Файлы", "Обновление", "Снимки", "Xkeen",
        "Маршрутизация", "Файлы", "Файлы", "DevTools", "Утилита ссылок",
    ]


def test_the_same_line_in_a_row_folds_into_one_record_with_a_count():
    lines = [
        DNS.format(ts="2026-09-17 21:43:19,223"),
        DNS.format(ts="2026-09-17 21:43:49,410"),
        DNS.format(ts="2026-10-23 15:22:29,328"),
        "2026-10-23 16:59:51,000 [INFO] self_update: started runner | pid=24427",
        DNS.format(ts="2026-10-23 17:00:00,000"),
    ]
    recs = build("core", lines)
    assert [r["rep"] for r in recs] == [3, 1, 1]
    first = recs[0]
    # The row shows the latest time; the first one is kept for the detail.
    assert (first["date"], first["time"]) == ("2026-10-23", "15:22:29")
    assert (first["firstDate"], first["firstTime"]) == ("2026-09-17", "21:43:19")
    # A different line breaks the run: what came after is a new record.
    assert recs[2]["rep"] == 1

    unfolded = build("core", lines, fold=False)
    assert len(unfolded) == 5


def test_lines_that_differ_only_in_parameters_do_not_fold():
    lines = [
        "2026-09-17 21:39:14,639 [INFO] xkeen-ui init | pid=1854",
        "2026-09-17 21:54:26,986 [INFO] xkeen-ui init | pid=5620",
    ]
    assert [r["rep"] for r in build("core", lines)] == [1, 1]


def test_a_traceback_stays_with_its_line():
    # пример: формат _log_exception, строк Traceback на 45.1 нет
    lines = [
        "2026-10-22 18:20:05,003 [ERROR] xkeen.cmd_failed | cmd=xkeen -restart, rc=1",
        "Traceback (most recent call last):",
        '  File "/opt/etc/xkeen-ui/services/xkeen.py", line 412, in run_cmd',
        "    raise CommandFailed(rc, tail)",
        "services.xkeen.CommandFailed: rc=1",
        "2026-10-22 18:20:06,000 [INFO] xkeen.start | source=api",
    ]
    recs = build("core", lines)
    assert len(recs) == 2
    assert recs[0]["level"] == "error"
    assert recs[0]["extra"][0] == "Traceback (most recent call last):"
    assert len(recs[0]["extra"]) == 4
    assert recs[0]["raw"][0].startswith("2026-10-22 18:20:05,003")


def test_search_text_covers_parameters_and_traceback():
    lines = [
        "2026-10-22 18:20:05,003 [ERROR] xkeen.cmd_failed | cmd=xkeen -restart, rc=1",
        "services.xkeen.CommandFailed: Прокси-клиент не запущен",
    ]
    rec = build("core", lines)[0]
    assert "xkeen -restart" in rec["text"]
    assert "прокси-клиент не запущен" in rec["text"]


UPDATE = [
    "[2026-10-02T11:44:40Z] === Xkeen-UI updater start ===",
    "[2026-10-02T11:44:40Z] repo=umarcheh001/Xkeen-UI channel=stable action=update update_dir=/opt/var/lib/xkeen-ui/update backup_dir=/opt/var/backups/xkeen-ui",
    "[2026-10-02T11:44:41Z] [*] Backup: /opt/var/backups/xkeen-ui/xkeen-ui-20261002-114441.tgz",
    "[2026-10-02T11:44:47Z] [*] Latest tag: v2.9.1b",
    "[2026-10-02T11:44:51Z] [*] SHA256 OK",
    "[2026-10-02T11:44:54Z] [*] Running installer: /tmp/xkeen-ui-update.YaJJ9x/xkeen-ui/install.sh",
    "",
    "  ╔════════════════════════════════════════╗",
    "  01/05  Проверка окружения",
    "      ✓  Служба панели и каталоги  0 с",
    "  ✓  Xkeen UI обновлена и запущена",
    "[2026-10-02T11:45:04Z] [*] Restarting service via init.d: /opt/etc/init.d/S99xkeen-ui-umarcheh001",
    "Запущено, PID 9556.",
    "[2026-10-02T11:45:15Z] === Xkeen-UI updater done ===",
]


def test_update_log_becomes_one_record_per_run():
    recs = build("update", UPDATE)
    assert len(recs) == 1
    run = recs[0]
    assert (run["date"], run["time"]) == ("2026-10-02", "11:44:40")
    assert run["level"] == "ok"
    assert run["source"] == "Обновление панели"
    assert run["msg"] == "Панель обновлена до v2.9.1b"
    assert run["dur"] == "35 с"
    assert ["Канал", "stable"] in run["kv"]
    # The steps the updater announced, with their times; the installer's own
    # screen is kept but folded away.
    assert run["steps"][0] == ["11:44:41", "Backup: /opt/var/backups/xkeen-ui/xkeen-ui-20261002-114441.tgz"]
    assert len(run["steps"]) == 5
    assert "  01/05  Проверка окружения" in run["extra"]
    assert "" not in run["extra"]


def test_an_update_run_that_never_finished_is_an_error():
    # пример: обрыв после предупреждения
    lines = [
        "[2026-10-03T10:00:00Z] === Xkeen-UI updater start ===",
        "[2026-10-03T10:00:05Z] [*] Latest tag: v2.9.2",
        "[2026-10-03T10:00:09Z] [!] Не удалось скачать архив (rc=6). Проверь интернет/DNS/блокировки для URL с роутера.",
        *UPDATE,
    ]
    recs = build("update", lines)
    assert [r["level"] for r in recs] == ["error", "ok"]
    assert recs[0]["msg"] == "Обновление прервано: Не удалось скачать архив (rc=6). Проверь интернет/DNS/блокировки для URL с роутера."


RESTART = [
    "Прокси-клиент остановлен",
    "Выполнена смена ядра на Mihomo",
    "[2026-10-23 11:02:57] source=core-switch result=OK core=mihomo previous=xray",
    "[2026-10-23 15:01:40] source=dns-over-vless result=FAIL reason=port_53_busy",
    "[2026-10-23 15:21:26] source=xray-logs-enable result=OK loglevel=info xray_restarted=True",
    "core: Xray 26.9.1 started",
]


def test_restart_log_is_a_record_per_operation_with_its_output_folded_under_it():
    recs = build("restart", RESTART)
    assert [r["level"] for r in recs] == ["ok", "error", "ok", "info"]
    assert recs[0]["extra"] == ["Прокси-клиент остановлен", "Выполнена смена ядра на Mihomo"]
    assert recs[0]["kv"] == [["core", "mihomo"], ["previous", "xray"]]
    assert recs[2]["source"] == "Логи Xray"
    # Output with no result line yet: the operation is still running.
    assert recs[3]["msg"] == "вывод без итога"
    assert recs[3]["extra"] == ["core: Xray 26.9.1 started"]


def test_plain_text_logs_pick_up_times_tags_and_levels():
    lines = [
        "[install] Текущий порт панели: 8091",
        "[install] Текущий порт панели: 8091",
        "2026/10/23 17:05:10 [Warning] core: something",
        '192.168.10.14 - - [23/Oct/2026 17:05:10] "GET /api/devtools/logs HTTP/1.1" 200 -',
        "Traceback (most recent call last):",
        '  File "x.py", line 1, in <module>',
        "ValueError: boom",
    ]
    recs = build("text", lines)
    assert recs[0]["source"] == "install"
    assert recs[0]["rep"] == 2
    assert (recs[1]["date"], recs[1]["time"], recs[1]["level"]) == ("2026-10-23", "17:05:10", "warning")
    assert (recs[2]["time"], recs[2]["source"]) == ("17:05:10", "HTTP")
    assert recs[3]["level"] == "error"
    assert recs[3]["extra"] == ['  File "x.py", line 1, in <module>', "ValueError: boom"]


def test_line_endings_do_not_reach_the_parser():
    # The tail endpoint keeps line endings; a file copied through Windows has CRLF.
    recs = build("text", ["[install] Текущий порт панели: 8091\r\n", "[install] Текущий порт панели: 8091\n"])
    assert (recs[0]["source"], recs[0]["msg"], recs[0]["rep"]) == ("install", "Текущий порт панели: 8091", 2)


def test_every_record_has_a_stable_id_across_rebuilds():
    lines = [DNS.format(ts="2026-10-23 15:22:29,328"), MEMORY]
    a = [r["id"] for r in build("core", lines)]
    b = [r["id"] for r in build("core", lines + ["2026-10-23 18:00:00,000 [INFO] xkeen.start | source=api"])]
    assert b[: len(a)] == a
    assert len(set(b)) == len(b)


def test_day_label_names_today_and_yesterday():
    out = run_js(
        "const now = new Date(2026, 9, 23, 12, 0, 0);"
        "return ['2026-10-23', '2026-10-22', '2026-10-02', '2025-12-31', ''].map((d) => parser.panelLogDayLabel(d, now));",
        None,
    )
    assert out == ["Сегодня, 23 октября", "Вчера, 22 октября", "2 октября", "31 декабря 2025", ""]


# ---------- updates: history.jsonl of the Modules window (пример) ----------

STEPS = ["prepared", "downloading", "verifying", "applying", "state", "restarting", "health", "committed"]


def operation(**overrides) -> str:
    entry = {
        "operation_id": "20261026T122903Z-e1d4a5",
        "scope": "panel",
        "operation": "panel-update",
        "module_id": None,
        "version": "3.0.3-beta.6",
        "source_version": "3.0.3-beta.5",
        "result": "committed",
        "error_code": None,
        "error": None,
        "started_at": 1793017743.4,
        "finished_at": 1793017762.1,
        "log": [{"step": step, "at": 1793017743.9 + index} for index, step in enumerate(STEPS)],
        "environment": ["=== apply ===", "[ok] opkg update", "[ok] curl уже стоит"],
    }
    entry.update(overrides)
    return json.dumps(entry, ensure_ascii=False) + "\n"


def test_updates_file_is_read_as_operations():
    out = run_js("return ['updates', 'updates.1', 'install', 'install-previous'].map((n) => parser.panelLogKind(n));", None)
    assert out == ["operations", "operations", "text", "text"]


def test_a_panel_update_is_one_record_with_its_steps_and_environment():
    [rec] = build("operations", [operation()])
    assert (rec["level"], rec["source"], rec["msg"], rec["dur"]) == (
        "ok", "Обновление панели", "Панель обновлена до 3.0.3-beta.6", "19 с",
    )
    assert ["Выпуск", "3.0.3-beta.5 → 3.0.3-beta.6"] in rec["kv"]
    assert ["Операция", "20261026T122903Z-e1d4a5"] in rec["kv"]
    assert ["Канал", "предрелизный"] in build("operations", [operation(channel="prerelease")])[0]["kv"]
    assert [label for _time, label in rec["steps"]] == [
        "Подготовка", "Загрузка архива", "Проверка подписи и состава", "Замена файлов",
        "Запись состояния", "Перезапуск панели", "Проверка панели после перезапуска", "Готово",
    ]
    assert rec["extra"] == ["=== apply ===", "[ok] opkg update", "[ok] curl уже стоит"]
    assert rec["date"] and rec["time"]


def test_a_failed_operation_says_why():
    [rec] = build("operations", [operation(result="rolled_back", error="панель не ответила после перезапуска")])
    assert rec["level"] == "error"
    assert rec["msg"] == "Не выполнено: панель не ответила после перезапуска"


def test_a_module_is_named_by_its_name():
    [rec] = build("operations", [operation(scope="module", operation="install", module_id="tool.terminal",
                                           module_name="Терминал и команды", source_version=None)])
    assert (rec["source"], rec["msg"]) == ("Установка модуля", "Модуль «Терминал и команды» установлен")
    assert ["Выпуск", "3.0.3-beta.6"] in rec["kv"]


def test_a_broken_line_of_the_history_is_skipped():
    recs = build("operations", [operation(operation_id="a"), '{"oper\n', operation(operation_id="b")])
    assert [dict(rec["kv"])["Операция"] for rec in recs] == ["a", "b"]
