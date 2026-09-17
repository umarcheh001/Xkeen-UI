#!/usr/bin/env python3
"""Optional install.sh step: happ-decrypt-universal and the Happ keys.

The engine comes from the Xkeen-UI release, the keys from the third-party
LeeeeT/happ-decryptor repository, so nothing is downloaded without a clear yes:

  XKEEN_HAPP_DECRYPTOR_INSTALL=1   install without asking
  XKEEN_HAPP_DECRYPTOR_INSTALL=0   skip
  unset                            ask on a terminal, "no" by default; skip without one

The step never fails the outer installer. Run the copy inside the panel
directory: the engine is installed into the ``bin/`` next to it.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

PANEL_DIR = Path(__file__).resolve().parents[1]
if str(PANEL_DIR) not in sys.path:
    sys.path.insert(0, str(PANEL_DIR))

INSTALL_ENV = "XKEEN_HAPP_DECRYPTOR_INSTALL"
_YES = {"y", "yes", "д", "да"}
_NO = {"", "n", "no", "н", "нет"}


def _say(out, text: str) -> None:
    print(f"happ-decryptor: {text}", file=out)


def _wants_install(env, stdin, out) -> bool:
    choice = str(env.get(INSTALL_ENV) or "").strip()
    if choice in ("0", "1"):
        return choice == "1"
    if stdin is None or not stdin.isatty():
        _say(out, f"пропущено: без терминала ключи Happ не скачиваются. Поставить можно в панели или с {INSTALL_ENV}=1.")
        return False

    print("", file=out)
    print("Установить режим разработчика для подписок?", file=out)
    print("Расширенная обработка ссылок при импорте подписок. Компоненты загрузятся с GitHub.", file=out)
    out.write("Введите y/N: ")
    out.flush()
    answer = (stdin.readline() or "").strip().lower()
    if answer in _YES:
        return True
    _say(out, "пропущено" if answer in _NO else "ответ не распознан — пропуск")
    return False


def _report(out, result: dict) -> None:
    version = (result.get("engine") or {}).get("version")
    if version:
        _say(out, f"движок: {version}")
    key_info = result.get("keys") or {}
    if key_info.get("installed"):
        manifest = key_info.get("manifest") or {}
        origin = f" ({manifest.get('repo')}, коммит {str(manifest.get('commit') or '')[:12]})" if manifest else ""
        _say(out, "ключи: " + ", ".join(key_info["installed"]) + origin)


def main(argv=None, *, env=None, stdin=None, out=None, installer=None) -> int:
    env = os.environ if env is None else env
    stdin = sys.stdin if stdin is None else stdin
    out = sys.stdout if out is None else out
    try:
        from services.happ_decryptor.errors import HappDecryptorError
    except Exception:  # noqa: BLE001 - a broken panel copy must not break install.sh
        HappDecryptorError = None  # type: ignore[assignment]

    try:
        if not _wants_install(env, stdin, out):
            return 0
        if installer is None:
            from services.happ_decryptor import service

            installer = service.install_all
        _say(out, "устанавливаю движок и ключи Happ…")
        _report(out, installer())
    except Exception as exc:  # noqa: BLE001
        if HappDecryptorError is not None and isinstance(exc, HappDecryptorError):
            _say(out, f"не установлен: {exc.hint}")
        else:
            _say(out, f"не удалось установить декриптор Happ ({type(exc).__name__}) — пропуск")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
