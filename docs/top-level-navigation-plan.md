# План работ: убрать top-level document navigation между `/`, `/devtools` и `/mihomo_generator`

## Статус на 04.04.2026

Этот документ заменяет внешний черновик `README_obnovlennyy_plan_bez_podgruzok_2026-04-01.md` и приводит задачу к текущему состоянию репозитория.

Важно: это не переоткрытие frontend migration. Stages 0-9 уже закрыты и остаются frozen baseline. План ниже описывает новую незакрытую инициативу поверх уже зафиксированного ESM/build/runtime contract.

## Что именно здесь называется "подгрузками"

В этом документе под "убрать подгрузки" понимается:

- перестать делать full document navigation между `/`, `/devtools` и `/mihomo_generator` внутри уже открытого UI;
- перевести эти переходы на in-app navigation с `history.pushState(...)` / `popstate`;
- сохранить прямой вход по каждому URL.

Под это не подпадает:

- любой `import()` сам по себе;
- текущий split panel-бандлов (`panel.routing.bundle.js`, `panel.mihomo.bundle.js`);
- lazy entry для terminal/file manager;
- generic deferred loaders из `runtime/lazy_runtime.js`;
- build-managed manifest bridge и thin wrappers из `static/frontend-build`.

Иными словами: корневая проблема сейчас не в том, что в проекте вообще существуют lazy bundles, а в том, что три целевых top-level экрана до сих пор живут как разные HTML-документы.

## Короткий вывод

Старый черновик по направлению в целом верный, но его стартовая точка уже устарела.

Что остаётся верным:

- переходы между `/`, `/devtools` и `/mihomo_generator` всё ещё приводят к полной смене документа;
- `panel` уже имеет полезный shell/view lifecycle, на который можно опереться;
- `DevTools` и `Mihomo Generator` всё ещё page-bound и не переведены в top-level screen modules;
- `no-store` не является основной причиной проблемы; главная причина именно document navigation.

Что нужно переписать по сравнению с черновиком от 01.04.2026:

- нельзя снова открывать тему toolchain/build migration: она уже закрыта и зафиксирована в `docs/`;
- нельзя трактовать все dynamic imports как архитектурный долг, который надо убрать;
- нужно учитывать, что в репозитории уже 5 canonical page entrypoints, хотя текущий UX-проект целится только в 3 маршрута;
- нормализацию runtime contract для `mihomo_generator` нужно поднимать раньше, чем это было предложено в старом тексте.

## Актуальные ограничения и baseline

### 1. Frontend migration и build baseline уже закрыты

Это больше не рабочий поток и не часть этой задачи.

На сегодня уже зафиксированы:

- canonical source entrypoints в `xkeen-ui/static/js/pages/*.entry.js`;
- build-managed manifest bridge в `xkeen-ui/static/frontend-build/.vite/manifest.json`;
- reproducible build path через `npm ci` / `npm run frontend:build`;
- CI/archive workflow, использующие тот же build path;
- guardrail-тесты для stages 0-9 и для source/build contract.

Следствие: новый план не должен предлагать "сначала завести toolchain", "сначала вернуть source-only bootstrap" или любые откаты к legacy loader path.

### 2. В репозитории уже 5 canonical page entrypoints

Текущая карта страниц такая:

| Page | Route | Current model | Scope of this plan |
|---|---|---|---|
| `panel` | `/` | shell page с внутренними view и dynamic feature bundles | Да |
| `devtools` | `/devtools` | отдельный HTML-документ, eager page bootstrap | Да |
| `mihomo_generator` | `/mihomo_generator` | отдельный HTML-документ, page-bound generator bootstrap | Да |
| `backups` | `/backups` | отдельная canonical page | Пока нет |
| `xkeen` | `/xkeen` | отдельная canonical page | Пока нет |

Следствие: rollout должен проектироваться как расширяемый top-level shell для нескольких screen modules, но первая итерация может и должна ограничиться тремя основными маршрутами.

### 3. `/`, `/devtools` и `/mihomo_generator` всё ещё отдаются как разные HTML-документы

Сейчас это подтверждается server route layer и шаблонами:

- `xkeen-ui/routes/pages.py`
- `xkeen-ui/templates/panel.html`
- `xkeen-ui/templates/devtools.html`
- `xkeen-ui/templates/mihomo_generator.html`

Следствие: пока эти переходы оформлены как переходы между разными HTML-host страницами, браузер неизбежно делает document navigation.

### 4. `panel` уже имеет рабочий shell/view фундамент

Это важно и это надо использовать, а не выбрасывать.

Внутри `panel` уже есть:

- `panel_shell.shared.js` с `showView(...)` и переключением внутренних экранов;
- `panel.view_runtime.js` с `initViewOnce(...)` и реакцией на `xkeen:panel-view-changed`;
- `logs_shell.shared.js` с `activateView(...)` / `deactivateView(...)`;
- `config_shell.shared.js` с feature lifecycle для `routing`, `inbounds`, `outbounds`;
- intentional dynamic imports в `panel.entry.js` для routing/mihomo split bundles.

Следствие: для нового top-level shell правильнее переиспользовать существующие lifecycle-паттерны `panel`, а не изобретать новый runtime "с нуля".

### 5. Top-level переходы всё ещё делают hard navigation

Сейчас это видно в нескольких местах:

- в `panel.html` ссылка на DevTools остаётся обычным `href`;
- в `panel.html` кнопка "Mihomo Генератор" использует `data-nav-href`;
- в `panel_shell.shared.js` `wireExplicitNavigation()` переводит такой клик в `window.location.href = href`;
- в `mihomo_generator.html` и `devtools.html` header navigation тоже пока обычная.

Следствие: даже хороший internal shell внутри `panel` не решает проблему top-level UX, пока внешний переход всё ещё завязан на hard navigation.

### 6. `DevTools` остаётся eager page bootstrap

На сегодня `devtools.entry.js` статически тянет почти весь page graph сразу:

- shared shell/runtime слои;
- theme/layout/branding helpers;
- `features/devtools/shared.js`;
- `features/devtools/service.js`;
- `features/devtools/logs.js`;
- `features/devtools/env.js`;
- `features/devtools/update.js`;
- `features/devtools/terminal_theme.js`;
- compat layer и page init.

А `features/devtools.js` затем почти безусловно вызывает `init()` для всех секций.

Следствие: даже до перехода на top-level shell здесь есть смысл резать eager bootstrap на host + section initialization.

### 7. `Mihomo Generator` остаётся page-bound и до сих пор не выровнен по runtime contract

На сегодня у генератора есть плюсы:

- entry уже ESM-first;
- editor shared layers вынесены;
- в самом feature-модуле есть `afterNextPaint(...)` и `duringIdle(...)`.

Но архитектурно он всё ещё page-bound:

- `mihomo_generator.entry.js` просто поднимает страницу и вызывает `bootMihomoGeneratorPage()`;
- `mihomo_generator.init.js` ориентируется на page DOM как на единственный host;
- `mihomo_generator.html` не публикует canonical `window.XKeen.pageConfig`, в отличие от `panel` и `devtools`;
- в коде нет явного session restore / serialize/restore state для формы и preview.

Следствие: прежде чем делать полноценный keep-alive screen, генератор нужно привести к более предсказуемому runtime contract.

### 8. BFCache blockers стали меньше, но ещё не исчезли

На сегодня явные проблемные точки всё ещё есть:

- `xkeen-ui/static/js/features/routing.js`
- `xkeen-ui/static/js/features/xray_logs.js`

В них остаётся использование `beforeunload`, а часть cleanup-сценариев уже живёт на `visibilitychange`.

Следствие: для будущего back/forward и keep-alive режима нужно дальше вытеснять page-unload-ориентированные side effects в lifecycle hooks и мягкие page/session events.

### 9. Текущие lazy imports не нужно объявлять корнем проблемы

Они используются осознанно:

- внутри `panel.entry.js`;
- в `panel.lazy_bindings.runtime.js`;
- в `runtime/lazy_runtime.js`;
- в shell-слоях `logs_shell.shared.js` и `config_shell.shared.js`;
- в ряде feature/ui модулей для тяжёлых зависимостей.

Следствие: этот план не должен превращаться в кампанию "убрать все `import()`". Под запретом здесь не lazy loading как таковой, а полная смена HTML-документа на top-level переходах.

## Целевой результат

Завершённым решение считается, когда одновременно выполняются все условия:

1. Переходы между `/`, `/devtools` и `/mihomo_generator` внутри уже открытого UI не делают full document reload.
2. URL честно меняется через `history.pushState(...)` / `popstate`.
3. Прямой вход по каждому из этих URL остаётся рабочим.
4. `panel`, `devtools` и `mihomo_generator` живут как top-level screen modules с явным lifecycle.
5. `mihomo_generator` возвращается почти мгновенно с сохранённым состоянием.
6. `devtools` не стартует все тяжёлые секции заранее без надобности.
7. Existing source/build contract, page inventory и build-managed wrappers не ломаются.

## Что не входит в первую волну

- перевод `/backups` и `/xkeen` в top-level shell;
- глобальное удаление всех dynamic imports;
- пересмотр HTML cache policy и отказ от `no-store`;
- переписывание всего UI в SPA "с одной страницей любой ценой";
- переоткрытие stages 0-9 migration scope.

## Обновлённый план внедрения

## P0. Быстрые улучшения и выравнивание contract до shell-router

### P0.1. Ввести единый helper для top-level navigation controls

Что сделать:

- создать общий helper для внутренних top-level переходов, например `top_level_nav.shared.js`;
- подключить к нему panel/devtools/mihomo header controls;
- на этом шаге helper ещё может падать обратно в hard navigation, но место принятия решения должно стать единым.

Зачем:

- уменьшает будущий diff при переходе к router;
- убирает разрозненные `window.location.href` и ручные клики по `href` как основной кодовый паттерн.

### P0.2. Сузить BFCache blockers и page-unload зависимость

Точки аудита:

- `xkeen-ui/static/js/features/routing.js`
- `xkeen-ui/static/js/features/xray_logs.js`

Что сделать:

- перенести cleanup таймеров/WS/side effects на `visibilitychange`, `pagehide` и явные `deactivate` hooks;
- оставлять `beforeunload` только там, где действительно нужен unsaved-data guard, а не generic cleanup;
- подготовить код к тому, что screen может быть деактивирован без уничтожения документа.

### P0.3. Нормализовать runtime contract для `mihomo_generator`

Что сделать:

- привести `mihomo_generator` к тому же server-owned contract, что уже есть у `panel` и `devtools`;
- опубликовать canonical `window.XKeen.pageConfig` из шаблона генератора через `frontend_page_config(...)`;
- убрать необходимость полагаться на page-only assumptions там, где может жить нормализованный config.

Это нужно сделать до полноценного shell-rollout, иначе генератор останется самым "особенным" top-level экраном и будет тормозить следующий этап.

### P0.4. Добавить session restore для `mihomo_generator`

Что сохранить:

- выбранный профиль;
- состояние формы;
- текущий preview;
- выбранный editor engine;
- флаг edit mode;
- важные open/closed UI-состояния, если они влияют на повторный вход.

Ограничение:

- draft state лучше хранить в `sessionStorage`, а не в бессрочном `localStorage`, потому что в полях генератора могут быть чувствительные данные и URL подписок;
- поля с потенциально секретными токенами нужно либо исключить, либо сохранять только в безопасно нормализованном виде.

### P0.5. Разрезать DevTools на host и позднюю инициализацию секций

Что сделать:

- оставить `devtools.entry.js` canonical page entrypoint;
- вынести host bootstrap отдельно от section init;
- перестать поднимать `logs`, `update`, `env` и другие тяжёлые секции заранее, если пользователь ещё не открыл соответствующий таб/блок;
- особенно важно убрать безусловный preload логов на первой загрузке страницы.

Результат:

- это даст выигрыш и до shell-router, и после него;
- DevTools станет готов к screen lifecycle без тотального переписывания за один коммит.

## P1. Ввести общий top-level shell/router без ломки page inventory

### Базовый принцип

Новый router должен лечь поверх существующего baseline, а не спорить с ним.

Что сохранить:

- entry names `panel`, `devtools`, `mihomo_generator`;
- build-managed `frontend_page_entry_url(...)`;
- direct URL entry;
- current source/build manifest contract.

Что добавить:

- общий top-level shell bootstrap;
- route resolver;
- `navigate(...)`, `pushState`, `popstate`;
- registry top-level screen modules;
- централизованный hard-navigation fallback только для внешних URL, logout и аварийной деградации.

### Предпочтительная структура

Имена могут уточниться, но целевая структура выглядит так:

- `xkeen-ui/static/js/pages/top_level_shell.shared.js`
- `xkeen-ui/static/js/pages/top_level_router.js`
- `xkeen-ui/static/js/pages/top_level_screen_registry.js`

А существующие entrypoints должны стать thin wrappers, которые вызывают общий bootstrap с разным `initialScreen`.

### Lifecycle contract top-level screen

Минимальный контракт экрана:

- `mount(root, context)`
- `activate(context)`
- `deactivate(context)`
- `dispose()`

Для тяжёлых экранов дополнительно:

- `serializeState()`
- `restoreState()`

Опираться нужно на уже существующие паттерны:

- `panel.view_runtime.js`
- `logs_shell.shared.js`
- `config_shell.shared.js`

## P2. Перевести `mihomo_generator` в top-level screen первым

Почему первым:

- он даёт самый заметный UX-выигрыш от keep-alive;
- он уже частично оптимизирован по editor/runtime;
- его легче стабилизировать раньше, чем DevTools со множеством side effects.

Что сделать:

- отделить page bootstrap от screen bootstrap;
- держать editor/runtime живыми между `activate` и `deactivate`;
- корректно делать relayout/refresh при возврате;
- использовать session restore как fallback для тех сценариев, где screen всё же пересоздаётся;
- подключить route `/mihomo_generator` к top-level router без потери прямого URL входа.

Definition of Done:

- переход `panel <-> mihomo_generator` идёт без document reload;
- состояние формы и preview сохраняется;
- editor не пересоздаётся без необходимости;
- direct `/mihomo_generator` entry всё ещё работает.

## P3. Перевести `devtools` в top-level screen вторым

Почему вторым:

- у него уже сейчас слишком много eager side effects;
- сначала полезно разложить секции и таймеры, а уже потом включать keep-alive;
- иначе можно получить экран, который формально не выгружается, но продолжает бесконтрольно жить в фоне.

Что сделать:

- ввести DevTools host screen;
- разложить `service`, `logs`, `update`, `env`, `terminal_theme` и смежные части по section modules;
- вынести polling, streaming, intervals и подобные штуки в `activate` / `deactivate`;
- перестать считать "страница загружена" единственным жизненным циклом DevTools;
- подключить `/devtools` к top-level router.

Definition of Done:

- переходы `panel <-> devtools` и `mihomo_generator <-> devtools` идут без смены документа;
- тяжёлые секции не стартуют заранее;
- side effects корректно останавливаются на деактивации;
- повторный вход не плодит listeners, timers и подписки.

## P4. После стабилизации решить вопрос общего HTML host

Это не первый шаг, а уже consolidation stage.

Предпочтительный порядок:

1. сначала P0-P3;
2. потом решать, нужен ли единый host template или достаточно общего host partial.

Возможные варианты:

- единый top-level host template для `/`, `/devtools`, `/mihomo_generator`;
- временно оставить три шаблона, но свести их к одному shared host-каркасу и разным initial route/config.

Что важно:

- не начинать с гигантского merge всех шаблонов;
- не убирать `no-store` автоматически вместе с router-работой;
- отдельно решить, включать ли позже в этот host ещё и `/backups` с `/xkeen`.

## P5. Guardrails, tests и cleanup

Что нужно добавить после стабилизации:

- тесты на то, что top-level navigation больше не использует hard navigation как основной путь;
- тесты на `pushState` / `popstate` и route-to-screen mapping;
- тесты на `mihomo_generator` session restore и keep-alive contract;
- тесты на отсутствие повторного старта timers/listeners/WS в DevTools;
- тесты на то, что entrypoints остаются thin wrappers над shared shell bootstrap;
- обновление `docs/` и inventory/guardrails там, где изменится текущий contract.

## Чего делать не стоит

1. Не начинать с объединения всех шаблонов в один большой коммит.
2. Не объявлять все dynamic imports "вредными подгрузками".
3. Не переоткрывать закрытые workstreams про legacy loader, toolchain и manifest bridge.
4. Не включать DevTools keep-alive до декомпозиции timers/ws/polling.
5. Не переносить сразу `/backups` и `/xkeen` в первую волну, пока не стабилизированы три основные точки перехода.

## Рекомендуемый порядок внедрения

1. `P0.1-P0.5` — быстрые улучшения и выравнивание runtime contract.
2. `P1` — общий top-level shell/router.
3. `P2` — `mihomo_generator` как первый screen module.
4. `P3` — `devtools` как второй screen module.
5. `P4` — HTML host consolidation и при необходимости расширение scope.
6. `P5` — guardrails, cleanup, стабилизация.

## Практический итог

Правильная формулировка задачи на сегодня звучит так:

> Построить поверх уже закрытого ESM/build baseline общий top-level shell, который переведёт `/`, `/devtools` и `/mihomo_generator` с document navigation на in-app navigation, не ломая direct URL entry, current page inventory и build-managed production path.

Если нужен самый полезный стартовый набор работ, то он такой:

1. централизовать top-level navigation helper;
2. сузить `beforeunload` и прочие BFCache blockers;
3. дать `mihomo_generator` canonical `pageConfig` и session restore;
4. разленивить DevTools по секциям;
5. после этого вводить shared top-level router;
6. первым screen module переводить `mihomo_generator`, вторым — `devtools`.
