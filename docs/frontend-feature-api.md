# Явный ESM API для feature-модулей

## Зачем нужен этот документ

Во фронтенде уже есть top-level feature registry и явные `get*Api()`-контракты, а migration stages 0-6 считаются закрытыми. Этот документ фиксирует, что считать canonical API в финальном состоянии stages 0-6 и как не размножать старые global-зависимости дальше.

## Freeze-ограничение для stages 0-3

Этот документ описывает уже post-bootstrap состояние. Новый feature-код не должен заново открывать ранние этапы миграции, то есть:

- не возвращать страницы к `legacy_script_loader.js` или `bootLegacyEntry(...)`;
- не превращать build wrapper assets в место для runtime-логики;
- не расходиться с canonical source entrypoints как источником истины для page graph.

## Официальный статус для stages 4-6

На текущем состоянии репозитория feature/runtime consumers для stages 4-6 считаются закрытыми:

- `window.XKeen.features.*` не является canonical read-path;
- routing, Mihomo, editor/json/terminal и page runtime читают состояние через import/getter/helper-layer;
- `window.XKeen.pageConfig` остаётся единственным server-owned runtime contract.

## Каноническая точка входа

Единый registry top-level feature API:

- `static/js/features/index.js`

Новый код должен импортировать API:

- либо напрямую из конкретного feature-модуля;
- либо из общего registry.

`window.XKeen.features.*` допустим только как compatibility path, но не как основной источник истины.

## Текущий набор top-level feature roots

На текущем состоянии репозитория registry включает:

- `backups`
- `brandingPrefs`
- `commandsList`
- `coresStatus`
- `devtools`
- `donate`
- `fileManager`
- `github`
- `inbounds`
- `layoutPrefs`
- `localIo`
- `mihomoGenerator`
- `mihomoHwidSub`
- `mihomoImport`
- `mihomoPanel`
- `mihomoProxyTools`
- `mihomoYamlPatch`
- `outbounds`
- `restartLog`
- `routing`
- `routingCards`
- `routingTemplates`
- `serviceStatus`
- `typography`
- `uiPrefsIo`
- `updateNotifier`
- `xkeenTexts`
- `xrayLogs`

## Нормальный контракт для feature-модуля

Для top-level feature-модуля целевая форма такая:

1. module-local reference на canonical API;
2. `get*Api()` как безопасная точка доступа;
3. named wrappers вроде `init*`, `load*`, `refresh*`, `open*` и так далее;
4. compatibility publish отдельно и только при необходимости.

Упрощённый pattern:

```js
let featureApiRef = null;

export function getFeatureApi() {
  return featureApiRef;
}

export function initFeature() {
  if (!featureApiRef) {
    featureApiRef = createFeatureApi();
  }
  return featureApiRef;
}
```

## Что уже хорошо выглядит в текущем проекте

- `static/js/features/index.js` существует и реально используется как registry;
- `lazy_runtime.js` для актуального Mihomo-среза уже умеет брать API через module getters и остаётся только узким runtime adapter;
- часть compatibility bridge уже вынесена в `static/js/features/compat/*`;
- второстепенные page init/runtime consumers уже ориентированы на ESM-first entry flow.

## Что остаётся в compat-слое после закрытия stages 0-6

После PR-A...PR-F canonical path уже считается закрытым:

- business-код не должен читать `window.XKeen.features.*` как source of truth;
- compat publish допустим только как узкий мост для старых скриптов;
- canonical imports/getters остаются обязательным путём для нового кода.

Что ещё может оставаться как допустимый compat/debt слой:

- отдельные `static/js/features/compat/*` bridge-модули;
- window-publish для старого кода, если canonical implementation не читает его обратно.

## Где compat bridge уже выделен явно

Сейчас отдельные compat-модули уже существуют для:

- `backups`
- `github`
- `inbounds`
- `local_io`
- `outbounds`
- `routing`
- `routing_cards`

Это хороший целевой паттерн: global bridge живёт отдельно, а не внутри canonical feature implementation.

## Как должен писать новый consumer

Предпочтительно так:

```js
import { restartLogApi, serviceStatusApi } from '../features/index.js';

restartLogApi.init();
serviceStatusApi.init();
```

Или так, если нужен конкретный модуль:

```js
import { getMihomoPanelApi, initMihomoPanel } from '../features/mihomo_panel.js';

initMihomoPanel();
const api = getMihomoPanelApi();
```

Нежелательный вариант для нового кода:

```js
const api = window.XKeen && window.XKeen.features
  ? window.XKeen.features.mihomoPanel
  : null;
```

## Практическое правило

Если модуль и consumer уже находятся внутри современного ESM-графа, связь между ними должна идти через import/getter path. Global namespace допустим только как временный мост для старого кода, который ещё не перевязан.
