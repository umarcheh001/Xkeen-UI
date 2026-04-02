# ADR 0001: frontend xkeen-ui использует build-managed ESM bootstrap

- Статус: Accepted
- Дата принятия: 2026-03-27
- Актуализировано: 2026-04-01

## Контекст

Фронтенд уже работает в смешанной, но явно ESM-first модели:

- Flask умеет отдавать entrypoints через manifest;
- source page entrypoints живут в `static/js/pages/*.entry.js`;
- production build использует thin wrappers из `static/frontend-build/assets/*.js`, которые импортируют canonical source entries;
- feature-код постепенно переводится на явный `get*Api()`-контракт.

При этом совместимость всё ещё локально присутствует:

1. `static/js/runtime/lazy_runtime.js` остаётся узким adapter для deferred shell/runtime paths;
2. `window.XKeen` всё ещё используется как bridge для части старого кода.

## Решение

Источником истины для frontend bootstrap считается ESM-managed source graph.

Это означает:

1. Page bootstrap строится из `import`/`export`, а не из списков legacy script URL.
2. Shared runtime подключается обычными импортами.
3. Canonical feature API живёт в модулях и доступен через явные getters.
4. Lazy loading делается через `import()` или build-managed wrappers без DOM script injection.
5. `window.XKeen` допускается только как compatibility namespace.
6. Flask ограничивается HTML, page config и asset resolution, но не оркестрирует script chain вручную.

## Что это меняет на практике

### Для page entrypoints

Новых consumers у `bootLegacyEntry(...)` быть не должно. Актуальные source entrypoints должны выглядеть как обычные ESM entry modules и завершаться вызовом `boot*Page()`.

### Для build output

Build assets не считаются отдельной архитектурой. Их задача только одна: быть thin bridge между manifest и canonical source entry.

### Для feature-кода

Новый feature-модуль не должен проектироваться вокруг `window.XKeen.features.*`. Если bridge нужен для старого consumer-а, он должен быть вторичным по отношению к module-local API.

## Историческая заметка про `legacy_script_loader.js`

Этот файл использовался как migration artifact на ранних этапах, но в текущем репозитории уже удалён. Возврат к нему считался бы архитектурным откатом, потому что он снова делает page bootstrap зависимым от ручной script-order orchestration вместо обычного ESM graph.

## Последствия

### Плюсы

- зависимости страницы становятся явными;
- manifest и source graph остаются согласованными;
- feature API можно постепенно de-globalize без переписывания всей страницы сразу;
- guardrails на migration становятся проще и честнее.

### Стоимость

- узкий compat-слой вокруг `window.XKeen` и `lazy_runtime.js` всё ещё нужно держать дисциплинированно;
- file manager и некоторые runtime consumers нельзя приводить к целевой модели одной механической заменой.

## Guardrails на переходный период

Пока миграция не доведена до конца:

- новые page entrypoints не используют `bootLegacyEntry(...)`;
- `lazy_runtime.js` не получает новых script-based loaders;
- новый cross-module contract не строится вокруг `window.*`;
- compatibility bridge должен быть локализован и по возможности вынесен в отдельный adapter.
