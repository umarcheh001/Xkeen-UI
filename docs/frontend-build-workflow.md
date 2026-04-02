# Frontend Build Workflow (Stage 7)

Этот документ фиксирует reproducible build workflow для фронтенда, который был введён на Stage 7 и остаётся действующим после полного закрытия stages 0-8.

## Что теперь считается canonical build path

В репозитории зафиксированы:

- `package.json` — минимальный frontend toolchain entrypoint;
- `package-lock.json` — lockfile для воспроизводимой установки;
- `vite.config.mjs` — build graph для canonical page entrypoints;
- `scripts/sync_frontend_vendor.py` — reproducible sync generated `static/vendor` runtime assets из `node_modules`;
- `scripts/verify_frontend_build.mjs` — проверка, что raw build graph и bridge graph не разъехались;
- `scripts/sync_frontend_build_manifest.py` — sync thin bridge wrappers для runtime contract stages 3/8.

## Два manifest-файла и зачем они нужны

На Stage 7 репозиторий осознанно держит **два связанных manifest-слоя**:

1. `xkeen-ui/static/frontend-build/.vite/manifest.build.json`

   Это **raw Vite manifest**. Он описывает реальный build output:

   - canonical page entrypoints;
   - hashed entry chunks;
   - shared/lazy chunks.

2. `xkeen-ui/static/frontend-build/.vite/manifest.json`

   Это **runtime bridge manifest**, который продолжает обслуживать текущий stage-3/stage-8 transition contract:

   - production/runtime path всё ещё смотрит на thin wrappers;
   - wrapper-файлы остаются import-only;
   - canonical source of truth для runtime bridge пока не меняется.

Такое разделение нужно специально:

- Stage 7 делает build **воспроизводимым**;
- Stage 8 опирается на тот же bridge manifest, но переводит production helper в build-only режим без page-by-page gating.

## Почему Vite здесь не тянет CodeMirror из npm graph

`codemirror6`-зависимости уже доступны в продукте через importmap и локальный vendor path в шаблонах.

Поэтому в `vite.config.mjs` эти specifier'ы помечены как `external`:

- build остаётся воспроизводимым;
- browser runtime продолжает использовать существующий importmap contract;
- Stage 7 не ломает stage-6 runtime/template contract.

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

При этом bridge manifest остаётся отдельным contract-слоем, через который normal production path резолвит build-managed wrappers, но его sync теперь входит в canonical `frontend:build`.

### 3. Проверка результата

```bash
npm run frontend:verify:static
```

Проверяется, что:

- runtime-required vendor assets для importmap/Prettier реально существуют;
- bridge manifest по-прежнему описывает только thin wrappers;
- wrapper-файлы остаются import-only;
- raw build manifest содержит все canonical page entrypoints;
- соответствующие build assets реально существуют.

### 4. Полная локальная проверка Stage 7

```bash
npm run frontend:verify
```

Эта команда:

1. пересобирает frontend через Vite;
2. проверяет raw build manifest;
3. проверяет bridge manifest/wrapper contract.

## Историческое ограничение Stage 7 и что изменилось на Stage 8

Исторически Stage 7 **не** делал production build-only: он фиксировал toolchain, но сознательно оставлял production helper в переходном состоянии.

На закрытом Stage 8 это уже доведено до целевого режима:

- production helper по-прежнему живёт через bridge manifest;
- thin wrappers по-прежнему импортируют canonical source entries;
- `ui_assets.py` теперь требует build-managed entry в normal production flow;
- source fallback разрешён только для dev/test/debug через явный `XKEEN_UI_FRONTEND_SOURCE_FALLBACK=1` или testing/debug context.

## Что считать успехом Stage 7

Stage 7 считается закрытым, когда одновременно выполняется всё ниже:

- новый разработчик может сделать `npm ci` и `npm run frontend:build` без ручного знания "откуда вообще взялась папка frontend-build";
- raw build manifest появляется из репозитория воспроизводимо;
- bridge manifest не дрейфует относительно canonical page entrypoints;
- build graph и runtime bridge graph проверяются отдельной командой;
- CI выполняет `npm ci` и `npm run frontend:verify` на frontend/toolchain-изменениях.

## Current CI and archive workflow

The current archive workflow is .github/workflows/build-user-archive.yml.

Current pipeline steps:
- `npm ci`
- `npm run frontend:build`
- `node scripts/verify_frontend_build.mjs`

CI and archive flow are aligned around the canonical `frontend:build` entrypoint, which now also performs vendor sync, wrapper sync and stale-file pruning.
