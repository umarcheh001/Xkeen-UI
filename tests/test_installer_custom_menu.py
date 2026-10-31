from __future__ import annotations

import importlib.util
import io
import os
from pathlib import Path


def load_menu():
    path = Path(__file__).resolve().parents[1] / "xkeen-ui/scripts/install_custom_menu.py"
    spec = importlib.util.spec_from_file_location("install_custom_menu", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_number_menu_requires_engine_and_adds_editor():
    menu = load_menu()
    output = io.StringIO()
    selected = menu.choose(io.StringIO("\n1\n\n1\n"), output, interactive_keys=False)
    assert selected == ["core", "engine.xray", "tool.editor"]
    assert "хотя бы один" in output.getvalue()
    assert "автоматически" in output.getvalue()


def test_dependency_cannot_be_removed_and_selection_survives_back():
    menu = load_menu()
    output = io.StringIO()
    selected = menu.choose(io.StringIO("2\n3\n\n2\n5\n\n1\n"), output, interactive_keys=False)
    assert selected == ["core", "engine.mihomo", "tool.editor", "tool.files"]
    assert "нельзя выключить" in output.getvalue()


def test_installer_defers_optional_questions_until_profile_is_known():
    installer = (Path(__file__).resolve().parents[1] / "xkeen-ui/install.sh").read_text(encoding="utf-8")
    invocation = installer.index("\nchoose_panel_profile\n")
    assert invocation < installer.index("\n  choose_geodat_option\n", invocation)
    assert invocation < installer.index("\n  choose_happ_option\n", invocation)
    assert "install_custom_menu.py" in installer


def test_arrow_and_space_select_mihomo(monkeypatch):
    menu = load_menu()
    if os.name == "nt":
        monkeypatch.setattr(menu.select, "select", lambda readers, *_args: (readers, [], []))
    read_fd, write_fd = os.pipe()
    os.write(write_fd, b"\x1b[B \r1")
    os.close(write_fd)
    with os.fdopen(read_fd, "r") as inp:
        selected = menu.choose(inp, io.StringIO(), interactive_keys=True)
    assert selected == ["core", "engine.mihomo", "tool.editor"]


def test_missing_selected_core_is_explained_before_confirmation():
    menu = load_menu()
    output = io.StringIO()
    menu.choose(io.StringIO("1\n\n1\n"), output, core_available=lambda name: False)
    assert "Ядро Xray не найдено" in output.getvalue()


def test_detected_cores_are_suggested_without_selecting_them():
    menu = load_menu()
    output = io.StringIO()
    selected = menu.choose(io.StringIO("\n2\n\n1\n"), output, core_available=lambda name: name == "xray")
    text = output.getvalue()
    assert "Обнаружено ядро Xray" in text
    assert "выберите модуль Xray" in text
    assert "хотя бы один" in text
    assert selected == ["core", "engine.mihomo", "tool.editor"]


def test_detected_core_combinations_are_explained():
    menu = load_menu()
    for available, expected in [(lambda name: True, "Xray и Mihomo"), (lambda name: name == "mihomo", "выберите модуль Mihomo"), (lambda name: False, "Ядра Xray и Mihomo не обнаружены")]:
        output = io.StringIO()
        menu.choose(io.StringIO("1\n\n1\n"), output, core_available=available)
        assert expected in output.getvalue()


def test_non_ascii_key_is_not_treated_as_enter():
    menu = load_menu()
    read_fd, write_fd = os.pipe()
    os.write(write_fd, b"1" + "я".encode() + b"5\r1")
    os.close(write_fd)
    output = io.StringIO()
    with os.fdopen(read_fd, "r") as inp:
        selected = menu.choose(inp, output, interactive_keys=True)
    assert selected == ["core", "engine.xray", "tool.editor", "tool.files"]
    assert "Введите номер от 1 до 8" in output.getvalue()


def test_basic_terminals_use_numbered_fallback():
    menu = load_menu()
    assert not menu.supports_screen("dumb")
    assert not menu.supports_screen("vt100")
    assert menu.supports_screen("xterm-256color")
    assert menu.supports_screen("screen-256color")
