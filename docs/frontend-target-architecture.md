# Целевая архитектура фронтенда xkeen-ui

## Для чего этот документ

Этот файл описывает целевой архитектурный контракт фронтенда в текущем репозитории. Он нужен не для исторической реконструкции, а для того, чтобы новые изменения не откатывали проект обратно в legacy-first схему.

## Целевой контракт

### 1. Страница = ESM entrypoint

Канонический bootstrap страницы должен жить в `static/js/pages/*.entry.js`.

Что это значит на практике:

- entrypoint поднимает страницу через обычные `import` и общий shell bootstrap, который в итоге вызывает `boot*Page()`;
- top-level entrypoints для `/`, `/backups`, `/devtools`, `/xkeen` и `/mihomo_generator` остаются thin wrappers над `bootTopLevelShell(...)` и screen bootstrap, без собственной DOM/network/runtime-логики;
- порядок зависимостей фиксируется модульным графом, а не URL-списком legacy-скриптов;
- source entry остаётся источником истины и для dev, и для build-managed production path.

Текущие canonical entrypoints:

- `panel.entry.js`
- `backups.entry.js`
- `devtools.entry.js`
- `xkeen.entry.js`
- `mihomo_generator.entry.js`

### 2. Shared runtime = обычные импорты

Shared-слои страницы подключаются через `import` из entrypoint или `*.shared.js`/`*.bundle.js` файлов.

Нормальная текущая модель:

- `panel.entry.js` импортирует shared shell/runtime, затем передаёт управление `top_level_shell.shared.js` и подгружает feature bundles;
- все пять canonical page entrypoints используют общий `top_level_shell.shared.js`, а page-specific boot остаётся в `*.screen.bootstrap.js` и `*.init.js`;
- top-level templates `/`, `/backups`, `/devtools`, `/xkeen` и `/mihomo_generator` могут оставаться отдельными, но общий host-каркас должен выноситься в shared Jinja partials вместо copy-paste head/spinner/theme bootstrap блоков;
- top-level router для `/`, `/backups`, `/devtools`, `/xkeen` и `/mihomo_generator` использует фиксированный route registry и `pushState`/`popstate` как normal path, а hard navigation остаётся только fallback-путём для direct entry, missing screen или transition failure.

### 3. Feature-модули = ESM с явным API

Новый и поддерживаемый контракт для feature-кода:

- модуль экспортирует `get*Api()`;
- модуль экспортирует явный `*Api`-объект и тонкие named wrappers;
- новый consumer получает API через прямой `import`, а не через поиск по `window.XKeen`.

Единая registry-точка для top-level features:

- `static/js/features/index.js`

### 4. Lazy loading = только через `import()` или build-managed loaders

Ленивая загрузка допустима только в двух формах:

- обычный `await import('./feature.js')`;
- build-managed wrapper, который сам в итоге приводит к `import()` и не требует DOM script injection.

Текущий пример:

- `panel.entry.js` динамически подгружает `panel.routing.bundle.js` и `panel.mihomo.bundle.js`;
- `lazy_runtime.js` остаётся только узким runtime adapter для generic deferred bundles и shell-bound feature API.

### 5. Flask-шаблоны не управляют порядком фронтенд-скриптов

Backend отвечает за:

- HTML;
- page config;
- manifest/source asset resolution через `routes/ui_assets.py`.

Backend не должен снова становиться местом, где руками оркестрируются feature-script chains.

### 6. Production path = build-managed bridge over canonical source entry

В production manifest указывает на thin wrappers из `static/frontend-build/assets/*.js`, которые импортируют canonical source entrypoints из `static/js/pages/*.entry.js`.

Это важное правило:

- source graph остаётся canonical;
- build output не должен жить своей отдельной архитектурной жизнью;
- normal production path обязан резолвить build-managed entry через manifest bridge;
- source fallback допустим только для dev/test/debug режима и не считается нормальным product path.

## Оставшиеся compatibility-слои

### `static/js/runtime/lazy_runtime.js`

Текущий статус:

- это уже не DOM script loader и не transitional framework;
- он остаётся только узким runtime adapter между shell/page code и deferred feature API;
- page-specific lazy branches должны жить локально, а не разрастаться внутри него.

Допустимое направление только одно: держать этот файл узким и не превращать его обратно в общий migration bucket.

### `window.XKeen`

Текущий статус:

- root namespace и compatibility bridge;
- не должен быть primary API surface для нового ESM-кода.

Нормальный современный порядок такой:

1. module-local API;
2. `features/index.js` или direct module import;
3. compatibility publish в `window.XKeen` только если это действительно нужно для старого consumer-а.

## Что считается готовой миграцией

Миграцию frontend bootstrap и feature API можно считать завершённой, когда одновременно выполняются все условия:

- page entrypoints не используют `bootLegacyEntry(...)`;
- `legacy_script_loader.js` отсутствует как активный runtime artifact;
- build wrappers остаются thin и импортируют canonical source entrypoints;
- `lazy_runtime.js` не делает DOM script injection и не растёт как отдельный runtime framework;
- новые feature-модули не строятся вокруг `window.XKeen`;
- canonical feature API живёт в модуле и доступен через явный `get*Api()`;
- compatibility bridges либо локализованы, либо удалены.

## Краткая памятка для новых изменений

Можно:

- добавлять новый page entrypoint как обычный ESM-модуль;
- импортировать feature API напрямую из `static/js/features/*.js` или `static/js/features/index.js`;
- делать lazy loading через `import()`;
- держать временный bridge локальным и документированным.

Нельзя:

- возвращать `bootLegacyEntry(...)` в source entrypoints;
- добавлять новые script-based lazy loaders;
- плодить новые `window.*` алиасы без реального legacy-consumer-а;
- считать `window.XKeen.features.*` canonical API для нового кода.
