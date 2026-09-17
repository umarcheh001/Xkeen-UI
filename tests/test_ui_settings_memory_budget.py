from __future__ import annotations

import pytest

from services import ui_settings


def test_memory_budget_defaults_to_auto(tmp_path):
    loaded = ui_settings.load_settings(ui_state_dir=str(tmp_path))

    assert loaded["schemaVersion"] == 3
    assert loaded["runtime"] == {"memoryBudget": "auto"}


@pytest.mark.parametrize("preset", ["auto", "128", "192", "256", "384", "512", "off"])
def test_memory_budget_presets_round_trip(tmp_path, preset):
    patched, report = ui_settings.patch_settings(
        {"runtime": {"memoryBudget": preset}},
        ui_state_dir=str(tmp_path),
    )

    assert report == {"warnings": [], "errors": []}
    assert patched["runtime"]["memoryBudget"] == preset
    assert ui_settings.load_settings(ui_state_dir=str(tmp_path))["runtime"]["memoryBudget"] == preset


def test_memory_budget_rejects_arbitrary_or_numeric_values(tmp_path):
    for invalid in ("96", "1g", 128, None):
        with pytest.raises(ui_settings.UISettingsValidationError) as exc_info:
            ui_settings.patch_settings(
                {"runtime": {"memoryBudget": invalid}},
                ui_state_dir=str(tmp_path),
            )
        assert exc_info.value.errors[0]["path"] == "runtime.memoryBudget"

    assert ui_settings.load_settings(ui_state_dir=str(tmp_path))["runtime"]["memoryBudget"] == "auto"
