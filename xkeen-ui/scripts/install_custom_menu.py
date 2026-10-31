#!/usr/bin/env python3
"""Interactive selection for the console installer; result goes to stdout."""

import os
import select
import signal
import sys

MODULES = (
    ("engine.xray", "Xray", "управление Xray"),
    ("engine.mihomo", "Mihomo", "управление Mihomo"),
    ("tool.editor", "Редактор", "работа с конфигурациями"),
    ("tool.terminal", "Терминал", "терминал в браузере"),
    ("tool.files", "Файловый менеджер", "работа с файлами"),
    ("tool.backups", "Резервные копии", "создание и восстановление копий"),
    ("integration.happ", "Ссылки подписок", "работа с защищёнными ссылками"),
    ("tool.advanced-diagnostics", "Расширенная диагностика", "дополнительные инструменты"),
)
ENGINES = {"engine.xray", "engine.mihomo"}


def supports_screen(term):
    return term.lower().split("-", 1)[0] in {"xterm", "screen", "tmux", "rxvt"}


def choose(inp, out, interactive_keys=False, color=False, core_available=None):
    selected = {"core"}
    cursor = 0
    notice = ""
    level = ""
    detected = {name: core_available(name) for name in ("xray", "mihomo")} if core_available else None

    def message(text, kind):
        if color:
            code = "32" if kind == "ok" else "33"
            return "\033[1;%sm%s\033[0m" % (code, text)
        return text

    def read_key():
        if not interactive_keys:
            line = inp.readline()
            if line == "":
                raise EOFError
            return line.strip()
        key = os.read(inp.fileno(), 1)
        if not key:
            raise EOFError
        if key == b"\x1b":
            sequence = b""
            while len(sequence) < 2 and select.select([inp], [], [], 0.1)[0]:
                sequence += os.read(inp.fileno(), 1)
            return {b"[A": "up", b"[B": "down", b"OA": "up", b"OB": "down"}.get(sequence, "invalid")
        return {b"\r": "", b"\n": "", b" ": "toggle"}.get(key, key.decode("ascii", "ignore") or "invalid")

    while True:
        if interactive_keys:
            print("\033[H\033[2J", end="", file=out)
        print("\n  Выбор модулей панели", file=out)
        if detected is not None:
            if detected["xray"] and detected["mihomo"]:
                print("\n  Обнаружены ядра Xray и Mihomo.", file=out)
                print("  Для управления ими выберите модули Xray и Mihomo.", file=out)
            elif detected["xray"] or detected["mihomo"]:
                name = "Xray" if detected["xray"] else "Mihomo"
                print("\n  Обнаружено ядро %s." % name, file=out)
                print("  Для управления им выберите модуль %s." % name, file=out)
            else:
                print("\n  Ядра Xray и Mihomo не обнаружены.", file=out)
                print("  Модули панели не устанавливают сами ядра.", file=out)
            if any(detected.values()):
                print("  Редактор будет добавлен автоматически.", file=out)
        print("\n      [x] Основа панели — обязательна", file=out)
        for index, (module, title, description) in enumerate(MODULES):
            marker = "›" if interactive_keys and cursor == index else " "
            checked = "x" if module in selected else " "
            if module == "tool.editor" and selected & ENGINES:
                description = "требуется для " + " и ".join(name for mid, name, _ in MODULES[:2] if mid in selected)
            mark = "[%s]" % checked
            if color:
                mark = ("\033[1;32m" if checked == "x" else "\033[2m") + mark + "\033[0m"
                if interactive_keys and cursor == index:
                    marker = "\033[1;36m›\033[0m"
            print("    %s %s %d. %-25s %s" % (marker, mark, index + 1, title, description), file=out)
        if notice:
            print("\n" + message("  %s   %s" % ("✓" if level == "ok" else "!", notice), level), file=out)
        print("\n  ↑ ↓ — перемещение, пробел — выбор, Enter — продолжить" if interactive_keys else "\n  Введите номер модуля или нажмите Enter:", file=out, flush=True)
        key = read_key()
        notice, level = "", ""
        if key in ("up", "down"):
            cursor = (cursor + (-1 if key == "up" else 1)) % len(MODULES)
            continue
        if key == "":
            if not selected & ENGINES:
                notice, level = "Выберите хотя бы один модуль: Xray или Mihomo.", "warning"
                continue
            print("\n  Будут установлены:\n\n    • Основа панели", file=out)
            for module, title, _ in MODULES:
                if module in selected:
                    print("    • " + title, file=out)
            if detected is not None:
                for module, title, _ in MODULES[:2]:
                    if module in selected and not detected[module.split(".")[1]]:
                        print("\n" + message("  !   Ядро %s не найдено. Модуль панели будет недоступен до установки ядра." % title, "warning"), file=out)
            print("\n  1) Продолжить установку\n  2) Изменить выбор\n\n  Выбор [1]: ", end="", file=out, flush=True)
            while True:
                answer = read_key()
                if answer in ("", "1"):
                    return ["core"] + [module for module, _, _ in MODULES if module in selected]
                if answer == "2":
                    break
                print("\n" + message("  !   Введите 1 или 2.", "warning"), file=out, flush=True)
            continue
        if key == "toggle":
            index = cursor
        elif key in tuple(str(n) for n in range(1, 9)):
            index = int(key) - 1
            cursor = index
        else:
            notice, level = "Введите номер от 1 до 8.", "warning"
            continue
        module = MODULES[index][0]
        if module == "tool.editor" and module in selected and selected & ENGINES:
            notice, level = "Редактор нельзя выключить: он нужен выбранным модулям движков.", "warning"
        elif module in selected:
            selected.remove(module)
        else:
            selected.add(module)
            if module in ENGINES and "tool.editor" not in selected:
                selected.add("tool.editor")
                notice, level = "Редактор включён автоматически: он нужен для " + MODULES[index][1] + ".", "ok"


def main():
    from pathlib import Path
    try:
        import termios
        import tty
    except ImportError:
        termios = tty = None

    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from services.module_registry import core_binary_available

    with open("/dev/tty", "r", encoding="utf-8") as inp, os.fdopen(os.dup(3), "w", encoding="utf-8", buffering=1) as out:
        keys = termios is not None and supports_screen(os.environ.get("TERM", "dumb"))
        saved = None
        if keys:
            try:
                saved = termios.tcgetattr(inp.fileno())
                tty.setcbreak(inp.fileno())
            except (termios.error, OSError):
                keys = False
        def interrupted(_signum, _frame):
            raise KeyboardInterrupt
        old = {sig: signal.signal(sig, interrupted) for sig in (signal.SIGHUP, signal.SIGTERM)}
        try:
            if keys:
                print("\033[?1049h", end="", file=out, flush=True)
            result = choose(inp, out, interactive_keys=keys, color=keys and not os.environ.get("NO_COLOR"), core_available=core_binary_available)
        finally:
            if keys:
                print("\033[?1049l", end="", file=out, flush=True)
            if saved is not None:
                termios.tcsetattr(inp.fileno(), termios.TCSADRAIN, saved)
            for sig, handler in old.items():
                signal.signal(sig, handler)
        print(",".join(result))


if __name__ == "__main__":
    try:
        main()
    except (EOFError, KeyboardInterrupt):
        sys.exit(130)
