# Отделение Mihomo — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for native execution, or superpowers:subagent-driven-development if the owner chooses delegation. Steps use checkbox syntax.

**Goal:** Независимая сборка фронтенда и собственных стилей engine.mihomo без изменения интерфейса.

**Architecture:** Использовать общий механизм уже отделённых модулей engine.xray,
tool.advanced-diagnostics и tool.server-diagnostics. Вход Mihomo загружает части
через module_parts; общие зависимости доступны по xk-core; собственный CSS
загружается модулем и не влияет на хеши core.

**Tech Stack:** ES modules, Vite, Python/pytest, Node tests, Playwright.

**Spec:** docs/superpowers/specs/2026-11-13-mihomo-module-separation-design.md

## Global Constraints

- Пользовательский вид и поведение сохраняются; новых зависимостей нет.
- Общие runtime, флаги, оболочка, стили xk-xlog остаются core; singleton не дублируется.
- Работают собранный и исходный режимы, генератор напрямую и через SPA.
- Все файлы LF; один исполнитель меняет код. Изоляция — средствами using-git-worktrees.
- Тесты запускаются как Alex вне песочницы; перед e2e выполняется frontend:build.
- Полный pytest через Git Bash, уникальный короткий basetemp вне Git, вывод в журнал.
- Не пушить, не ставить теги, не устанавливать на роутер без соответствующей просьбы.
- Описи генерировать штатно; личные файлы в коммиты не включать.

## Review Focus

1. Повторный вход после JS/CSS ошибки: не остаётся успешного кеша или мёртвого link (задачи 1, 3).
2. Генератор открыт первым экраном: стили/общий runtime доступны без посещения панели (задачи 1, 3).
3. Уход до окончания загрузки: нет поздней активации/двойных обработчиков (задача 3).
4. Профиль без Mihomo: оболочка и Xray не запрашивают отсутствующий модуль (задача 4).
5. Исходники без Vite: разрешение xk-core не создаёт вторую копию состояния (задачи 2, 3).

## Карта файлов

- Новые pages/mihomo.module.entry.js, pages/mihomo.module.bundle.js: вход и реализация.
- Новый static/mihomo.module.css: специфичные стили, перенесённые из styles.css,
  panel-operator.css и других обнаруженных общих таблиц без дублирования правил.
- features/module_parts.js: запись загрузчика; pages/panel.mihomo.bundle.js: core-заглушка.
- pages/panel.lazy_bindings.runtime.js и pages/top_level_mihomo_generator_screen.js:
  потребители частей. pages/mihomo_generator.entry.js: только core bootstrap.
- pages/mihomo_generator.screen.bootstrap.js, mihomo_generator.init.js: модульная
  функциональность; общие side effects достигаются по публичным core-путям.
- pages/panel.module_loader.js: выделение существующей загрузки CSS в маленький
  общий helper ui/module_styles.js; прежний loader использует тот же helper.
- features/mihomo*.js, features/mihomo_clash/**, features/compat/mihomo*.js:
  межмодульные импорты. Внутренние импорты не переписывать без необходимости.
- vite.module.config.mjs, services/frontend_importmap.py: таблица сборки/исходного входа.
- scripts/build_modular_panel_release.py, xkeen-ui/scripts/module_profile_install.py:
  явное владение заглушками и ресурсами. Общая логика сборки остаётся прежней.
- Проверки границ/карт/установки, Node module_parts и новые Mihomo e2e.

Пути JS в карте отсчитываются от xkeen-ui/static/js; Python — от xkeen-ui,
если не указан корневой scripts/. Остальной список конкретных импортёров
получается обходом графа и фиксируется в журнале до массовой замены.

### Task 1: единый вход Mihomo и загрузка его частей/стилей

**Files:** новая пара mihomo.module.entry.js/mihomo.module.bundle.js, module_parts.js,
panel.mihomo.bundle.js, panel.lazy_bindings.runtime.js, top_level_mihomo_generator_screen.js,
mihomo_generator.entry.js, ui/module_styles.js, panel.module_loader.js;
tests/js/module_parts.test.mjs, новые tests/js/module_styles.test.mjs,
tests/test_mihomo_module_entry.py.

**Interfaces:** `loadModulePart('engine.mihomo', part): Promise<Module>` существующего
bridge; вход `load(part): Promise<Module>`, `activate(context): Promise<Api>`.
Части: bundle, import, proxy_tools, hwid_sub, clash, generator.
`generator` возвращает bootMihomoGeneratorScreen/getMihomoGeneratorTopLevelApi.
`ensureModuleStylesheet(key, href): Promise<boolean>` в ui/module_styles.js;
при повторе возвращает общий promise, при ошибке удаляет link/кеш и отклоняет promise.

- [ ] Добавить падающие проверки: неизвестная часть отклоняется; одновременные load
  используют кеш; compat выполняется в прежнем порядке; core-потребители не импортируют
  перечисленные приватные реализации напрямую. CSS: два вызова — один link,
  load завершает promise, error удаляет link, повтор создаёт новый.
- [ ] Запустить новые Node-тесты с tests/js/xk_core_hooks.mjs и pytest файла входа;
  убедиться, что новые проверки выявляют отсутствие входа/helper.
- [ ] Перенести aggregator в mihomo.module.bundle.js, создать вход с таблицей частей.
  До включения отдельной Vite-сборки заглушка может импортировать вход относительно.
  Перевести core-потребителей на bridge. Извлечь существующую CSS-логику без изменения
  поведения xterm; модуль готовит собственные стили до активации любой своей части.
- [ ] Повторить тесты; проверить загрузку существующей панели и генератора.
- [ ] Зафиксировать проверенный этап с автором владельца и русским сообщением;
  перед коммитом обновить описи по правилам проекта.

### Task 2: граница xk-core и отдельная сборка

**Files:** vite.module.config.mjs, services/frontend_importmap.py, module_parts.js,
panel.mihomo.bundle.js, приватные импорты Mihomo; scripts/build_modular_panel_release.py,
xkeen-ui/scripts/module_profile_install.py; tests/test_module_boundaries.py,
tests/test_frontend_importmap.py, tests/test_installer_xk_core_closure.py.

**Interfaces:** `SEPARATE_MODULES['engine.mihomo']` и `SOURCE_FALLBACKS['engine.mihomo']`
указывают `js/pages/mihomo.module.entry.js`; MODULE_ENTRIES и core-заглушка используют
`import('xk-module/engine.mihomo')`. Общие импорты — `xk-core/<путь от static>`.

- [ ] Расширить тесты таблицы модулей и графа: engine.mihomo обязателен, приватных
  исходников Mihomo нет в core manifest; относительных переходов границы нет;
  core-заглушка принадлежит core в обеих классификациях, modules/engine.mihomo — модулю.
  Проверить import map при активном, выключенном модуле и без Vite-манифеста.
- [ ] Запустить указанные pytest и зафиксировать ожидаемые падения новой границы.
- [ ] По графу заменить только межграничные импорты. Добавить реально необходимые
  публичные пути в явный тест CORE_PUBLIC_SURFACE. Включить отдельную сборку,
  поправить классификацию заглушек/генератора и убрать старую эвристику built Mihomo.
  Не переносить общий bootstrap в приватную сборку ради обхода проверки.
- [ ] Выполнить npm.cmd run frontend:build, затем проверки границ/карт/closure;
  все должны пройти. Проверить исходный режим тем же xk-core instance.
- [ ] Проверенный этап — описи и коммит по правилам владельца.

### Task 3: собственный CSS и сохранение жизненного цикла UI

**Files:** static/mihomo.module.css, static/styles.css, static/panel-operator.css,
mihomo.module.entry.js; новый e2e/mihomo_module_parts.spec.mjs,
e2e/panel_module_load_recovery.spec.mjs; существующие Mihomo и top-level спеки.

**Interfaces:** URL CSS задаётся в модуле через new URL относительно его входа,
в сборке ресурс принадлежит engine.mihomo; ensureModuleStylesheet из задачи 1
ожидается перед исполнением соответствующей части. Импорт входа не трогает DOM.

- [ ] До переноса сохранить настоящие снимки двух тем для журнала, редактора,
  модального окна и генератора. Добавить проверки загрузки CSS на первом входе
  в генератор, повторного входа, отсутствия лишних link и обработки ошибки CSS.
- [ ] Запустить новые проверки, подтвердить, что независимого ресурса пока нет.
- [ ] Перенести только собственные правила, сохранив порядок media/theme/каскада.
  Проверить всех потребителей смешанных правил перед их разделением. Удалить
  перенесённые правила из core. Общие xk-xlog и шапки не копировать.
- [ ] После frontend:build запустить новый спек, panel_module_load_recovery,
  Mihomo logs/import/HWID/validation/generator/DNS спеки и top_level_back_before_bundle_screens.
  Отдельно проверить уход во время загрузки и возврат без двойной инициализации,
  сохранение несохранённого текста и исходный режим без Vite.
- [ ] Сравнить снимки двух тем с исходными; разрешить только технические различия
  окружения, не маскировать изменения геометрии. Проверенный этап — описи и коммит.

### Task 4: профили, пакеты и доказательство независимости

**Files:** новый e2e/mihomo_module_absent.spec.mjs,
tests/test_installer_profile_frontend_closure.py, tests/test_module_packages_over_installer_profiles.py,
tests/test_module_release_inventory_chain.py; RELEASING.md.

**Interfaces:** профильные запуски используют существующий XKEEN_E2E_MODULE_PROFILE;
full/mihomo-minimal содержат Mihomo, xray-minimal/core-only — нет.

- [ ] Добавить проверки: без Mihomo нет его import map и сетевых запросов,
  оболочка/Xray работают; пакет содержит свой JS/CSS и манифест, установка в
  временную файловую систему замыкает все общие зависимости.
  Release-chain параметризовать Mihomo: внутреннее изменение проходит,
  изменение core даёт NEEDS_PANEL. Запустить и исследовать новые падения.
- [ ] Исправить существующую классификацию/closure только при подтверждённом дефекте;
  повторить pytest и профильные e2e, строго последовательно на порту 18188.
- [ ] В изолированной копии сохранить SHA256 всех распространяемых build-файлов.
  Изменить выполняемую строку приватного JS Mihomo, пересобрать: вне модуля 0
  изменений. Вернуть пробу. Отдельно изменить CSS: тот же результат. Затем
  изменить реализацию общего core helper: внутри модуля 0 изменений.
  Учитывать gzip; служебные отчёты сравнивать отдельно от runtime-ресурсов.
  Все пробы вернуть, результат и команды сохранить в локальном progress.md.
- [ ] Обновить RELEASING: используется общий механизм отдельных выпусков,
  первый пакет Mihomo требует базовой панели с новым разрезом. Проверенный этап
  — описи и коммит. Никаких тегов/публикации.

### Task 5: итоговое ревью, общие проверки и локальный архив

**Files:** .superpowers/sdd/2026-11-13-mihomo-module-separation/progress.md,
описи, память темы, .superpowers/handoff.md; новый локальный архив.

- [ ] Провести отдельное ревью границ, singleton, каскада и diff; исправить
  подтверждённые замечания с соответствующим тестом.
- [ ] Выполнить полный JS и Python наборы, проверку границ/сборки/упаковки.
  Логи сохранить локально. При падении e2e проверить воспроизводимость на чистой
  исходной базе в изоляции, не ослаблять тесты ради зелёного результата.
- [ ] Выполнить полный e2e:gate последовательно; результат и повторы записать честно.
- [ ] Собрать archive:user:skip-build после актуальной сборки, проверить состав,
  манифест Mihomo, владение CSS и SHA256. Отдельный пакет собрать штатным
  упаковщиком без выпуска тега. Установку проверить только в тестовой файловой системе.
- [ ] Обновить память/передачу с хэшами, результатами и ограничениями; выдать ссылки
  на архив и снимки. Пуш/тег/роутер остаются отдельными действиями владельца.

## Самопроверка плана

Граф/entry и singleton покрыты задачами 1–2; CSS/генератор/ошибки и визуальная
эквивалентность — 1 и 3; отсутствующий модуль/установка и измерения — 4;
общие проверки и доставка — 5. Все пять Review Focus имеют проверки в своих
задачах. Нового API обновления, механизма сборки и совместимости со старой базой
план не вводит. Рекомендуемый способ исполнения — native с одним итоговым ревью:
задачи последовательно меняют общий граф импортов и каскад CSS.
