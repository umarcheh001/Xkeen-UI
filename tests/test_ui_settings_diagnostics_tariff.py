"""Тариф канала для окна диагностики хранится на роутере, по подключению."""

from __future__ import annotations

import pytest

from services.ui_settings import (
    DEFAULTS,
    UISettingsValidationError,
    _sanitize_full,
    _sanitize_patch,
    get_diagnostics_tariffs,
    load_settings,
    patch_settings,
)

TARIFF_ERROR = "Скорость тарифа — целое число от 1 до 10000 Мбит/с"


def test_nothing_is_stored_until_the_operator_sets_a_tariff(tmp_path):
    assert DEFAULTS["diagnostics"]["tariffs"] == {}
    out, _rep = _sanitize_full({})
    assert out["diagnostics"]["tariffs"] == {}
    assert get_diagnostics_tariffs(str(tmp_path)) == {}


def test_tariff_valid_saved(tmp_path):
    patch_settings({"diagnostics": {"tariffs": {"GigabitEthernet1": {"up_mbps": 100, "down_mbps": 500}}}}, str(tmp_path))

    assert load_settings(str(tmp_path))["diagnostics"]["tariffs"] == {
        "GigabitEthernet1": {"up_mbps": 100, "down_mbps": 500}
    }
    assert get_diagnostics_tariffs(str(tmp_path)) == {"GigabitEthernet1": (100, 500)}


def test_one_direction_may_stay_empty(tmp_path):
    patch_settings({"diagnostics": {"tariffs": {"UsbQmi0": {"up_mbps": None, "down_mbps": 50}}}}, str(tmp_path))

    assert get_diagnostics_tariffs(str(tmp_path)) == {"UsbQmi0": (None, 50)}


@pytest.mark.parametrize("bad", [0, -5, "100", "abc", 10001, 100000, 12.5, True, [], {}])
def test_tariff_rejects_zero_negative_text_huge(tmp_path, bad):
    with pytest.raises(UISettingsValidationError) as exc:
        patch_settings({"diagnostics": {"tariffs": {"GigabitEthernet1": {"down_mbps": bad}}}}, str(tmp_path))

    assert any(e.get("error") == TARIFF_ERROR for e in exc.value.errors)
    assert get_diagnostics_tariffs(str(tmp_path)) == {}


def test_tariffs_per_connection_saved_and_rejected(tmp_path):
    patch_settings(
        {
            "diagnostics": {
                "tariffs": {
                    "GigabitEthernet1": {"up_mbps": 100, "down_mbps": 300},
                    "UsbQmi0": {"up_mbps": 20, "down_mbps": 80},
                }
            }
        },
        str(tmp_path),
    )
    # a change of one connection keeps the other one
    patch_settings({"diagnostics": {"tariffs": {"UsbQmi0": {"down_mbps": 90}}}}, str(tmp_path))
    assert get_diagnostics_tariffs(str(tmp_path)) == {
        "GigabitEthernet1": (100, 300),
        "UsbQmi0": (20, 90),
    }

    # one bad connection refuses the whole patch, nothing is half-saved
    with pytest.raises(UISettingsValidationError):
        patch_settings(
            {"diagnostics": {"tariffs": {"GigabitEthernet1": {"down_mbps": 1}, "UsbQmi0": {"up_mbps": 0}}}},
            str(tmp_path),
        )
    assert get_diagnostics_tariffs(str(tmp_path))["GigabitEthernet1"] == (100, 300)


@pytest.mark.parametrize("name", ["", "x" * 65, "bad name", "a;b", "Wi-Fi\n", "ИСП"])
def test_connection_id_is_checked(tmp_path, name):
    with pytest.raises(UISettingsValidationError):
        patch_settings({"diagnostics": {"tariffs": {name: {"down_mbps": 10}}}}, str(tmp_path))


def test_at_most_eight_connections(tmp_path):
    many = {f"Conn{i}": {"down_mbps": 10} for i in range(9)}
    with pytest.raises(UISettingsValidationError):
        patch_settings({"diagnostics": {"tariffs": many}}, str(tmp_path))
    # also when the sum with what is stored would be more than eight
    patch_settings({"diagnostics": {"tariffs": {f"Conn{i}": {"down_mbps": 10} for i in range(8)}}}, str(tmp_path))
    with pytest.raises(UISettingsValidationError):
        patch_settings({"diagnostics": {"tariffs": {"Extra": {"down_mbps": 10}}}}, str(tmp_path))
    assert len(get_diagnostics_tariffs(str(tmp_path))) == 8


def test_clearing_both_directions_removes_the_connection(tmp_path):
    patch_settings({"diagnostics": {"tariffs": {"UsbQmi0": {"up_mbps": 5, "down_mbps": 6}}}}, str(tmp_path))
    patch_settings({"diagnostics": {"tariffs": {"UsbQmi0": {"up_mbps": None, "down_mbps": None}}}}, str(tmp_path))

    assert get_diagnostics_tariffs(str(tmp_path)) == {}


def test_a_damaged_file_loses_only_the_damaged_value():
    out, rep = _sanitize_full(
        {"diagnostics": {"tariffs": {"A": {"up_mbps": 0, "down_mbps": 40}, "B": "x", "bad name": {"up_mbps": 1}}}}
    )

    assert out["diagnostics"]["tariffs"] == {"A": {"up_mbps": None, "down_mbps": 40}}
    assert any(w.get("path") == "diagnostics.tariffs.A.up_mbps" for w in rep.warnings)


def test_unknown_fields_are_dropped_from_a_file_and_refused_in_a_patch():
    out, _rep = _sanitize_full({"diagnostics": {"tariffs": {"A": {"down_mbps": 5, "token": "x"}}, "other": 1}})
    assert out["diagnostics"]["tariffs"] == {"A": {"up_mbps": None, "down_mbps": 5}}
    assert "other" not in out["diagnostics"]

    patch, rep = _sanitize_patch({"diagnostics": {"tariffs": {"A": {"down_mbps": 5, "token": "x"}}}})
    assert "diagnostics" not in patch and rep.errors
