"""Кэш разобранных конфигов: попадания, протухание и предохранители.

Профиль `/api/routing/dns-over-vless` на роутере 23.09.2026: около 55 мс из
273 мс уходит на снятие комментариев, потому что за один запрос читается три
десятка конфигов, и каждый разбирается заново. Содержимое между запросами не
меняется, поэтому разбор можно не повторять.

Кэшируется именно **текст со снятыми комментариями**, а не разобранный объект:
строка неизменяема, и общий кэш её раздаёт безопасно. Разобранный словарь
вызывающий волен править на месте, и защититься можно было бы только
`copy.deepcopy`, который дороже самого `json.loads`.

Правка конфига прямо на роутере по SSH — штатный способ отладки в этом
проекте, поэтому проверки ниже придирчивы именно к протуханию.
"""

from __future__ import annotations

import os
import time

import pytest

from utils.jsonio import read_jsonc_text


def _write(path, text: str, *, age_seconds: float = 3600.0) -> None:
    """Положить файл и состарить его, чтобы кэш согласился его держать."""

    path.write_text(text, encoding="utf-8")
    if age_seconds:
        stamp = time.time() - age_seconds
        os.utime(path, (stamp, stamp))


def _rewrite_in_place(path, text: str) -> None:
    """Подменить содержимое, сохранив mtime и размер.

    Так проверяется само попадание в кэш: если бы файл читался заново, ответ
    изменился бы. Никаких моков — только настоящий файл.
    """

    stat = path.stat()
    assert len(text.encode("utf-8")) == stat.st_size, "подмена обязана сохранить размер"
    path.write_text(text, encoding="utf-8")
    os.utime(path, (stat.st_atime, stat.st_mtime))


class TestCacheHits:
    def test_comments_are_stripped(self, tmp_path) -> None:
        path = tmp_path / "conf.json"
        _write(path, '{"a": 1} // хвост')
        assert read_jsonc_text(str(path)).strip() == '{"a": 1}'

    def test_unchanged_file_is_not_reparsed(self, tmp_path) -> None:
        path = tmp_path / "conf.json"
        _write(path, '{"a": 1}')
        first = read_jsonc_text(str(path))
        _rewrite_in_place(path, '{"a": 2}')
        assert read_jsonc_text(str(path)) == first


class TestInvalidation:
    def test_new_size_is_seen(self, tmp_path) -> None:
        path = tmp_path / "conf.json"
        _write(path, '{"a": 1}')
        read_jsonc_text(str(path))
        _write(path, '{"a": 11}')
        assert read_jsonc_text(str(path)).strip() == '{"a": 11}'

    def test_new_mtime_is_seen(self, tmp_path) -> None:
        path = tmp_path / "conf.json"
        _write(path, '{"a": 1}')
        read_jsonc_text(str(path))
        path.write_text('{"a": 2}', encoding="utf-8")
        stamp = time.time() - 1800
        os.utime(path, (stamp, stamp))
        assert read_jsonc_text(str(path)).strip() == '{"a": 2}'

    def test_just_changed_file_is_not_cached(self, tmp_path) -> None:
        # Правка по SSH попадает в ту же секунду и может не изменить размер.
        # Такой файл кэшу доверять нельзя.
        path = tmp_path / "conf.json"
        _write(path, '{"a": 1}', age_seconds=0)
        read_jsonc_text(str(path))
        _rewrite_in_place(path, '{"a": 2}')
        assert read_jsonc_text(str(path)).strip() == '{"a": 2}'


class TestGuards:
    def test_large_file_is_not_cached(self, tmp_path, monkeypatch) -> None:
        # Файл в 8 байт при пороге 4 кэшу не положен.
        monkeypatch.setattr("utils.jsonio._MAX_CACHED_BYTES", 4)
        path = tmp_path / "conf.json"
        _write(path, '{"a": 1}')
        read_jsonc_text(str(path))
        _rewrite_in_place(path, '{"a": 2}')
        assert read_jsonc_text(str(path)).strip() == '{"a": 2}'

    def test_file_exactly_at_the_limit_is_cached(self, tmp_path, monkeypatch) -> None:
        monkeypatch.setattr("utils.jsonio._MAX_CACHED_BYTES", 8)
        path = tmp_path / "conf.json"
        _write(path, '{"a": 1}')
        first = read_jsonc_text(str(path))
        _rewrite_in_place(path, '{"a": 2}')
        assert read_jsonc_text(str(path)) == first

    def test_cache_does_not_grow_past_its_limit(self, tmp_path, monkeypatch) -> None:
        monkeypatch.setattr("utils.jsonio._MAX_CACHE_ENTRIES", 2)
        paths = []
        for index in range(3):
            path = tmp_path / f"conf{index}.json"
            _write(path, '{"a": 1}')
            read_jsonc_text(str(path))
            paths.append(path)
        # Самый старый вытеснен: подмена на месте теперь видна.
        _rewrite_in_place(paths[0], '{"a": 2}')
        assert read_jsonc_text(str(paths[0])).strip() == '{"a": 2}'

    def test_missing_file_raises(self, tmp_path) -> None:
        # Вызывающие сами решают, что делать с отсутствующим файлом:
        # `load_json` отдаёт default, `_read_json` — копию своего.
        with pytest.raises(OSError):
            read_jsonc_text(str(tmp_path / "нет.json"))


class TestCallersUseTheCache:
    """Оба входа чтения конфигов в панели должны идти через кэш.

    Их два — общий `jsonio.load_json()` и свой `_read_json()` в
    `services/dns_over_vless.py`. Код у них один и тот же, и разводить два
    поведения незачем.
    """

    def test_load_json_reuses_cached_text(self, tmp_path) -> None:
        from utils.jsonio import load_json

        path = tmp_path / "conf.json"
        _write(path, '{"a": 1}')
        assert load_json(str(path)) == {"a": 1}
        _rewrite_in_place(path, '{"a": 2}')
        assert load_json(str(path)) == {"a": 1}

    def test_load_json_still_returns_default_when_missing(self, tmp_path) -> None:
        from utils.jsonio import load_json

        assert load_json(str(tmp_path / "нет.json"), {"x": 1}) == {"x": 1}

    def test_load_json_reads_utf8_comments(self, tmp_path) -> None:
        # Конфиги панели подписаны по-русски, а локаль роутера может оказаться
        # ASCII: читать нужно явным UTF-8, а не тем, что подвернётся.
        from utils.jsonio import load_json

        path = tmp_path / "conf.json"
        _write(path, '{"a": 1} // хвост по-русски')
        assert load_json(str(path)) == {"a": 1}

    def test_dns_over_vless_read_json_reuses_cached_text(self, tmp_path) -> None:
        from services.dns_over_vless import _read_json

        path = tmp_path / "conf.json"
        _write(path, '{"a": 1}')
        assert _read_json(str(path)) == {"a": 1}
        _rewrite_in_place(path, '{"a": 2}')
        assert _read_json(str(path)) == {"a": 1}

    def test_dns_over_vless_read_json_keeps_default_untouched(self, tmp_path) -> None:
        # Отдаётся копия: вызывающий волен править ответ на месте, и общий
        # умолчательный объект от этого пострадать не должен.
        from services.dns_over_vless import _read_json

        default: dict = {"a": []}
        got = _read_json(str(tmp_path / "нет.json"), default)
        got["a"].append(1)
        assert default == {"a": []}
