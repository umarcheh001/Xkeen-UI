# План Доведения Frontend Migration До Финального Состояния

## Статус на 01.04.2026

Этот документ больше не пытается пересказывать ранний исторический план миграции. Он фиксирует:

- что уже реально завершено в текущем репозитории;
- что осталось до честного финала migration scope;
- в каком порядке это лучше закрывать;
- по каким критериям считать миграцию завершённой.

Документ синхронизирован с текущим состоянием:

- source entrypoints в `xkeen-ui/static/js/pages/*.entry.js`;
- manifest в `xkeen-ui/static/frontend-build/.vite/manifest.json`;
- routing/page/runtime/terminal cleanup, уже внесённый в код;
- актуальные guardrail-тесты;
- текущие Flask templates и `routes/ui_assets.py`.

## Короткий вывод

Этапы 0-3 считаются закрытыми и замороженными. Их не нужно переоткрывать как отдельный migration project: архитектурный контракт, page inventory, secondary-page ESM bootstrap и текущий manifest bridge уже являются текущей нормой репозитория.

Этапы 4-6 уже закрыты и подтверждены кодом, guardrails и статусной документацией. После PR-A...PR-F можно честно говорить, что **stages 0-6 fully closed**.

Этап 7 теперь тоже закрыт: reproducible frontend build toolchain зафиксирован в репозитории, build/verify workflow документирован и принудительно проверяется в CI.

Этап 8 тоже закрыт: production helper переведён в build-only режим, page-by-page gating убран, а source fallback больше не является обычным product path. Значит на текущий момент корректно говорить уже о **stages 0-8 fully closed**. Stage 9 теперь тоже закрыт: финальный compat/transitional хвост снят, `legacy_script_loader.js` удалён, `lazy_runtime.js` сужен до минимального адаптера, а мёртвые compat aliases убраны. Итоговая формулировка для текущего репозитория — **stages 0-9 fully closed**.

Фронтенд уже переведён на canonical ESM entrypoints, panel bootstrap не живёт через `bootLegacyEntry(...)`, `lazy_runtime.js` больше не вставляет `<script>` в DOM, а canonical feature/runtime/terminal слой de-globalized и опирается на `window.XKeen.pageConfig` как authoritative contract.

Migration scope по frontend-архитектуре можно считать завершённым: frozen compat/debt добран до финального минимального состояния и больше не образует отдельный открытый backlog.

## Как соотносится с исходным девятиэтапным планом

| Исходный этап | Текущее состояние | Комментарий |
|---|---|---|
| 0. Архитектурный контракт | Закрыт | В `docs/` уже есть target architecture, ADR и feature API contract. |
| 1. Page inventory | Закрыт | Есть генератор inventory, snapshot и тесты. |
| 2. Убрать `legacy_script_loader.js` со второстепенных страниц | Закрыт | `backups`, `devtools`, `xkeen`, `mihomo_generator` уже идут через ESM bootstrap. |
| 3. Panel bootstrap и production bridge | Закрыт | `panel.entry.js` canonical, manifest указывает на thin wrappers. |
| 4. Lazy loading mechanics | Закрыт | DOM script injection убран и из generic lazy runtime, и из terminal lazy path; загрузка vendor-слоя идёт через import-first adapter. |
| 5. Feature API de-globalization | Закрыт | Canonical feature/page/runtime/terminal слой переведён на adapters; compat publish остался только как узкий helper/compat path. |
| 6. Очистить Flask templates от переходных допущений | Закрыт | `panel`/`devtools` публикуют только canonical `window.XKeen.pageConfig`, canonical runtime readers опираются на `pageConfig` как authoritative contract, compat-path сужен до helper-layer. |
| 7. Сделать сборку воспроизводимой и явной | Закрыт | Toolchain, raw build manifest, verify workflow и CI enforcement уже зафиксированы в репозитории. |
| 8. Переключить production на build-only режим | Закрыт | `ui_assets.py` теперь требует build-managed entries в normal production flow; source fallback вынесен в dev/test/debug-only path. |
| 9. Финальная чистка технического долга | Закрыт | `legacy_script_loader.js` удалён, `lazy_runtime.js` narrowed, dead compat aliases и лишние transitional оговорки убраны. |

## Freeze для stages 0-3

До явного нового ADR или отдельного build-toolchain rollout-а ниже перечисленное считается frozen contract:

- **Stage 0. Архитектурный контракт** — canonical source of truth живёт в `docs/frontend-target-architecture.md`, `docs/frontend-feature-api.md` и `docs/adr/0001-frontend-esm-bootstrap.md`;
- **Stage 1. Page inventory** — canonical page map строится по source entrypoints, а `docs/frontend-page-inventory.json` обязан оставаться синхронным с `scripts/generate_frontend_inventory.py`;
- **Stage 2. Secondary-page bootstrap** — `backups`, `devtools`, `xkeen` и `mihomo_generator` не имеют права возвращаться к `legacy_script_loader.js` или `bootLegacyEntry(...)`;
- **Stage 3. Panel bootstrap и manifest bridge** — `static/frontend-build/.vite/manifest.json` может указывать только на thin wrapper assets, а wrapper-файлы не должны содержать runtime-логики кроме import canonical source entrypoint.

Практическое следствие: любые дальнейшие изменения по stages 4-9 должны идти только вперёд и не ломать этот frozen baseline.

## Что уже считается завершённым и не должно открываться заново

Ниже то, что больше не должно возвращаться в активный backlog как отдельный migration project:

- source entrypoints больше не используют `bootLegacyEntry(...)`;
- secondary pages уже работают как обычные ESM pages;
- `panel` уже split на canonical bundles и shared runtime layers;
- manifest-managed production wrappers уже указывают на canonical source entries;
- top-level feature API уже не должен строиться вокруг `window.XKeen.features.*`;
- terminal/runtime/page helper cleanup уже доведён до adapter-based модели;
- `lazy_runtime.js` больше не должен превращаться обратно в script loader.

Практическое правило:

- Stages 0-5 не перепридумывать;
- новый план начинается с текущей фактической точки, а не с возврата к уже закрытым шагам.

## Текущее фактическое состояние проекта

### Уже в хорошем состоянии

- Есть 5 canonical page entrypoints: `panel`, `backups`, `devtools`, `xkeen`, `mihomo_generator`.
- Manifest уже содержит thin wrappers `*-20260327a.js`, которые импортируют source entrypoints.
- Wrapper sync формализован скриптом `scripts/sync_frontend_build_manifest.py`, поэтому bridge-слой больше не считается "неизвестным артефактом".
- `lazy_runtime.js` не делает DOM script injection.
- `terminal.lazy.entry.js` больше не вставляет `<script>` в DOM и грузит xterm vendor-слой через import-first adapter.
- Canonical top-level features уже не используют `window.XKeen.features.*` как source of truth.
- `xkeen_runtime.js`, `mihomo_runtime.js` и `terminal/runtime.js` уже стали рабочими adapter-слоями.
- Terminal controller/module/runtime cleanup доведён до конца; raw `XKeen.terminal.*` остался только в compatibility comments.

### Что теперь считается финальным состоянием после stages 0-9

После закрытия Stage 9 актуальное состояние такое:

- `xkeen-ui/static/js/pages/legacy_script_loader.js` больше не существует в репозитории;
- `xkeen-ui/static/js/runtime/lazy_runtime.js` оставлен только как узкий runtime adapter для generic deferred bundles и shell-bound feature API;
- dead compat aliases и transitional comments добраны до финальной минимальной формы.

Это и есть реальный итоговый migration scope после полного закрытия stages 0-9.

## Новый план до финального результата

Ниже план уже не "с нуля", а от текущего состояния до финального завершения migration scope.

---

## Этап 6. Очистить Template/Runtime Contract

### Статус на 31.03.2026

Этап 6 закрыт окончательно. Финальный template/runtime contract доведён до целевого состояния и зафиксирован как часть fully closed stages 0-6:

- `templates/panel.html` и `templates/devtools.html` публикуют только canonical `window.XKeen.pageConfig`;
- `xkeen_runtime.js` больше не синхронизирует legacy aliases обратно в `window.XKeen.env.*` и `window.XKEEN_*`;
- `ui/sections.js`, panel runtime readers и file/static/github readers читают server-injected config через runtime/page-config helpers;
- migration guardrails переведены с transition-state на final-state проверки.

### Что именно было закрыто

1. В `routes/ui_assets.py` введён нормализованный helper `frontend_page_config(...)`.
2. `xkeen_runtime.js` стал canonical adapter-path для `pageConfig` и больше не держит runtime legacy alias syncing.
3. `panel.html` и `devtools.html` очищены от server-injected `window.XKeen.env.*` и `window.XKEEN_*`.
4. Guardrail-тесты теперь запрещают возврат к старому template/runtime contract и фиксируют финальный статус Stage 6 в docs.

### Definition of Done

Этап 6 закрыт и не должен открываться заново, пока одновременно остаются верны все ниже:

- `panel` и `devtools` публикуют только canonical `window.XKeen.pageConfig`;
- server-injected frontend config читается через `xkeen_runtime.js` и page-config helpers;
- templates не инжектят `window.XKeen.env.*` и `window.XKEEN_*` как runtime contract;
- tests запрещают возврат к переходному template/runtime contract.

---

## Этап 7. Завести Воспроизводимый Frontend Build Toolchain

### Статус на 01.04.2026

Этап 7 закрыт. Репозиторий больше не зависит от неформального знания "как вообще появился `frontend-build`": build path, raw manifest, verify workflow и CI enforcement уже оформлены как нормальный repository contract.

### Что именно было закрыто

1. В корне репозитория зафиксирован frontend toolchain:

- `package.json`;
- `package-lock.json`;
- `vite.config.mjs`.

2. Canonical build path стал воспроизводимым:

- `npm ci` устанавливает зависимости из lockfile;
- `npm run frontend:build` собирает canonical page entrypoints через Vite;
- raw build manifest пишется в `xkeen-ui/static/frontend-build/.vite/manifest.build.json`.

3. Build graph и runtime bridge graph больше не дрейфуют молча:

- `scripts/verify_frontend_build.mjs` проверяет raw build manifest, bridge manifest и thin wrappers;
- `scripts/sync_frontend_build_manifest.py` остаётся формализованным owner'ом bridge wrappers;
- build/toolchain guardrails покрыты тестами.

4. Build workflow больше не остаётся только локальным знанием:

- `docs/frontend-build-workflow.md` описывает install/build/verify path;
- `.github/workflows/python-ui-ci.yml` теперь запускает `npm ci` и `npm run frontend:verify`;
- CI подписан и на frontend/toolchain-изменения, а не только на Python-часть.

### Что Stage 7 сознательно НЕ делает

Stage 7 не переключает production на build-only режим. Это остаётся scope Stage 8:

- runtime bridge manifest пока остаётся отдельным контрактом;
- thin wrappers по-прежнему import-only и обслуживают текущий stage-3 bridge path;
- `ui_assets.py` ещё не очищен от build/source fallback semantics.

### Definition of Done

Этап 7 считается закрытым, пока одновременно остаются верны все ниже:

- frontend-build собирается из репозитория, а не живёт как "готовый артефакт неизвестного происхождения";
- raw build manifest воспроизводим из checked-in toolchain;
- есть явные команды `npm ci`, `npm run frontend:build` и `npm run frontend:verify`;
- CI автоматически проверяет, что source graph и build graph не разъезжаются;
- wrapper/runtime contract stages 0-3 не переоткрывается до Stage 8.

---

## Этап 8. Переключить Production На Build-Only Режим

### Статус на 01.04.2026

Этап 8 закрыт. `xkeen-ui/routes/ui_assets.py` больше не живёт в переходном режиме page-by-page build gating и не рассматривает source fallback как нормальный product path.

### Что именно было закрыто

1. `FrontendAssetHelper` больше не умеет выключать build по страницам. Normal production path всегда требует build-managed entry.

2. Source fallback изъят из обычного production-flow и оставлен только как dev/test/debug path:

- через явный `XKEEN_UI_FRONTEND_SOURCE_FALLBACK=1`;
- либо через debug/testing runtime context.

3. Missing build entry больше не скрывается молчаливым переходом на source entrypoint в normal production. В build-only режиме helper поднимает явную ошибку.

4. Guardrail-тесты теперь проверяют, что:

- текущие thin wrappers остаются рабочим production path;
- build-only mode не откатывается к silent source fallback;
- dev/test path всё ещё может осознанно включить source fallback для локальной диагностики.

5. Release/install path не требует дополнительных page-level switch'ей: архив `xkeen-ui-routing.tar.gz` упаковывает весь каталог `xkeen-ui/`, включая `static/frontend-build/`, поэтому normal install path получает build assets вместе с приложением.

### Definition of Done

Этап 8 считается закрытым, пока одновременно остаются верны все ниже:

- production использует build-managed entries как основной и нормальный режим;
- page-by-page build gating больше не существует в runtime helper;
- source fallback не является нормальным production mode;
- dev/test/debug может включить source fallback только явно или через testing/debug context.

---

## Этап 9. Финальная Чистка Compat И Transitional Debt

### Статус на 01.04.2026

Этап 9 закрыт. Финальный frozen compat/debt слой доведён до минимального и уже не выглядит как отдельная параллельная архитектура.

### Что именно было закрыто

1. `xkeen-ui/static/js/pages/legacy_script_loader.js` удалён из репозитория как больше неиспользуемый migration artifact.

2. `xkeen-ui/routes/ui_assets.py` больше не держит runtime-проверки на legacy loader внутри build wrappers. После Stage 8 canonical contract достаточно простой: build entry либо существует, либо normal production падает явно; drift guardrails остаются на уровне sync/tests, а не product helper.

3. `xkeen-ui/static/js/runtime/lazy_runtime.js` narrowed до минимального runtime adapter:

- сохранён только canonical `window.XKeen.runtime.lazy`;
- убран dead alias `window.XKeen.lazy`;
- наружу больше не торчат внутренние registry/loader-детали, которые не являются реальным public contract.

4. Статусная документация и guardrails обновлены под финальное состояние, где migration backlog по frontend architecture больше не открыт.

### Definition of Done

Этап 9 считается закрытым, пока одновременно остаются верны все ниже:

- `legacy_script_loader.js` отсутствует в репозитории и не участвует в runtime path;
- `lazy_runtime.js` остаётся узким adapter-слоем и не публикует лишние compat aliases;
- final compat/debt cleanup зафиксирован в docs, tests и inventory snapshot.

## Рекомендуемый порядок выполнения

Практически правильный порядок теперь такой:

1. Этап 6 — template/runtime contract;
2. Этап 8 — build-only production cutover;
3. Этап 9 — final compat/debt cleanup.

Все три пункта теперь закрыты. Именно в таком порядке это минимизировало риск:

- сначала стабилизируется runtime contract;
- затем появляется настоящий build path;
- потом production перестаёт жить на fallback;
- и только после этого безопасно добирается оставшийся frozen debt.

Этот порядок уже реализован в текущем репозитории как завершённая история миграции.

## Что считать честным финалом миграции

Migration scope можно считать завершённым, когда одновременно выполнено всё ниже:

- source entrypoints и page bootstrap полностью ESM-first;
- canonical feature/page/runtime/terminal код не использует legacy globals как source of truth;
- templates отдают frontend config через единый и понятный contract;
- frontend build воспроизводим из репозитория;
- production использует build-managed path как нормальный режим;
- frozen migration artifacts либо удалены, либо сведены к минимальному и явно изолированному compat-слою;
- guardrail-тесты защищают от отката по этим направлениям.

## Что не нужно смешивать с этим планом

В этот план не входят как обязательные условия завершения:

- полный редизайн frontend;
- полная переработка всех Jinja templates без архитектурной причины;
- уборка каждого старого файла в `static/frontend-build/assets/`, если manifest на него не указывает;
- косметическая чистка любого legacy JS, который не влияет на migration contract.

Это могут быть отдельные задачи после завершения migration scope, но не блокеры финала.

## Итог

Старый девятиэтапный план был полезен, чтобы довести проект до ESM-first архитектуры. Теперь этапы 0-9 закрыты полностью.

То есть миграция уже не "в начале пути" и не находится в открытом финальном хвосте. Она завершена на уровне frontend architecture contract, а дальнейшие изменения можно рассматривать уже как обычную продуктовую эволюцию, а не как migration cleanup.

## Детальный план для Этапа 6

Историческая рабочая разбивка Stage 6 по конкретным файлам сохранена в отдельном документе:

- `docs/frontend-stage6-implementation-plan.md`

Сейчас он нужен как implementation record и reference для финального contract cleanup, который уже доведён до завершённого состояния.
