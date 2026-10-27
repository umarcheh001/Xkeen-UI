# Mihomo «Узел»: закрытие Этапа 2 — state/API adapters

**Закрыт:** 26 октября 2026 года  
**Commit предыдущего этапа:** `52b78268`  
**Production scope:** frontend refactor без изменения DOM, CSS и визуального сценария

## Что изменено

### State adapter

Добавлен `xkeen-ui/static/js/features/mihomo_import_state.js`.

Он хранит только состояние importer-а:

- modal session id;
- source revision;
- request id и active request token;
- source/mode;
- selected groups и destination;
- warnings, base config revision и candidate;
- committed result и его revision.

Операции:

- `beginMihomoImportRequest()`;
- `isCurrentMihomoImportRequest()`;
- `commitMihomoImportResult()`;
- `invalidateMihomoImportResult()`;
- `resetMihomoImportState()`;
- `updateMihomoImportContext()`.

Late parse response больше не может закоммитить результат после изменения
source/mode или закрытия модала. Server-side work не отменяется этим guard-ом.

### API adapter

Добавлен `xkeen-ui/static/js/features/mihomo_import_api.js`.

Он нормализует:

- same-origin `fetch` для managed subscriptions;
- `core.http.postJSON` для parser/provider/patch endpoints;
- `ok === false`, HTTP status, `error.message` и response data.

`mihomo_import.js` больше не содержит прямых вызовов `fetch('/api/...')` и
не дублирует transport error handling для импортных endpoint-ов.

## Поведение, добавленное в Этапе 2

- Изменение source инвалидирует старый parse result и отключает `Вставить`.
- Изменение mode инвалидирует старый result.
- Закрытие модала инвалидирует текущую session.
- Повторный parse supersedes предыдущий request token.
- Insert проверяет, что result относится к актуальной source revision.
- State держит candidate/base revision поля для следующих этапов, но save/apply
  pipeline ещё не реализован.
- Public `getMihomoImportApi`, compat facade, `open`, `openWithInput`,
  synchronous generator helpers и DOM IDs сохранены.

## Что намеренно не сделано

- AbortController ещё не подключён к `core.http.postJSON`: текущий transport
  contract не гарантирует передачу signal на backend.
- Нет нового store framework и нет визуальной state machine в DOM.
- Нет batch patch optimization.
- Нет save/apply actions.
- Нет нового source/result/review UI.

## Проверки

- `node --test tests/js/mihomo_import_state.test.mjs` — 5 passed.
- `npx playwright test e2e/mihomo_import_modal_layout.spec.mjs --workers=1` — 7 passed.
- Targeted Python/API tests — 37 passed.
- `npm run frontend:verify:static` — passed.
- `node --check` для новых и изменённых ESM-файлов — passed.

## Acceptance

- [x] State и transport вынесены из основного importer-а.
- [x] DOM и CSS не менялись.
- [x] Public facade и legacy compatibility сохранены.
- [x] Source/mode edit invalidates result.
- [x] Late response после close не меняет новый session.
- [x] Unit, E2E, API и static frontend checks проходят.

**Этап 2 закрыт.** Следующий этап — Этап 3: компактный первый экран и общий
modal lifecycle. Его реализация может использовать этот state/API boundary, но
не должна возвращать transport или stale-result guards в монолитный UI-модуль.
