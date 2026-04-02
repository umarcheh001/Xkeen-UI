# Этап 6. Template/Runtime Contract: рабочий implementation plan

## Статус на 31.03.2026

Этап 6 завершён окончательно. Документ сохраняется как implementation record финального rollout-а `foundation -> dual-write -> consumer sweep -> cleanup`, который теперь уже полностью пройден и официально закрывает stages 0-6.

Финальное состояние репозитория:

- `templates/panel.html` и `templates/devtools.html` публикуют только `window.XKeen.pageConfig`;
- server-injected `window.XKeen.env.*` и `window.XKEEN_*` убраны из template runtime contract;
- `static/js/features/xkeen_runtime.js` читает canonical `pageConfig`, не использует raw-window fallback как canonical path и держит compat только в узком helper-layer;
- `ui/sections.js` и ключевые panel/file/static/github readers переведены на runtime/page-config helpers;
- guardrail-тесты фиксируют именно final state, а не transition dual-write фазу.

## Цель Этапа 6

Свести server-injected frontend config к одному понятному page-level contract и одному adapter-path чтения.

Эта цель достигнута, и итоговый статус больше не является переходным:

- templates больше не раздают разрозненные `window.XKeen.env.*` и `window.XKEEN_*` как ad hoc API;
- frontend читает page config через `xkeen_runtime.js`;
- переходный dual-write использовался только как промежуточный cutover и полностью убран из финального состояния.

## Граница этапа

Этот этап покрывает только server-injected runtime config, который приходит из Flask templates.

Вне прямого scope Stage 6:

- client-published globals вроде `window.XKEEN_CM_*`;
- editor-toolbar/runtime helper globals, которые создаются самим frontend;
- build toolchain и manifest path в `ui_assets.py` сверх того, что нужно для page-config helper.

Эти зоны относятся либо к более позднему cleanup, либо к Stage 7-9.

## Целевой контракт

Первый реалистичный target для текущего проекта:

```js
window.XKeen = window.XKeen || {};
window.XKeen.pageConfig = {
  contractVersion: 1,
  page: "panel",
  sections: {
    panelWhitelist: null,
    devtoolsWhitelist: null,
  },
  flags: {
    hasXray: true,
    hasMihomo: false,
    isMips: false,
    multiCore: false,
    mihomoConfigExists: false,
  },
  cores: {
    available: [],
    detected: [],
    uiFallback: false,
  },
  files: {
    routing: "",
    inbounds: "",
    outbounds: "",
    mihomo: "",
  },
  fileManager: {
    rightDefault: "/tmp/mnt",
  },
  github: {
    repoUrl: "",
  },
  static: {
    base: "/static/",
    version: "20260324d",
  },
};
```

Для `devtools` payload может быть существенно меньше:

```js
window.XKeen = window.XKeen || {};
window.XKeen.pageConfig = {
  contractVersion: 1,
  page: "devtools",
  sections: {
    panelWhitelist: null,
    devtoolsWhitelist: null,
  },
};
```

Почему target именно такой:

- `ui/sections.js` сейчас не является ESM-модулем, поэтому на первом проходе ему нужен синхронно доступный объект в `window.XKeen`, а не только модульный import path;
- `xkeen_runtime.js` является естественной точкой нормализации, а любой compat должен оставаться только внутри helper-layer, а не в бизнес-коде;
- это убирает разбросанные `window.XKEEN_*`, не forcing одновременную перестройку всего рантайма на JSON script tag или inline fetch.

## Главный rollout-принцип

Этап 6 был закрыт не одним большим commit-ом, а четырьмя проходами:

1. foundation helpers;
2. template dual-write;
3. consumer sweep;
4. final template cleanup.

Именно такая последовательность позволила не ломать `panel` и `devtools` в промежуточном состоянии.

## План по ключевым файлам

### `xkeen-ui/routes/ui_assets.py`

Роль в Stage 6: дать templates один нормализованный helper для page-config payload, не трогая пока build fallback mechanics.

Что сделать:

1. Добавить helper уровня `FrontendAssetHelper` для сборки page config.

Рекомендуемый API:

```python
def frontend_page_config(
    self,
    page_name: str,
    *,
    sections: dict[str, Any] | None = None,
    flags: dict[str, Any] | None = None,
    cores: dict[str, Any] | None = None,
    files: dict[str, Any] | None = None,
    file_manager: dict[str, Any] | None = None,
    github: dict[str, Any] | None = None,
    static: dict[str, Any] | None = None,
) -> dict[str, Any]:
    ...
```

2. Нормализовать shape и default values внутри helper-а, а не размазывать их по шаблонам.

3. Зарегистрировать helper как template global рядом с `frontend_page_entry_url`.

4. Не менять в этом этапе:
  - `_SOURCE_ENTRIES`
  - manifest logic
  - `XKEEN_UI_FRONTEND_BUILD_PAGES`
  - build/source selection behavior

Почему так:

- Stage 6 должен очистить contract, а не смешаться со Stage 7-8;
- `ui_assets.py` уже является логичной boundary-точкой для frontend page metadata.

### `xkeen-ui/static/js/features/xkeen_runtime.js`

Роль в Stage 6: стать единственным canonical adapter-path для чтения server-injected page config.

Что сделать в первом проходе:

1. Добавить новые helpers:

- `getXkeenPageConfig()`
- `getXkeenPageConfigValue(path, fallbackValue)`
- `getXkeenPageName()`
- `getXkeenPageSectionsConfig()`
- `getXkeenPageFilesConfig()`
- `getXkeenPageFlagsConfig()`
- `getXkeenPageCoresConfig()`

2. Перевести существующие helpers на схему "pageConfig first, legacy fallback second":

- `getXkeenWindowFlag(...)`
- `getXkeenBooleanFlag(...)`
- `hasXkeenXrayCore()`
- `getXkeenGithubRepoUrl()`

3. Не удалять raw-window fallback сразу. На время cutover он нужен, потому что часть consumers всё ещё читает старые поля напрямую.

Что сделать во втором проходе:

1. Добавить более предметные getters, чтобы consumers не знали shape payload:

- `hasXkeenMihomoCore()`
- `isXkeenMipsRuntime()`
- `getXkeenStaticBase()`
- `getXkeenStaticVersion()`
- `getXkeenFilePath(name, fallbackValue)`
- `getXkeenCoreAvailability()`
- `getXkeenFileManagerDefaults()`

2. После consumer sweep начать сужать generic raw helpers до legacy-compat роли.

Важно:

- `xkeen_runtime.js` не должен превращаться в dump произвольных `window.XKEEN_*`;
- новые exports должны описывать доменную семантику, а не имена глобалов.

### `xkeen-ui/templates/panel.html`

Роль в Stage 6: перестать быть источником десятка независимых frontend-global соглашений.

Текущее состояние:

- ранний inline-script кладёт `window.XKeen.env.panelSectionsWhitelist` и `window.XKeen.env.devtoolsSectionsWhitelist`;
- поздний inline-script кладёт весь `window.XKEEN_*` пакет:
  - `XKEEN_GITHUB_REPO_URL`
  - `XKEEN_STATIC_BASE`
  - `XKEEN_IS_MIPS`
  - `XKEEN_AVAILABLE_CORES`
  - `XKEEN_DETECTED_CORES`
  - `XKEEN_CORE_UI_FALLBACK`
  - `XKEEN_HAS_XRAY`
  - `XKEEN_HAS_MIHOMO`
  - `XKEEN_MIHOMO_CONFIG_EXISTS`
  - `XKEEN_MULTI_CORE`
  - `XKEEN_STATIC_VER`
  - `XKEEN_FILES`
  - `XKEEN_FM_RIGHT_DEFAULT`

План изменений:

1. Свести оба inline-script блока к одному `window.XKeen.pageConfig = ...`.

2. На безопасном промежуточном шаге сделать dual-write:
  - записать новый `window.XKeen.pageConfig`;
  - временно оставить legacy aliases, но уже derived from pageConfig, а не как отдельный source of truth.

3. После consumer sweep удалить:
  - `window.XKeen.env.*`
  - `window.XKEEN_*` server flags из шаблона

4. Оставить в шаблоне только:
  - DOM;
  - `window.XKeen.pageConfig`;
  - один page entrypoint `frontend_page_entry_url('panel')`.

Что не нужно делать в `panel.html` в рамках Stage 6:

- переносить theme/layout bootstrap в ESM;
- трогать общий layout markup;
- смешивать эту задачу с build wrapper cleanup.

### `xkeen-ui/templates/devtools.html`

Роль в Stage 6: привести devtools-template к тому же контракту, но в минимальном payload.

Текущее состояние:

- шаблон использует только `window.XKeen.env.panelSectionsWhitelist` и `window.XKeen.env.devtoolsSectionsWhitelist`.

План изменений:

1. Заменить inline `window.XKeen.env.*` на `window.XKeen.pageConfig.sections`.

2. На переходном шаге можно временно держать derived alias для `XKeen.env`, если `ui/sections.js` ещё не переведён.

3. После перевода `ui/sections.js` убрать alias полностью.

Финальный target:

- `devtools.html` знает только про page-config и entrypoint;
- никаких page-specific env-globals больше не создаёт.

## Consumer sweep, который следует сразу за этими файлами

После foundation/double-write останется пройтись по readers. Это отдельные рабочие коммиты, но их надо учитывать сразу.

Первая волна consumers:

- `xkeen-ui/static/js/ui/sections.js`
- `xkeen-ui/static/js/pages/panel.entry.js`
- `xkeen-ui/static/js/pages/panel.init.js`
- `xkeen-ui/static/js/pages/panel.core_ui_watch.runtime.js`
- `xkeen-ui/static/js/pages/panel.lazy_bindings.runtime.js`
- `xkeen-ui/static/js/ui/monaco_loader.js`
- `xkeen-ui/static/js/ui/last_activity.js`
- `xkeen-ui/static/js/ui/json_editor_modal.js`
- `xkeen-ui/static/js/ui/config_shell.js`

Вторая волна consumers:

- `xkeen-ui/static/js/features/routing.js`
- `xkeen-ui/static/js/features/inbounds.js`
- `xkeen-ui/static/js/features/outbounds.js`
- `xkeen-ui/static/js/features/backups.js`
- `xkeen-ui/static/js/features/github.js`
- `xkeen-ui/static/js/features/mihomo_panel.js`
- `xkeen-ui/static/js/features/mihomo_import.js`
- `xkeen-ui/static/js/features/mihomo_proxy_tools.js`
- `xkeen-ui/static/js/features/mihomo_hwid_sub.js`
- `xkeen-ui/static/js/features/file_manager.js`
- `xkeen-ui/static/js/features/file_manager/common.js`
- `xkeen-ui/static/js/features/file_manager/state.js`

Что важно:

- не все raw globals из проекта относятся к этому шагу;
- Stage 6 должен закрыть именно server-injected contract из `panel.html`/`devtools.html`, а не весь исторический `window.*` ландшафт за один раз.

## Recommended sequence of implementation commits

### Commit A. Foundation — выполнен

Файлы:

- `xkeen-ui/routes/ui_assets.py`
- `xkeen-ui/static/js/features/xkeen_runtime.js`
- tests под новые helpers

Результат:

- новый page-config helper уже есть;
- runtime уже умеет читать новый contract;
- templates пока можно не трогать или готовить под dual-write.

### Commit B. Template dual-write — выполнен

Файлы:

- `xkeen-ui/templates/panel.html`
- `xkeen-ui/templates/devtools.html`

Результат:

- `window.XKeen.pageConfig` уже появляется на страницах;
- старые globals ещё существуют только как переходный alias.

### Commit C. Consumer sweep — выполнен

Файлы:

- `ui/sections.js`
- panel runtime readers
- file/path/static-base/core-flag readers

Результат:

- canonical consumers читают page-config через `xkeen_runtime.js`;
- raw globals больше не нужны как runtime contract.

### Commit D. Final cleanup and guardrails — выполнен

Файлы:

- templates
- tests
- docs

Результат:

- из `panel.html` и `devtools.html` удалены `window.XKeen.env.*` и `window.XKEEN_*`;
- guardrails явно запрещают возвращение к старому контракту.

## Guardrails, которые надо добавить

### В `tests/test_frontend_feature_api_registry.py`

Нужно зафиксировать:

- новые exports в `xkeen_runtime.js`;
- page/runtime/file readers используют runtime helpers вместо raw `window.XKEEN_*`.

### В `tests/test_frontend_migration_guardrails.py`

Нужно зафиксировать:

- `panel.html` и `devtools.html` публикуют page-config contract;
- после cleanup в них нет `window.XKeen.env.*`;
- после cleanup в `panel.html` нет server-injected `window.XKEEN_*`.

### В `tests/test_frontend_build_fallback.py`

Нужно добавить минимум:

- `ui_assets.py` по-прежнему регистрирует `frontend_page_entry_url`;
- новый page-config helper существует и не ломает existing asset helper contract.

## Исторический первый практический шаг

Первый безопасный рабочий шаг Stage 6 был таким:

1. добавить `frontend_page_config(...)` в `ui_assets.py`;
2. добавить `getXkeenPageConfig(...)` и предметные getters в `xkeen_runtime.js`;
3. пока не удалять старые template globals;
4. после этого делать template dual-write.

Почему именно так:

- это минимизирует риск для `panel`;
- позволяет мигрировать consumers постепенно;
- не смешивает foundation с cleanup.

## Definition of Done для Stage 6

Этап 6 считается завершённым, и текущий репозиторий уже соответствует всем пунктам ниже:

- `panel.html` и `devtools.html` публикуют только единый page-config contract;
- `xkeen_runtime.js` является canonical path для чтения server-injected config;
- `ui/sections.js`, panel runtime и ключевые feature/UI readers больше не читают raw `window.XKeen.env.*` и `window.XKEEN_*`;
- tests запрещают возврат к старому template/runtime contract;
- Stage 6 не меняет build-mode semantics из `ui_assets.py`, оставляя Stage 7-8 отдельными этапами.


## Финальная фиксация authoritative contract

После финального cleanup canonical runtime contract считается закрытым только при одновременном выполнении всех пунктов ниже:

- `window.XKeen.pageConfig` остаётся единственным server-owned runtime contract для `panel` и `devtools`;
- canonical readers в `xkeen_runtime.js` читают `runtime.*`, `terminal.*`, `flags.*`, `files.*`, `static.*` только из `pageConfig`;
- бизнес-код не читает raw `window.XKEEN_*` и не опирается на `window.buildCmExtraKeysCommon` / другие window-fallback helpers напрямую;
- compat, если ещё нужен для старых скриптов, остаётся только за helper-layer и не является source of truth.
