"""Установщик не забирает из панели шаблоны, которые пользователь завёл сам.

В `templates/routing` и `templates/observatory` рядом лежат шаблоны из поставки
и собственные шаблоны пользователя. Поставочные обновляет `install.sh` поимённо,
остальное — чужое. Когда списка управляемых файлов ещё нет (первая установка
модульной панели поверх обычной), раскладка профиля считала своим всё в
`templates/routing` и уносила это в карантин: свой шаблон пропадал из панели.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from services import panel_package_contract
from services.module_profile_plan import user_owned
from services.module_transactions import plan as transaction_plan
from tests.test_installer_profiles import _module, _source


OWN = {
    "templates/routing/my_own.jsonc": "{ my rules }\n",
    "templates/routing/05_routing_base.jsonc": "{ shipped, edited }\n",
    "templates/observatory/my_xray_probe.jsonc": "{ my probe }\n",
}


FOLDERS = ("templates/routing/", "templates/observatory/")


def _plant(dest: Path) -> None:
    for relative, body in OWN.items():
        path = dest / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")


def _quarantined(root: Path) -> list[str]:
    quarantine = Path(root) / "quarantine"
    return sorted(path.relative_to(quarantine).as_posix() for path in quarantine.rglob("*") if path.is_file())


def test_first_modular_install_leaves_the_users_templates_in_the_panel(tmp_path):
    helper = _module()
    src = _source(tmp_path)
    dest = tmp_path / "installed"
    # Обычная панель: файлы есть, списка управляемых файлов нет.
    (dest).mkdir()
    (dest / "app.py").write_text("old panel\n", encoding="utf-8")
    _plant(dest)

    root = helper.apply_profile(src, dest, "full")

    assert {relative: (dest / relative).read_text(encoding="utf-8") for relative in OWN} == OWN
    assert [path for path in _quarantined(root) if path.startswith(FOLDERS)] == []


def test_a_lost_list_of_managed_files_does_not_cost_the_users_templates(tmp_path):
    helper = _module()
    src = _source(tmp_path)
    dest = tmp_path / "installed"
    helper.commit_profile(helper.apply_profile(src, dest, "full"))
    _plant(dest)
    (dest / "install-managed.json").write_text("not json", encoding="utf-8")

    root = helper.apply_profile(src, dest, "xray-minimal")

    assert {relative: (dest / relative).read_text(encoding="utf-8") for relative in OWN} == OWN
    assert [path for path in _quarantined(root) if path.startswith(FOLDERS)] == []


@pytest.mark.parametrize(
    "relative",
    ["templates/routing/my_own.jsonc", "templates/routing/.xkeen_seeded", "templates/observatory/mine.jsonc"],
)
def test_template_folders_belong_to_the_user_everywhere(relative):
    helper = _module()

    # Один и тот же ответ у установщика, у обновления из панели и у проверки архива.
    assert user_owned(relative)
    assert helper._user_owned(relative)
    assert relative.startswith(transaction_plan.USER_PREFIXES)
    assert panel_package_contract._user_owned(relative)


def test_page_templates_of_the_panel_stay_managed():
    assert not user_owned("templates/panel.html")
    assert not user_owned("templates/panel/slots/routing.html")
