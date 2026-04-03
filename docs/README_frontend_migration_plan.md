# Статус frontend migration

## Статус на 03.04.2026

Frontend migration закрыта: **stages 0-9 fully closed**.

Этот файл больше не является пошаговым rollout-планом. Он фиксирует закрытый migration scope, текущие guardrails и список living docs, которые нужно поддерживать в актуальном состоянии. Исторические stage-by-stage implementation plans удалены из `docs/` и не считаются актуальной рабочей документацией.

Актуальное состояние сверяется с:

- source entrypoints в `xkeen-ui/static/js/pages/*.entry.js`;
- runtime adapters в `xkeen-ui/static/js/features/xkeen_runtime.js`, `xkeen-ui/static/js/runtime/lazy_runtime.js` и terminal/runtime слоях;
- Flask templates и helper-слоем `xkeen-ui/routes/ui_assets.py`;
- manifest bridge в `xkeen-ui/static/frontend-build/.vite/manifest.json`;
- guardrail-тестами в `tests/`.

## Актуальные документы

- `docs/README.md` — карта документации;
- `docs/frontend-target-architecture.md` — архитектурный контракт;
- `docs/frontend-feature-api.md` — правила для feature API и compat-слоя;
- `docs/frontend-page-inventory.md` и `docs/frontend-page-inventory.json` — page inventory и его snapshot;
- `docs/frontend-build-workflow.md` — install/build/verify workflow;
- `docs/adr/0001-frontend-esm-bootstrap.md` — ADR про build-managed ESM bootstrap.

## Freeze для stages 0-3

Этапы 0-3 считаются закрытыми и замороженными.

- **Stage 0. Архитектурный контракт** — canonical source of truth живёт в `docs/frontend-target-architecture.md`, `docs/frontend-feature-api.md` и `docs/adr/0001-frontend-esm-bootstrap.md`.
- **Stage 1. Page inventory** — canonical page map строится по source entrypoints, а `docs/frontend-page-inventory.json` обязан оставаться синхронным с `scripts/generate_frontend_inventory.py`.
- **Stage 2. Secondary-page bootstrap** — `backups`, `devtools`, `xkeen` и `mihomo_generator` не имеют права возвращаться к `legacy_script_loader.js` или `bootLegacyEntry(...)`.
- **Stage 3. Panel bootstrap и manifest bridge** — `static/frontend-build/.vite/manifest.json` может указывать только на thin wrapper assets, а wrapper-файлы не должны содержать runtime-логики кроме import canonical source entrypoint.

Любые дальнейшие изменения по frontend должны идти только вперёд и не ломать этот frozen baseline.

## Что считается закрытым после stages 4-9

Этапы 4-6 уже закрыты и подтверждены кодом, guardrails и статусной документацией.

- `panel`/`devtools` публикуют только canonical `window.XKeen.pageConfig`;
- `window.XKeen.features.*` не является canonical read-path для нового кода;
- canonical runtime readers опираются на `pageConfig` и модульные helpers, а не на server-injected raw globals;
- `terminal.lazy.entry.js` и vendor adapter больше не делают DOM script injection.

Stages 7-9 тоже закрыты и теперь считаются частью обычного repository contract.

- reproducible build toolchain зафиксирован в `package.json`, `package-lock.json`, `vite.config.mjs` и связанных scripts;
- normal production path требует build-managed entry, а source fallback допустим только для dev/test/debug через `XKEEN_UI_FRONTEND_SOURCE_FALLBACK=1` или debug/testing context;
- `legacy_script_loader.js` удалён из репозитория и не участвует в runtime path;
- `lazy_runtime.js` остаётся только узким runtime adapter-слоем для generic deferred bundles и shell-bound feature API;
- dead compat aliases и transitional comments не должны возвращаться как новый product contract.

## Текущее состояние репозитория

- Есть 5 canonical page entrypoints: `panel`, `backups`, `devtools`, `xkeen`, `mihomo_generator`.
- Manifest bridge синхронизируется `scripts/sync_frontend_build_manifest.py` и указывает на thin wrappers, которые импортируют canonical source entries.
- Raw build manifest пишется в `xkeen-ui/static/frontend-build/.vite/manifest.build.json`.
- Локальный основной workflow остаётся таким: `npm ci`, `npm run frontend:build`, `npm run frontend:verify:static`; полная локальная проверка по-прежнему доступна через `npm run frontend:verify`.
- `.github/workflows/ci.yml` выполняет `npm ci`, `npm run frontend:build`, `python -m pytest -q` и `node scripts/verify_frontend_build.mjs`.
- `.github/workflows/build-user-archive.yml` выполняет `npm ci`, `npm run frontend:build` и `node scripts/verify_frontend_build.mjs`.

## Что считать регрессией

- возврат page entrypoints к `legacy_script_loader.js` или `bootLegacyEntry(...)`;
- превращение build wrappers в место для runtime-логики;
- возврат `lazy_runtime.js` или terminal lazy path к DOM script injection;
- использование `window.XKeen.features.*`, `window.XKeen.env.*` или `window.XKEEN_*` как canonical source of truth;
- возврат normal production flow к silent source fallback;
- расхождение checked-in docs с фактическим CI/build/runtime contract.

## Когда обновлять эту документацию

- при изменении page entrypoints, manifest bridge или inventory snapshot;
- при изменении server-owned `pageConfig` contract;
- при изменении feature registry или compat-границ;
- при изменении install/build/verify path, CI workflow или archive workflow;
- при появлении нового ADR, который меняет frozen contract stages 0-9.

## Что больше не поддерживается как активная документация

- отдельные implementation plan-документы по уже закрытым этапам;
- статусы вида «что ещё осталось до финала migration scope» для уже закрытых этапов;
- ссылки на устаревшие workflow-имена из старой CI-конфигурации;
- rollout-термины из переходного cutover-а как описание текущего состояния репозитория.
