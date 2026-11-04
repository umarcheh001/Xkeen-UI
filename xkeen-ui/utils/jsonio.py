"""JSON read/write helpers (with JSONC comment stripping for reads)."""

from __future__ import annotations

import json
import os
import sys
import threading
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
_MAX_CACHE_BYTES = 8 * 1024 * 1024
_MAX_CACHE_ENTRIES = 64

# Штатный способ отладки в этом проекте — правка конфига прямо на роутере по
# SSH. Такая правка попадает в ту же секунду и может не изменить размер, а
# mtime файловая система округляет. Файл, которого только что касались, кэшу
# не доверяем вовсе — тот же приём стоит в `routes/ui_assets.py` для статики.
_RECENTLY_CHANGED_SECONDS = 1.0

_cache: "OrderedDict[str, tuple]" = OrderedDict()
_cache_bytes = 0
_cache_lock = threading.Lock()


def read_jsonc_text(path: str) -> str:
    """Прочитать файл и вернуть его текст со снятыми комментариями.

    Отсутствующий или нечитаемый файл поднимает OSError: что с ним делать,
    решает вызывающий.
    """

    global _cache_bytes
    stat = os.stat(path)
    # inode и устройство в ключе: подменённый целиком файл может совпасть с
    # прежним и по времени, и по размеру.
    key = (stat.st_mtime_ns, stat.st_size, stat.st_ino, stat.st_dev)
    cacheable = (
        stat.st_size <= _MAX_CACHED_BYTES
        and (time.time() - stat.st_mtime) >= _RECENTLY_CHANGED_SECONDS
    )

    with _cache_lock:
        hit = _cache.get(path)
        if cacheable and hit is not None and hit[0] == key:
            _cache.move_to_end(path)
            return hit[1]
        if hit is not None:
            _cache_bytes -= hit[2]
            del _cache[path]

    with open(path, "r", encoding="utf-8") as f:
        text = strip_json_comments_text(f.read())

    if cacheable:
        size = sys.getsizeof(path) + sys.getsizeof(key) + sum(sys.getsizeof(part) for part in key) + sys.getsizeof(text)
        if size <= _MAX_CACHE_BYTES:
            with _cache_lock:
                previous = _cache.pop(path, None)
                if previous is not None:
                    _cache_bytes -= previous[2]
                _cache[path] = (key, text, size)
                _cache_bytes += size
                while len(_cache) > _MAX_CACHE_ENTRIES or _cache_bytes > _MAX_CACHE_BYTES:
                    _, (_, _, old_size) = _cache.popitem(last=False)
                    _cache_bytes -= old_size
    return text


def clear_jsonc_cache() -> int:
    """Сбросить кэш целиком — для тестов и аварийных случаев."""

    global _cache_bytes
    with _cache_lock:
        count = len(_cache)
        _cache.clear()
        _cache_bytes = 0
        return count


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
