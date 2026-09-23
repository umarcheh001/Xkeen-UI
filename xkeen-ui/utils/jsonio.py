"""JSON read/write helpers (with JSONC comment stripping for reads)."""

from __future__ import annotations

import json
import os
import time
from collections import OrderedDict

from .jsonc import strip_json_comments_text

# Кэш конфигов со снятыми комментариями.
#
# За один запрос окна DNS-over-VLESS панель читает три десятка конфигов, и
# каждый разбирался заново: на роутере это около 55 мс из 273 мс. Содержимое
# между запросами не меняется, поэтому разбор можно не повторять.
#
# Кэшируется именно текст, а не разобранный объект: строка неизменяема, и
# делиться ею безопасно. Разобранный словарь вызывающий волен править на месте,
# и уберечь общий кэш можно было бы только `copy.deepcopy`, который на Python
# дороже самого `json.loads`.
_MAX_CACHED_BYTES = 1048576
_MAX_CACHE_ENTRIES = 64

# Штатный способ отладки в этом проекте — правка конфига прямо на роутере по
# SSH. Такая правка попадает в ту же секунду и может не изменить размер, а
# mtime файловая система округляет. Файл, которого только что касались, кэшу
# не доверяем вовсе — тот же приём стоит в `routes/ui_assets.py` для статики.
_RECENTLY_CHANGED_SECONDS = 1.0

_cache: "OrderedDict[str, tuple]" = OrderedDict()


def read_jsonc_text(path: str) -> str:
    """Прочитать файл и вернуть его текст со снятыми комментариями.

    Отсутствующий или нечитаемый файл поднимает OSError: что с ним делать,
    решает вызывающий.
    """

    stat = os.stat(path)
    # inode и устройство в ключе: подменённый целиком файл может совпасть с
    # прежним и по времени, и по размеру.
    key = (stat.st_mtime_ns, stat.st_size, stat.st_ino, stat.st_dev)
    cacheable = (
        stat.st_size <= _MAX_CACHED_BYTES
        and (time.time() - stat.st_mtime) >= _RECENTLY_CHANGED_SECONDS
    )

    if cacheable:
        hit = _cache.get(path)
        if hit is not None and hit[0] == key:
            _cache.move_to_end(path)
            return hit[1]

    with open(path, "r", encoding="utf-8") as f:
        text = strip_json_comments_text(f.read())

    if cacheable:
        _cache[path] = (key, text)
        _cache.move_to_end(path)
        while len(_cache) > _MAX_CACHE_ENTRIES:
            _cache.popitem(last=False)
    return text


def clear_jsonc_cache() -> None:
    """Сбросить кэш целиком — для тестов и аварийных случаев."""

    _cache.clear()


def load_json(path: str, default=None):
    """Load JSON from file.

    - Supports JSONC-ish comments (//, #, /* */) by stripping them before parsing.
    - Returns `default` on FileNotFoundError or JSONDecodeError.
    """
    try:
        cleaned = read_jsonc_text(path)
        if not cleaned.strip():
            return default
        return json.loads(cleaned)
    # UnicodeDecodeError добавился вместе с явным UTF-8: раньше кодировку
    # выбирала локаль, и на роутере с ASCII-локалью русский комментарий ронял
    # чтение. Теперь кодировка задана, а файл не в ней — это такой же
    # нечитаемый конфиг, как и битый JSON.
    except (FileNotFoundError, json.JSONDecodeError, UnicodeDecodeError):
        return default


def save_json(path: str, data) -> None:
    """Save JSON to file (pretty-printed)."""
    d = os.path.dirname(path)
    if d and not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
