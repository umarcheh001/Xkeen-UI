# Frontend Page Inventory

## Что это за документ

Это человекочитаемое описание текущего page inventory. Источником истины остаётся сгенерированный snapshot:

- `docs/frontend-page-inventory.json`

Snapshot пересобирается скриптом:

```powershell
python .\scripts\generate_frontend_inventory.py --root . --json-out .\docs\frontend-page-inventory.json
```

Этот markdown-файл не пытается дублировать весь JSON побайтно. Он фиксирует его смысл и помогает быстро понять текущую схему страниц.

## Что inventory покрывает

Inventory фиксирует:

- route, template, entry и init для каждой страницы;
- static imports из page entrypoint;
- dynamic imports из page entrypoint;
- ESM bootstrap graph;
- direct globals и lazy-feature usage, если они видны из bootstrap graph;
- special inventory для `runtime/lazy_runtime.js`, если он входит в граф страницы.

## Что inventory не обещает

Inventory не является полным аудитом всего фронтенда. Он не гарантирует, что будут пойманы:

- все runtime-only глобальные зависимости вне bootstrap graph;
- все hidden consumers внутри legacy helper-файлов;
- все template-driven особенности, которые не выражены через entry/import graph.

Для этого нужны отдельные migration guardrails и код-ревью.

## Текущая карта страниц

| Page | Route | Template | Entry | Init | Комментарий |
|---|---|---|---|---|---|
| `panel` | `/` | `templates/panel.html` | `static/js/pages/panel.entry.js` | `static/js/pages/panel.init.js` | Главная страница. Entry остаётся каноническим source entrypoint, но теперь поднимается через shared top-level shell bootstrap и split bundles для routing и Mihomo; template публикует только canonical `window.XKeen.pageConfig` и использует shared top-level host partials для head/spinner/theme bootstrap. |
| `backups` | `/backups` | `templates/backups.html` | `static/js/pages/backups.entry.js` | `static/js/pages/backups.init.js` | ESM bootstrap через shared top-level shell wrapper и `backups.screen.bootstrap.js`; template публикует canonical `window.XKeen.pageConfig`, использует shared top-level host partials и остаётся частью того же five-route screen contract. |
| `devtools` | `/devtools` | `templates/devtools.html` | `static/js/pages/devtools.entry.js` | `static/js/pages/devtools.init.js` | ESM bootstrap с shared top-level shell wrapper и прямыми feature imports; template публикует только canonical `window.XKeen.pageConfig` и использует shared top-level host partials для head/spinner/theme bootstrap. |
| `xkeen` | `/xkeen` | `templates/xkeen.html` | `static/js/pages/xkeen.entry.js` | `static/js/pages/xkeen.init.js` | ESM bootstrap через shared top-level shell wrapper и `xkeen.screen.bootstrap.js`; template публикует canonical `window.XKeen.pageConfig`, использует shared top-level host partials и поднимает composite lifecycle для `service_status` и `xkeen_texts`. |
| `mihomo_generator` | `/mihomo_generator` | `templates/mihomo_generator.html` | `static/js/pages/mihomo_generator.entry.js` | `static/js/pages/mihomo_generator.init.js` | ESM bootstrap генератора Mihomo через shared top-level shell wrapper и shared top-level host partials для head/spinner/theme bootstrap. |

## Короткие выводы по текущей архитектуре

### `panel`

Текущее состояние:

- `panel.entry.js` импортирует shared shell/runtime слои;
- все пять canonical page entrypoints используют общий `top_level_shell.shared.js` как bootstrap-обёртку поверх canonical entrypoints;
- top-level переходы между `/`, `/backups`, `/devtools`, `/xkeen` и `/mihomo_generator` идут через фиксированный route map и `pushState`/`popstate`, а hard navigation остаётся только fallback-path для direct URL entry, missing screen и transition failure;
- feature bundles подгружаются динамически;
- `panel.routing.bundle.js` и `panel.mihomo.bundle.js` являются частью канонического page split;
- `runtime/lazy_runtime.js` всё ещё входит в bootstrap graph, но уже только как узкий generic runtime adapter.

Это уже не legacy page bootstrap. Для stages 0-9 migration contract считается закрытым; оставшийся хвост compat/debt в рамках этого плана уже добран.

### `backups`, `devtools`, `xkeen`, `mihomo_generator`

Текущее состояние:

- поднимаются через обычные `*.entry.js`;
- используют shared top-level shell bootstrap и в итоге вызывают `boot*Page()`/`boot*Screen()` без возврата к legacy page loader;
- участвуют в одном canonical top-level screen registry, поэтому normal-path переходы между всеми пятью маршрутами не меняют HTML-документ;
- hard navigation остаётся только fallback-path для direct URL entry, missing screen и transition failure;
- не используют `legacy_script_loader.js`;
- являются хорошим ориентиром для новых страниц и финального ESM-first baseline.

## Связь с build-managed production path

Manifest из `static/frontend-build/.vite/manifest.json` указывает на thin bridge-wrapper assets, которые импортируют canonical source entrypoints. Их содержимое синхронизируется скриптом `scripts/sync_frontend_build_manifest.py`. Это значит:

- production build не должен расходиться по архитектуре с source graph;
- page inventory можно строить по source entrypoints и считать его каноническим;
- wrapper-слой больше не считается ручным или "неизвестным" transitional artifact.

## Freeze contract для stages 1 и 3

Для уже закрытых ранних этапов inventory задаёт два жёстких правила:

- source entrypoints в `static/js/pages/*.entry.js` остаются канонической картой страниц;
- build-managed wrappers из `static/frontend-build/assets/*-*.js` не являются отдельной архитектурой и допустимы только как thin import-only bridge к canonical source entrypoints.

Это значит, что snapshot можно и нужно строить по source graph, а любые изменения manifest bridge не должны уводить production path в отдельный runtime-граф.

## Когда обновлять snapshot

Перегенерация `docs/frontend-page-inventory.json` нужна, когда меняется хотя бы одно из следующего:

- список страниц;
- `*.entry.js` или `*.init.js`;
- статический import graph page bootstrap;
- dynamic imports на уровне page entrypoint;
- поведение `lazy_runtime.js`, которое inventory уже фиксирует.

Если snapshot изменился, его нужно пересобрать скриптом и оставить тесты зелёными.
