# Frontend Build Workflow

Этот документ фиксирует текущий reproducible build workflow для фронтенда. Migration scope уже закрыт; дальше это living reference для install/build/verify path, а не stage-by-stage rollout note.

## Что теперь считается canonical build path

В репозитории зафиксированы:

- `package.json` — минимальный frontend toolchain entrypoint;
- `package-lock.json` — lockfile для воспроизводимой установки;
- `vite.config.mjs` — build graph для canonical page entrypoints;
- `scripts/sync_frontend_vendor.py` — reproducible sync generated `static/vendor` runtime assets из `node_modules`;
- `scripts/verify_frontend_build.mjs` — проверка, что raw build graph и bridge graph не разъехались;
- `scripts/sync_frontend_build_manifest.py` — sync thin bridge wrappers для runtime contract.

## Два manifest-файла и зачем они нужны

Репозиторий осознанно держит два связанных manifest-слоя:

1. `xkeen-ui/static/frontend-build/.vite/manifest.build.json`

   Это raw Vite manifest. Он описывает реальный build output:

   - canonical page entrypoints;
   - hashed entry chunks;
   - shared/lazy chunks.

2. `xkeen-ui/static/frontend-build/.vite/manifest.json`

   Это runtime bridge manifest:

   - production/runtime path смотрит на thin wrappers;
   - wrapper-файлы остаются import-only;
   - canonical source of truth для page graph остаётся в `static/js/pages/*.entry.js`.

Такое разделение нужно специально:

- source graph остаётся главным архитектурным контрактом;
- build output не живёт отдельной архитектурой;
- runtime bridge можно проверять и синхронизировать отдельно от raw build graph.

## Почему Vite здесь не тянет CodeMirror из npm graph

`codemirror6`-зависимости уже доступны в продукте через importmap и локальный vendor path в шаблонах.

Поэтому в `vite.config.mjs` эти specifier'ы помечены как `external`:

- build остаётся воспроизводимым;
- browser runtime продолжает использовать существующий importmap contract;
- frontend build не ломает page/runtime contract.

## Базовый workflow

### 1. Установка

macOS / Linux:

```bash
npm ci
```

Windows (PowerShell / cmd):

```bash
npm ci
```

### 2. Сборка

```bash
npm run frontend:build
```

Команда:

- синхронизирует `static/vendor` для CodeMirror importmap и офлайн Prettier fallback;
- генерирует raw build output;
- синхронизирует bridge manifest и thin wrappers;
- удаляет stale build-managed files, на которые текущие manifest'ы уже не ссылаются.

Результат записывается в:

- `xkeen-ui/static/vendor/`
- `xkeen-ui/static/frontend-build/assets/`
- `xkeen-ui/static/frontend-build/.vite/manifest.build.json`
- `xkeen-ui/static/frontend-build/.vite/manifest.json`

### 3. Статическая проверка результата

```bash
npm run frontend:verify:static
```

Проверяется, что:

- runtime-required vendor assets для importmap/Prettier реально существуют;
- bridge manifest по-прежнему описывает только thin wrappers;
- wrapper-файлы остаются import-only;
- raw build manifest содержит все canonical page entrypoints;
- соответствующие build assets реально существуют.

### 4. Полная локальная проверка

```bash
npm run frontend:verify
```

Эта команда:

1. пересобирает frontend через Vite;
2. проверяет raw build manifest;
3. проверяет bridge manifest/wrapper contract.

## Что должно оставаться верным

Текущий build workflow считается корректным, когда одновременно выполняется всё ниже:

- новый разработчик может сделать `npm ci` и `npm run frontend:build` без ручного знания "откуда вообще взялась папка frontend-build";
- raw build manifest появляется из репозитория воспроизводимо;
- bridge manifest не дрейфует относительно canonical page entrypoints;
- build graph и runtime bridge graph проверяются отдельной командой;
- CI и archive workflows используют тот же canonical build path, что и локальная сборка.

## Current CI and archive workflows

- `.github/workflows/ci.yml` выполняет `npm ci`, `npm run frontend:build`, `python -m pytest -q` и `node scripts/verify_frontend_build.mjs`.
- `.github/workflows/build-user-archive.yml` выполняет `npm ci`, `npm run frontend:build` и `node scripts/verify_frontend_build.mjs`.
- Локальная полная проверка по-прежнему доступна через `npm run frontend:verify`.
- CI и archive flow выровнены вокруг canonical `frontend:build`, который выполняет vendor sync, wrapper sync и stale-file pruning.
