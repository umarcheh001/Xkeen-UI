"""Адрес загрузки, папка и имя DAT-файлов хранятся на роутере.

Раньше эти три поля карточки DAT жили только в браузере: другой браузер, другой
порт панели или вход по имени вместо адреса — и оператор видел значения по
умолчанию вместо своих. Теперь они лежат в настройках интерфейса на роутере.
"""

from __future__ import annotations

import pytest

from services.ui_settings import (
    DEFAULTS,
    UISettingsValidationError,
    _sanitize_full,
    _sanitize_patch,
    load_settings,
    patch_settings,
)


MINE = {
    "geosite": {"dir": "/opt/etc/xray/mydat", "name": "geosite_mine.dat", "url": "https://example.invalid/site.dat"},
    "geoip": {"dir": "/opt/etc/xray/mydat", "name": "geoip_mine.dat", "url": "https://example.invalid/ip.dat"},
}


def test_nothing_is_stored_until_the_operator_sets_something():
    assert DEFAULTS["routing"]["dat"] == {}
    out, _rep = _sanitize_full({})
    assert out["routing"]["dat"] == {}


def test_the_operators_values_survive_a_full_check():
    out, rep = _sanitize_full({"routing": {"dat": MINE}})

    assert out["routing"]["dat"] == MINE
    assert not [w for w in rep.warnings if w.get("path", "").startswith("routing.dat")]


def test_one_field_can_be_changed_without_the_others(tmp_path):
    patch_settings({"routing": {"dat": MINE}}, str(tmp_path))

    patch_settings({"routing": {"dat": {"geosite": {"url": "https://example.invalid/new.dat"}}}}, str(tmp_path))

    stored = load_settings(str(tmp_path))["routing"]["dat"]
    assert stored["geosite"] == {**MINE["geosite"], "url": "https://example.invalid/new.dat"}
    assert stored["geoip"] == MINE["geoip"]


def test_an_emptied_field_is_stored_as_empty(tmp_path):
    patch_settings({"routing": {"dat": MINE}}, str(tmp_path))

    patch_settings({"routing": {"dat": {"geoip": {"url": ""}}}}, str(tmp_path))

    # Пустое поле — «как в поставке»: подставит значение уже карточка.
    assert load_settings(str(tmp_path))["routing"]["dat"]["geoip"]["url"] == ""


def test_values_are_trimmed():
    out, _rep = _sanitize_patch({"routing": {"dat": {"geosite": {"name": "  geosite_mine.dat  "}}}})

    assert out["routing"]["dat"]["geosite"]["name"] == "geosite_mine.dat"


@pytest.mark.parametrize(
    "bad",
    [
        {"geosite": {"url": 5}},
        {"geosite": {"dir": ["/opt"]}},
        {"geosite": "https://example.invalid/site.dat"},
        {"geosite": {"url": "x" * 5000}},
        {"geosite": {"name": "bad\nname.dat"}},
        "everything",
    ],
)
def test_a_patch_with_a_bad_value_is_refused_not_silently_dropped(tmp_path, bad):
    with pytest.raises(UISettingsValidationError):
        patch_settings({"routing": {"dat": bad}}, str(tmp_path))


def test_a_damaged_file_loses_only_the_damaged_field():
    out, rep = _sanitize_full(
        {"routing": {"dat": {"geosite": {"dir": "/opt/etc/xray/mydat", "url": 5}, "geoip": MINE["geoip"], "other": {}}}}
    )

    assert out["routing"]["dat"] == {"geosite": {"dir": "/opt/etc/xray/mydat"}, "geoip": MINE["geoip"]}
    assert any(w.get("path") == "routing.dat.geosite.url" for w in rep.warnings)
    assert any(w.get("path") == "routing.dat.other" for w in rep.warnings)


def test_unknown_fields_of_a_file_are_dropped():
    out, rep = _sanitize_full({"routing": {"dat": {"geosite": {"name": "a.dat", "token": "secret"}}}})

    assert out["routing"]["dat"] == {"geosite": {"name": "a.dat"}}
    assert any(w.get("path") == "routing.dat.geosite.token" for w in rep.warnings)
