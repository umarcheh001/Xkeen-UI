# Модуль «Диагностика серверов» — план работ

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Вынести окно «Диагностика серверов» из core в необязательный модуль `tool.server-diagnostics`, который
не ставится без явного выбора владельца роутера.

**Architecture:** Модуль регистрируется в реестре как `tool.advanced-diagnostics` (определение, владельцы, метки,
отдельная сборка фронтенда `xk-module/<id>`). Понятие «необязательный модуль профиля» + метка явного выбора
`chosen` в `modules.json` защищают от тихой установки: пресеты его не содержат, а модуль, приехавший без выбора
(обновление со старой панели), выключается при запуске.

**Tech Stack:** Python 3 / Flask / Jinja, ES-модули + Vite (`vite.module.config.mjs`), POSIX sh (`install.sh`),
pytest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-06-server-diagnostics-module-design.md`

## Global Constraints

- Id модуля `tool.server-diagnostics`, имя «Диагностика серверов», версия `1.0.0`.
- Описание модуля дословно: «Проверка доступности серверов из конфигураций Xray и Mihomo. Нужен модуль Xray или
  Mihomo. Часть проверок отправляет адреса серверов во внешние сервисы (dns.google, cheburcheck.ru).»
- Файлы коллеги `provider_diagnostics*` не переименовываются; новые файлы модуля — `server_diagnostics*`.
- Логику проверок не менять (кроме обёртки импортов движков, задача 4).
- Вопрос установщика — только явный ответ (`ui_confirm` без значения по умолчанию: Enter переспрашивает).
- Коммиты: `git -c user.name="olmer2002" -c user.email="olmer2002@gmail.com" commit -m "<по-русски>"`, без трейлеров.
  Не пушить, тегов не ставить.
- Файлы с LF; после правок `git diff --stat` (весь файл переписан — съехали окончания).
- Описи — только `npm run inventory:refresh`; если pre-commit отклонил — перегенерировать и `git add` описей.
- В текстах нет слова «Happ».
- Отдельный pytest — `python -m pytest <файл> -q`; полный — `npm run test:py` (из Bash); перед e2e —
  `npm run frontend:build`.

## Review Focus

1. Роутер на beta.22 с профилем Full обновляется кнопкой на новый выпуск → модуль приезжает, но после запуска
   выключен (`off_reason: "not_chosen"`), маршрутов `/api/provider-diagnostics/*` нет. Тест — задача 1.
2. Пользователь поставил модуль кнопкой на Full, затем обновил панель → модуль остаётся включённым, профиль
   показывается Full. Тесты — задачи 1 и 2.
3. Профиль «только Mihomo + модуль», в окне вставлена vless-ссылка → ответ 400 «нужен модуль Xray», а не 500.
   Тест — задача 4.
4. Панель без модуля: на экране Xray при сетевой ошибке подписки нет кнопки «Проверить серверы». Тест — задача 5.
5. `modules.json` старой панели без записи о модуле (новый id отсутствует) → нормализация не включает модуль
   «по умолчанию» молча: без метки `chosen` он выключается при запуске. Тест — задача 1.

---

### Task 1: Реестр — определение модуля, необязательные модули профиля, метка выбора

**Files:**
- Modify: `xkeen-ui/services/module_registry.py` (`BLUEPRINT_OWNERS` ~с.67, `_MODULE_INSTALL_MARKERS` ~с.97,
  `MODULE_DEFINITIONS` после `tool.advanced-diagnostics` ~с.312, `PROFILE_PRESETS` ~с.345, `module_set_name` ~с.355,
  `OFF_REASON_*` ~с.380, `initialize_for_startup` ~с.483, `set_enabled` ~с.788, `apply_profile` ~с.920,
  `_normalize_state` ~с.1151)
- Test: `tests/test_server_diagnostics_module_registry.py` (новый)

**Interfaces:**
- Produces:
  - `SERVER_DIAGNOSTICS_MODULE_ID = "tool.server-diagnostics"`
  - `OPTIONAL_PROFILE_MODULES: frozenset[str] = frozenset({SERVER_DIAGNOSTICS_MODULE_ID})`
  - `OFF_REASON_NOT_CHOSEN = "not_chosen"`
  - `CHOSEN_KEY = "chosen"` — булево поле записи модуля в `modules.json["modules"][id]`
  - `PROFILE_PRESETS["full"] == PROFILE_PRESETS["legacy-full"] == tuple(m for m in MODULE_IDS if m not in OPTIONAL_PROFILE_MODULES)`
  - `module_set_name(ids)` → `"full"`, если `set(ids) - OPTIONAL_PROFILE_MODULES == set(PROFILE_PRESETS["full"])`

- [ ] **Step 1: Write the failing tests**

```python
def test_module_is_registered_with_owner_text():
    d = next(x for x in MODULE_DEFINITIONS if x.id == "tool.server-diagnostics")
    assert d.name == "Диагностика серверов"
    assert "Нужен модуль Xray или Mihomo" in d.description and "cheburcheck.ru" in d.description
    assert d.dependencies == ("core",) and d.removable and d.can_disable
    assert BLUEPRINT_OWNERS["provider_diagnostics"] == "tool.server-diagnostics"
    assert _MODULE_INSTALL_MARKERS["tool.server-diagnostics"] == (
        "xkeen-ui/routes/provider_diagnostics.py", "xkeen-ui/services/provider_diagnostics.py")

def test_presets_never_contain_optional_module():
    for name in ("full", "legacy-full", "xray-minimal", "mihomo-minimal"):
        assert "tool.server-diagnostics" not in PROFILE_PRESETS[name]

def test_full_with_optional_module_is_still_full():
    assert module_set_name([*PROFILE_PRESETS["full"], "tool.server-diagnostics"]) == "full"

def test_startup_switches_off_unchosen_module(registry_with_state):
    reg = registry_with_state(modules={"tool.server-diagnostics": {"enabled": True}}, installed=True)
    reg.initialize_for_startup()
    item = reg.load_state()["modules"]["tool.server-diagnostics"]
    assert item["enabled"] is False and item["off_reason"] == "not_chosen"

def test_startup_switches_off_module_missing_from_old_state(registry_with_state):
    reg = registry_with_state(modules={}, installed=True)   # старый modules.json без записи
    reg.initialize_for_startup()
    assert reg.load_state()["modules"]["tool.server-diagnostics"]["enabled"] is False

def test_startup_keeps_chosen_module(registry_with_state):
    reg = registry_with_state(modules={"tool.server-diagnostics": {"enabled": True, "chosen": True}}, installed=True)
    reg.initialize_for_startup()
    assert reg.load_state()["modules"]["tool.server-diagnostics"]["enabled"] is True

def test_enabling_marks_choice(registry_with_state):
    reg = registry_with_state(modules={"tool.server-diagnostics": {"enabled": False, "off_reason": "not_chosen"}}, installed=True)
    reg.set_enabled("tool.server-diagnostics", True)
    item = reg.load_state()["modules"]["tool.server-diagnostics"]
    assert item["chosen"] is True and "off_reason" not in item

def test_apply_full_keeps_chosen_optional_module(registry_with_state):
    reg = registry_with_state(modules={"tool.server-diagnostics": {"enabled": True, "chosen": True}}, installed=True)
    reg.apply_profile("full")
    assert reg.load_state()["modules"]["tool.server-diagnostics"]["enabled"] is True

def test_apply_custom_with_module_marks_choice(registry_with_state):
    reg = registry_with_state(modules={}, installed=True)
    reg.apply_profile("custom", module_ids=["core", "engine.xray", "tool.editor", "tool.server-diagnostics"])
    assert reg.load_state()["modules"]["tool.server-diagnostics"]["chosen"] is True
```

Фикстуру `registry_with_state` собрать по образцу существующих тестов реестра (`tests/test_module_registry.py`):
временный каталог состояния, `modules.json` с заданными записями, `module-installed.json` с модулем.
Имена методов чтения состояния/применения профиля взять из реестра как есть (`apply_profile` — метод на ~с.920).

- [ ] **Step 2: Run to verify fail**

Run: `python -m pytest tests/test_server_diagnostics_module_registry.py -q`
Expected: FAIL (`StopIteration` / `KeyError: 'provider_diagnostics'` …)

- [ ] **Step 3: Implement in `module_registry.py`**

- Определение по образцу `tool.advanced-diagnostics`: `system_requirements=()`, `frontend_bundles=("server-diagnostics-panel",)`,
  `navigation_views=()`, `size_bytes=_module_size("tool.server-diagnostics")`.
- `_normalize_state`: сохранять `chosen: True` (только булево `True`), разрешить `off_reason == OFF_REASON_NOT_CHOSEN`
  при выключенном модуле. Для модуля из `OPTIONAL_PROFILE_MODULES` без записи в старом состоянии по умолчанию
  `enabled=False` (а не `True`).
- `initialize_for_startup`: для каждого модуля из `OPTIONAL_PROFILE_MODULES` — установлен, включён, без `chosen` →
  `enabled=False`, `off_reason=OFF_REASON_NOT_CHOSEN`, `changed=True`, одна строка `core_log_once("info", ...)`
  «Диагностика серверов выключена: модуль не выбирался явно».
- `set_enabled(id, True)` для необязательного модуля ставит `chosen=True` и снимает `off_reason`.
- `apply_profile`: для пресета `requested |= {m for m in OPTIONAL_PROFILE_MODULES if state[m].get("chosen") and state[m]["enabled"]}`;
  для custom — каждому необязательному модулю из списка `chosen=True`.

- [ ] **Step 4: Run to verify pass, then neighbours**

Run: `python -m pytest tests/test_server_diagnostics_module_registry.py tests/test_module_registry.py tests/test_physical_profile_request.py -q`
Expected: PASS (существующие тесты, ожидающие `full == MODULE_IDS`, поправить на «без необязательных»).

- [ ] **Step 5: Commit** — «Реестр: модуль «Диагностика серверов», необязательные модули профиля и метка явного выбора»

---

### Task 2: Установка и обновление — пресеты, принадлежность файлов, сохранение выбора

**Files:**
- Modify: `xkeen-ui/scripts/module_profile_install.py` (`MODULE_IDS`/`PRESETS`/`INSTALL_MARKERS` с.32–51; правила
  принадлежности с.~95–215; `_state` ~с.330; `_physical_profile` ~с.521; `_keep_switches` ~с.566; аргументы ~с.820)
- Modify: `xkeen-ui/services/module_profile_plan.py` (`PRESETS` с.13; `_selected_for_release` ~с.165)
- Modify: `xkeen-ui/services/module_transactions/plan.py` (~с.789–796, ветка обновления)
- Modify: `xkeen-ui/services/module_transactions/install_state.py` (список модулей с.21; ~с.172 и ~с.240)
- Modify: `scripts/build_modular_panel_release.py` (`_PACKAGE_OWNER_OVERRIDES`, если правил по имени не хватит)
- Test: `tests/test_server_diagnostics_module_install.py` (новый)

**Interfaces:**
- Consumes: `OPTIONAL_PROFILE_MODULES`, `CHOSEN_KEY` (задача 1).
- Produces: CLI `module_profile_install.py apply --profile full --with-optional tool.server-diagnostics` — набор
  `PRESETS["full"] ∪ {модуль}`, метка профиля `full`, у модуля `chosen: true`. `--with-optional` допустим только с `full`/`legacy-full`.

- [ ] **Step 1: Write the failing tests**

```python
OWN = ["routes/provider_diagnostics.py", "services/provider_diagnostics.py",
       "static/js/features/provider_diagnostics.js", "templates/panel/modals/provider_diagnostics.html",
       "static/server-diagnostics.css", "templates/panel/slots/server_diagnostics_xray.html",
       "templates/panel/slots/server_diagnostics_mihomo.html"]

@pytest.mark.parametrize("path", OWN)
def test_module_files_belong_to_module(path):
    assert owner(path) == "tool.server-diagnostics"

@pytest.mark.parametrize("path,expected", [
    ("static/js/features/provider_diagnostics_hint.js", "core"),
    ("services/mihomo_rule_provider_inspector.py", "engine.mihomo"),
    ("templates/panel/screens/mihomo.html", "engine.mihomo"),
    ("templates/panel/screens/routing.html", "engine.xray"),
])
def test_neighbours_keep_their_owner(path, expected):
    assert owner(path) == expected

def test_installer_presets_never_contain_optional_module():
    assert "tool.server-diagnostics" not in PRESETS["full"] and "tool.server-diagnostics" in MODULE_IDS

def test_full_with_optional_installs_module_and_marks_choice(tmp_panel):
    state = apply(tmp_panel, profile="full", with_optional=["tool.server-diagnostics"])
    assert state["profile"] == "full"
    assert state["modules"]["tool.server-diagnostics"] == {"enabled": True, "chosen": True}

def test_update_keeps_installed_optional_module(tmp_panel_full_with_module):
    assert current_install(tmp_panel_full_with_module)["module_ids"].count("tool.server-diagnostics") == 1

def test_release_full_skips_optional_module_not_installed():
    assert "tool.server-diagnostics" not in _selected_for_release("full", None, AVAILABLE_WITH_MODULE, {})

def test_panel_update_plan_keeps_installed_optional_module(state_dir_full_with_module):
    # ветка обновления plan.py: установленный набор = Full ∪ модуль → не теряется
    assert "tool.server-diagnostics" in planned_module_ids(state_dir_full_with_module)

def test_manager_install_of_optional_module_marks_choice_and_keeps_full_name(panel_full):
    updates = state_updates_for_install(panel_full, "tool.server-diagnostics")
    mods = json.loads(updates["modules.json"])
    assert mods["modules"]["tool.server-diagnostics"]["chosen"] is True
    assert module_set_name(enabled_ids(mods)) == "full"
```

Фикстуры и вызовы (`apply`, `current_install`, `planned_module_ids`, `state_updates_for_install`) собрать по образцу
`tests/test_installer_profiles.py`, `tests/test_module_profile_plan.py`, `tests/test_panel_profile_transaction_plan.py`.

- [ ] **Step 2: Run to verify fail** — `python -m pytest tests/test_server_diagnostics_module_install.py -q` → FAIL

- [ ] **Step 3: Implement**

- `module_profile_install.py`: модуль в `MODULE_IDS`, `PRESETS["full"]`/`["legacy-full"]` — без необязательных;
  `INSTALL_MARKERS["tool.server-diagnostics"] = ("routes/provider_diagnostics.py", "services/provider_diagnostics.py")`.
  Правило принадлежности **первым** в каждой ветке (`static/js/`, `templates/panel/`, `routes/`/`services/`, CSS):
  имя содержит `provider_diagnostics` или `server_diagnostics`/`server-diagnostics` → модуль; исключение
  `static/js/features/provider_diagnostics_hint.js` → core. Сборочные файлы модуля (`frontend-build/modules/tool.server-diagnostics/`)
  уже ловит `_SEPARATE_MODULE_BUILD_FILE`.
- `--with-optional` (повторяемый) → `_selected` добавляет модули; `_state` пишет `chosen: True` выбранным необязательным;
  custom со списком — тоже `chosen: True`. `_keep_switches` переносит `chosen` и `off_reason == "not_chosen"`.
- `_physical_profile`: набор `PRESETS[p] ∪ (подмножество необязательных)` не превращает профиль в custom.
- `module_profile_plan.PRESETS` — тот же разрез; `_selected_for_release("full")` = `present - OPTIONAL_PROFILE_MODULES`.
- `plan.py` (ветка обновления): если установлено `PRESETS[profile] ∪ необязательные`, передавать `profile="custom"`
  с точным списком (метка в `modules.json` при обновлении не меняется — так устроен `install_state`).
- `install_state.py`: модуль в списке; при установке необязательного модуля кнопкой — `chosen: True` и метка
  профиля `module_set_name(installed_after)` вместо безусловного `"custom"` (Full ∪ модуль остаётся `full`).

- [ ] **Step 4: Run** — новый файл + `tests/test_installer_profiles.py tests/test_module_profile_plan.py tests/test_panel_profile_transaction_plan.py tests/test_panel_profile_transactions.py tests/test_diagnostics_module_boundary.py tests/test_module_packages_over_installer_profiles.py -q` → PASS

- [ ] **Step 5: Commit** — «Установка: «Диагностика серверов» вне пресетов, сохранение явного выбора при обновлении»

---

### Task 3: Установщик — вопрос про модуль после Full и пункт Custom-меню

**Files:**
- Modify: `xkeen-ui/install.sh` (`choose_panel_profile` с.537–630; вызов `module_profile_install.py apply` ~с.1600)
- Modify: `xkeen-ui/scripts/install_custom_menu.py` (`MODULES` с.9)
- Test: `tests/test_install_terminal_ui.py`, `tests/test_installer_custom_menu.py` (дополнить)

**Interfaces:**
- Consumes: CLI `--with-optional` (задача 2).
- Produces: переменная `XKEEN_UI_INSTALL_OPTIONAL` (через запятую) → `--with-optional` при `apply`.

- [ ] **Step 1: Failing tests**
  - Новая установка, ответ `1` (Full), затем Enter → вопрос повторяется; `да` → `apply` получает `--with-optional tool.server-diagnostics`.
  - Full + `н` → без `--with-optional`.
  - Обновление существующей установки (есть `$UI_DIR`) → вопроса нет.
  - Без tty / `XKEEN_UI_INSTALL_PROFILE=full` → вопроса нет, модуля нет.
  - Custom-меню: пункт `("tool.server-diagnostics", "Диагностика серверов", "проверка серверов; нужен Xray или Mihomo; обращается к внешним сервисам")`, по умолчанию не отмечен.
  Тексты вопроса дословно:
  `ui_info "Проверки отправляют адреса серверов во внешние сервисы (dns.google, cheburcheck.ru)."`,
  `ui_info "Нужен модуль Xray или Mihomo."`, `ui_confirm "" "Поставить «Диагностику серверов»?"`.
- [ ] **Step 2: Run to verify fail** — `python -m pytest tests/test_install_terminal_ui.py tests/test_installer_custom_menu.py -q`
- [ ] **Step 3: Implement** — функция `choose_server_diagnostics_option` по образцу `choose_happ_option`, вызывается из
  `choose_panel_profile` только при `PROFILE_CHOICE=full`, интерактивном вводе и **новой** установке (нет `$UI_DIR`/`modules.json`).
  Проверить, что `ui_confirm ""` действительно переспрашивает на пустом ответе; если нет — добавить такой режим.
- [ ] **Step 4: Run** — те же файлы → PASS
- [ ] **Step 5: Commit** — «Установщик: отдельный вопрос про «Диагностику серверов» после Full»

---

### Task 4: Сервер — регистрация по модулю, слоты кнопок, флаг страницы, отказ без движка

**Files:**
- Modify: `xkeen-ui/routes/__init__.py` (~с.211)
- Modify: `xkeen-ui/routes/pages.py` (композиция с.~95; контекст с.~280–300; флаги с.~401–466)
- Modify: `xkeen-ui/templates/panel/page_config.html` (ключ `hasServerDiagnostics`), `xkeen-ui/routes/ui_assets.py:52` (умолчание `False`)
- Modify: `xkeen-ui/templates/panel/screens/routing.html:548-550`, `xkeen-ui/templates/panel/screens/mihomo.html:512-514` (кнопки → слоты)
- Create: `xkeen-ui/templates/panel/slots/server_diagnostics_xray.html`, `.../server_diagnostics_mihomo.html` (кнопки как были)
- Modify: `xkeen-ui/services/provider_diagnostics.py` (импорты движков), `xkeen-ui/routes/provider_diagnostics.py`
- Test: `tests/test_server_diagnostics_module_boundary.py` (новый, по образцу `tests/test_diagnostics_module_boundary.py`)

**Interfaces:**
- Produces: контекст страницы `server_diagnostics_xray_partials`, `server_diagnostics_mihomo_partials`;
  `pageConfig.hasServerDiagnostics: bool`; `class EngineUnavailable(ValueError)` в `services/provider_diagnostics.py`.

- [ ] **Step 1: Failing tests** (`render_panel`, `build_panel_app` из `tests/support/panel_render.py`)

```python
WITH = [*FULL_MODULE_IDS, "tool.server-diagnostics"]

def test_panel_without_module_has_no_window_buttons_or_api(tmp_path):
    html = render_panel(FULL_MODULE_IDS, tmp_path)
    assert 'id="provider-check-modal"' not in html and "xk-provider-check-trigger" not in html
    assert page_config(html)["hasServerDiagnostics"] is False
    assert build_panel_app(FULL_MODULE_IDS, tmp_path).test_client().get("/api/provider-diagnostics/targets").status_code == 404

def test_panel_with_module_has_window_and_both_buttons(tmp_path):
    html = render_panel(WITH, tmp_path)
    assert 'id="provider-check-modal"' in html
    assert 'data-provider-check-core="xray"' in html and 'data-provider-check-core="mihomo"' in html
    assert page_config(html)["hasServerDiagnostics"] is True

def test_module_without_engines_registers_nothing(tmp_path):
    ids = ["core", "tool.server-diagnostics"]
    assert "xk-provider-check-trigger" not in render_panel(ids, tmp_path)
    assert build_panel_app(ids, tmp_path).test_client().get("/api/provider-diagnostics/targets").status_code == 404

def test_vless_link_without_xray_is_refused_not_crashed(monkeypatch):
    # services.xray_outbounds недоступен (модуль Xray не установлен)
    monkeypatch.setitem(sys.modules, "services.xray_outbounds", None)
    with pytest.raises(EngineUnavailable, match="нужен модуль Xray"):
        parse_source("vless://00000000-0000-0000-0000-000000000000@example.com:443", allow_fetch=False, core="mihomo")

def test_engine_names_used_by_module_are_listed():
    assert engine_imports("xkeen-ui/services/provider_diagnostics.py") == ENGINE_IMPORTS  # список фиксируется тестом
```

`engine_imports` — разбор AST: все `from services.<xray_*|mihomo_*|amnezia_premium> import <имена>`; `ENGINE_IMPORTS` —
текущий список (с.379–567 сервиса), отсортированный.

- [ ] **Step 2: Run to verify fail** — `python -m pytest tests/test_server_diagnostics_module_boundary.py -q`
- [ ] **Step 3: Implement**
  - Блюпринт: `module_active("tool.server-diagnostics") and (module_active("engine.xray") or module_active("engine.mihomo"))`.
  - Композиция: окно — `PanelCompositionEntry("modal_partials", ("tool.server-diagnostics",), "panel/modals/provider_diagnostics.html")`;
    слоты — `("server_diagnostics_xray_partials", ("tool.server-diagnostics", "engine.xray"), "panel/slots/server_diagnostics_xray.html")`,
    то же для mihomo. В legacy-режиме (`active is None`) — модуль считается отсутствующим.
  - Экраны: на месте кнопок — `{% for p in page_context.server_diagnostics_xray_partials %}{% include p %}{% endfor %}` (и mihomo).
  - `has_server_diagnostics` в обеих ветках флагов (`False` в ветке без реестра), ключ `hasServerDiagnostics` в `page_config.html`.
  - Импорты движков: помощник `_engine(module: str, core: str)` → `importlib.import_module`; `ImportError` →
    `EngineUnavailable(f"Для этой проверки нужен модуль {core}.")`. Маршруты уже отвечают 400 на `ValueError` — проверить, иначе добавить.
- [ ] **Step 4: Run** — новый файл + `tests/test_provider_diagnostics.py tests/test_modular_panel_stage4_4_modals.py tests/test_modular_panel_stage4_5_composition.py -q` → PASS
- [ ] **Step 5: Commit** — «Диагностика серверов: маршруты, окно и кнопки — только с модулем; отказ без движка»

---

### Task 5: Фронтенд — отдельная сборка, загрузка по модулю, стили модуля, подсказка, плитка

**Files:**
- Modify: `vite.module.config.mjs` (`SEPARATE_MODULES`: `'tool.server-diagnostics': { entry: 'js/features/provider_diagnostics.js' }`)
- Modify: `xkeen-ui/services/frontend_importmap.py` (`SOURCE_FALLBACKS`)
- Create: `xkeen-ui/static/js/pages/panel.server_diagnostics.bundle.js` (по образцу `panel.diagnostics.bundle.js`: `import('xk-module/tool.server-diagnostics')` → `initProviderDiagnostics()`)
- Modify: `xkeen-ui/static/js/pages/panel.module_loader.js` (`BUNDLE_LOADERS`/`BUNDLE_SOURCES`: `'server-diagnostics-panel'`)
- Modify: `xkeen-ui/static/js/pages/panel.screen.bootstrap.js:13,136` (убрать статический импорт; `void ensurePanelModule('server-diagnostics-panel', 'after-paint')` при `pageConfig.hasServerDiagnostics`)
- Modify: `xkeen-ui/static/js/features/provider_diagnostics.js:1` (`import { iconHtml } from 'xk-core/js/ui/operator_icons.js'`)
- Modify: `xkeen-ui/static/js/features/provider_diagnostics_hint.js` (выход, если `!window.XKeen?.pageConfig?.hasServerDiagnostics`)
- Create: `xkeen-ui/static/server-diagnostics.css` (все правила `#provider-check-modal`/`.xk-provider-check*` из `panel-operator.css`, кроме `.xk-provider-check-error-hint` — она остаётся в core)
- Modify: `xkeen-ui/static/panel-operator.css` (удалить перенесённое), `xkeen-ui/templates/panel/head.html` (ссылка на `server-diagnostics.css` после `panel-operator.css` при активном модуле)
- Modify: `xkeen-ui/static/js/features/module_manager/render.js` (значок `'tool.server-diagnostics': 'ping'`; строка состояния плитки)
- Test: `tests/test_module_boundaries.py` (`CORE_PUBLIC_SURFACE` + `js/ui/operator_icons.js`), `e2e/provider_diagnostics.spec.mjs`, новый `e2e/server_diagnostics_absent.spec.mjs`, `e2e` плиток «Модулей»

**Interfaces:**
- Consumes: `pageConfig.hasServerDiagnostics`, `frontend_bundles=("server-diagnostics-panel",)` (задачи 1, 4).

- [ ] **Step 1: Failing tests**
  - pytest: `CORE_PUBLIC_SURFACE` содержит `js/ui/operator_icons.js`; importmap при активном модуле содержит `xk-module/tool.server-diagnostics`, без модуля — нет; `head.html` без модуля не ссылается на `server-diagnostics.css`; в `panel-operator.css` нет `xk-provider-check-content`.
  - e2e `server_diagnostics_absent.spec.mjs` (стенд без модуля): нет кнопок «Серверы» на `#view-routing` и `#view-mihomo`; ошибка загрузки подписки Xray (сетевой отказ, перехват `route`) не содержит «Проверить серверы».
  - e2e плитки: модуль при выключенных Xray и Mihomo — строка «Нужен модуль Xray или Mihomo»; модуль с `off_reason: "not_chosen"` — «Выключен: не выбирался при установке».
- [ ] **Step 2: Run to verify fail** — `python -m pytest tests/test_module_boundaries.py -q`; `npm run frontend:build && npx playwright test e2e/server_diagnostics_absent.spec.mjs`
- [ ] **Step 3: Implement** по списку файлов. Строки плитки — в функции состояния плитки рядом с веткой `core_missing` (`render.js` ~с.446).
- [ ] **Step 4: Run** — `npm run frontend:build`; `npx playwright test e2e/provider_diagnostics.spec.mjs e2e/server_diagnostics_absent.spec.mjs e2e/modules_manager*.spec.mjs` → 0 упавших; снимки `provider_diagnostics` не изменились.
- [ ] **Step 5: Commit** — «Диагностика серверов: отдельная сборка, стили и загрузка — у модуля»

---

### Task 6: Стенды, версии, описи

**Files:**
- Modify: `scripts/run_e2e_server.py` (`E2E_MODULE_PROFILES`: модуль в `full` стенда с `chosen: true`; профиль `no-server-diagnostics` для спека задачи 5)
- Modify: `module-versions.json` (`"tool.server-diagnostics": "1.0.0"`; `engine.xray` 1.0.3→1.0.4, `engine.mihomo` 1.0.2→1.0.3)
- Regenerate: `npm run inventory:refresh`; генераторы `scripts/generate_modular_panel_stage4_1_contract.py`, `..._stage4_6_compatibility.py`, `..._stage5_frontend_loading.py`, `generate_panel_operator_inventory.py`
- Test: `python scripts/check_module_versions_for_release.py` (как в `RELEASING.md`)

- [ ] **Step 1:** правки стенда и версий; перегенерировать описи и контракты.
- [ ] **Step 2:** `npm run test:py` (Bash) → 0 упавших сверх известных (см. память `project_local_test_failures.md`).
- [ ] **Step 3:** проверка версий модулей → без замечаний.
- [ ] **Step 4: Commit** — «Модуль «Диагностика серверов» 1.0.0: стенды, версии, описи»

---

### Task 7: Явный выбор профиля в установщике (отдельный коммит)

**Files:**
- Modify: `xkeen-ui/install.sh:580-597` (подсказка `Выбор [1-4]: `; пустой ответ → «Введите число от 1 до 4.»)
- Test: `tests/test_install_terminal_ui.py`

- [ ] **Step 1: Failing test** — интерактивный ввод `\n1\n` → меню спрашивает дважды, итог `full`; строка «Выбор [1]» больше не печатается.
- [ ] **Step 2: Run to verify fail** — `python -m pytest tests/test_install_terminal_ui.py -q`
- [ ] **Step 3: Implement** — убрать `''` из ветки `1)`; без tty и с `XKEEN_UI_INSTALL_PROFILE` поведение прежнее.
- [ ] **Step 4: Run** — `tests/test_install_terminal_ui.py tests/test_installer_profiles.py -q` → PASS
- [ ] **Step 5: Commit** — «Установщик: профиль выбирается явно, Enter переспрашивает»

---

### Task 8: Итоговая проверка

- [ ] `npm run test:py` → 0 новых падений.
- [ ] `npm run frontend:build && npm run e2e:gate` → 0 упавших.
- [ ] `npm run archive:user:skip-build`; в архиве `module-ownership.json` относит файлы модуля к `tool.server-diagnostics`.
- [ ] Обновить `.superpowers/handoff.md` и память; пуш, бета и роутеры — только по слову владельца.
