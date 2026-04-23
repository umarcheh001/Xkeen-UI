# Roadmap: UX для схем Xray и Mihomo

## Назначение

Этот документ описывает практический roadmap, как превратить уже существующую
поддержку схем Xray JSON и Mihomo YAML в действительно дружелюбный редактор
конфигов, понятный даже новичку.

Цель не только в том, чтобы валидировать конфиг, но и в том, чтобы помогать
пользователю собирать правильный конфиг почти без внешней документации.

## Что уже есть

В проекте уже заложена хорошая база:

- JSON Schema для Xray-фрагментов в `static/schemas/*.json`
- YAML Schema для Mihomo в `static/schemas/mihomo-config.schema.json`
- schema hover и completion в CodeMirror 6
- schema hover и completion в Monaco
- editor-level validation для JSON/JSONC и YAML
- более богатые hover-подсказки для Xray JSON и в CM6, и в Monaco

Этого уже достаточно для опытного пользователя. Основной оставшийся разрыв в
UX сейчас не в валидации, а в сценарии "как правильно собрать рабочий блок с
нуля".

## North Star

Новичок должен уметь:

1. выбрать задачу вроде "добавить VLESS Reality proxy" или "создать url-test group";
2. вставить минимальный корректный блок одним действием;
3. получать направляющие подсказки по следующим обязательным полям;
4. видеть понятные объяснения ошибок человеческим языком;
5. применять типовые исправления в один клик.

Иными словами, редактор должен работать не как "строгий валидатор", а как
"помощник по сборке конфига".

## Принципы

- Лучше предотвращать ошибки, чем только подчёркивать их красным.
- Лучше вставлять готовый рабочий каркас, чем пустой объект.
- Лучше объяснять простыми словами, чем только терминами схемы.
- Лучше давать мягкие предупреждения для сомнительных конфигов и жёсткие ошибки
  только для действительно поломанных состояний.
- UX для Xray и Mihomo должен быть максимально единым, где это возможно.
- Источник истины должен быть один: сначала schema, затем semantic-слой, и
  только потом точечный UI-hardcode.

## Главные пробелы

Сейчас schema-based UX всё ещё плохо покрывает то, что важнее всего для
начинающего пользователя:

- cross-reference валидацию между именованными сущностями;
- task-oriented snippets и готовые шаблоны блоков;
- quick fixes для типовых ошибок;
- semantic-проверки совместимости связанных полей;
- пояснения и примеры "для человека";
- flow-level helpers, которые собирают рабочий блок, а не только подсказывают
  отдельное значение.

## Roadmap

## Phase 1: Обогащение схем

Приоритет: максимальный

Цель: сделать hover и completion полезнее без смены общей модели работы редактора.

### Scope

- расширить `description` у важных полей так, чтобы оно объясняло:
  - что делает поле;
  - когда оно обычно нужно;
  - когда его обычно можно не трогать;
- добавить больше `examples` для:
  - transport options;
  - routing rules;
  - proxy groups;
  - DNS-блоков;
  - sniffer-блоков;
- добавить больше `default`, где runtime-default известен и стабилен;
- добавить больше условных правил через:
  - `if/then/else`;
  - `dependentRequired`;
  - `oneOf` с более понятным смыслом веток;
- расширить `deprecated` и migration hints для устаревающих вариантов транспорта
  и параметров.

### UX-эффект

- richer hover;
- более полезный value completion;
- более понятные дефолтные вставки;
- меньше "формально валидных, но непонятных" подсказок.

### Основные файлы

- `xkeen-ui/static/schemas/xray-routing.schema.json`
- `xkeen-ui/static/schemas/xray-config.schema.json`
- `xkeen-ui/static/schemas/xray-inbounds.schema.json`
- `xkeen-ui/static/schemas/xray-outbounds.schema.json`
- `xkeen-ui/static/schemas/mihomo-config.schema.json`

## Phase 2: Semantic validation поверх схем

Приоритет: максимальный

Цель: ловить ошибки, которые plain JSON Schema / YAML Schema выражают плохо или
не выражают вовсе.

### Scope

- cross-reference validation для Xray:
  - `outboundTag`;
  - `balancerTag`;
  - `ruleTag`;
  - ссылки на реально существующие inbound/outbound tags;
- cross-reference validation для Mihomo:
  - `proxy-group.proxies`;
  - `proxy-group.use`;
  - `proxy-providers`;
  - `rule-providers`;
  - ссылки на реально существующие proxy/group/provider names;
- semantic-проверки совместимости:
  - transport-specific option blocks;
  - TLS-only поля без TLS;
  - protocol-specific поля на неподходящем протоколе;
  - взаимоисключающие настройки;
- warnings для подозрительных, но формально валидных конфигов:
  - пустые группы;
  - группы, ссылающиеся только на неизвестные прокси;
  - provider без нормального refresh interval;
  - route rule без действия или цели.

### UX-эффект

- меньше runtime-сюрпризов;
- меньше ситуаций "валидно, но не работает";
- более точные сообщения для ошибок в именах и несовместимых комбинациях полей.

### Основные файлы

- `xkeen-ui/static/js/ui/yaml_schema.js`
- `xkeen-ui/static/js/vendor/codemirror_json_schema.js`
- `xkeen-ui/static/js/ui/codemirror6_boot.js`
- `xkeen-ui/static/js/ui/monaco_shared.js`
- `xkeen-ui/static/js/features/routing.js`
- `xkeen-ui/static/js/features/mihomo_panel.js`

### Примечание

Этот слой лучше реализовывать как отдельный semantic-pass поверх schema
validation, а не пытаться насильно выразить всё через schema-хитрости.

## Phase 3: Task-oriented snippets и шаблоны блоков

Приоритет: максимальный

Цель: дать пользователю возможность вставлять рабочие строительные блоки одним действием.

### Scope

- структурированные вставки для Xray:
  - routing rule;
  - direct/block/proxy outbound;
  - balancer;
  - observatory;
  - transport settings;
- структурированные вставки для Mihomo:
  - proxy;
  - proxy-group;
  - proxy-provider;
  - rule-provider;
  - DNS block;
  - sniffer block;
  - TUN block;
- предпочтение минимальным рабочим scaffold-блокам вместо пустых объектов;
- по возможности адаптация шаблона под текущий контекст курсора.

### Пример

Вместо вставки:

```yaml
xhttp-opts: {}
```

вставлять:

```yaml
xhttp-opts:
  path: /
  mode: stream-one
```

А вместо вставки:

```json
"rules": []
```

давать возможность вставить:

```json
{
  "type": "field",
  "network": "udp",
  "port": "443",
  "outboundTag": "block"
}
```

### UX-эффект

- заметно быстрее собираются конфиги;
- новичку не нужно собирать блок вручную из доков;
- меньше синтаксических и структурных ошибок на старте.

## Phase 4: Quick fixes

Приоритет: высокий

Цель: превращать диагностику в действие, а не просто в сообщение об ошибке.

### Scope

- quick fixes для типовых сценариев:
  - добавить недостающее обязательное поле;
  - вставить отсутствующий transport option block;
  - заменить неизвестный tag на ближайший существующий;
  - создать отсутствующий proxy-group или proxy-provider;
  - заменить deprecated value на предпочтительный современный;
  - автоматически обернуть scalar в array, если ожидается список;
- показывать fixes в обоих редакторах там, где это возможно.

### UX-эффект

- снижение стоимости исправления ошибки;
- лучшая обучаемость прямо внутри редактора;
- меньше ручного исправления окружающего синтаксиса.

### Точки интеграции

- Monaco code actions / quick fixes;
- CM6 toolbar action или inline fix affordance;
- feature-level helper API для безопасных мутаций текста.

## Phase 5: Beginner mode и explain-first hover

Приоритет: высокий

Цель: сделать редактор менее пугающим для пользователя без глубокого протокольного опыта.

### Scope

- опциональный beginner-oriented hover:
  - простое объяснение;
  - типичный use case;
  - короткий пример;
  - предупреждение о частой ошибке;
- пояснение, почему поле показано именно здесь, особенно для conditional fields;
- разделение diagnostics по уровням:
  - error;
  - warning;
  - suggestion;
- короткие recovery hints в самих diagnostics:
  - что не так;
  - что обычно нужно использовать вместо этого.

### UX-эффект

- меньше когнитивной перегрузки;
- меньше походов во внешнюю документацию;
- редактор начинает обучать прямо по ходу работы.

## Phase 6: Guided builders и мастера

Приоритет: средний по сложности, но очень высокий по долгосрочной UX-ценности

Цель: дать возможность собирать типовые конфиги не только raw-редактированием.

### Scope

- мастера для типовых задач:
  - добавить Xray routing rule;
  - добавить Mihomo proxy;
  - добавить Mihomo proxy-group;
  - включить DNS fake-ip;
  - включить sniffer;
  - добавить VLESS Reality transport block;
- запись результата обратно в raw editor;
- генерация только schema-valid и stylistically consistent блоков.

### UX-эффект

- максимальный выигрыш для полного новичка;
- заметное снижение порога входа;
- сохранение совместимости с advanced raw editing workflow.

## Рекомендуемый порядок внедрения

Если делать поэтапно, то лучший порядок такой:

1. Phase 2: semantic validation
2. Phase 3: snippets и block templates
3. Phase 4: quick fixes
4. Phase 1: параллельное обогащение схем по мере необходимости
5. Phase 5: beginner hover polish
6. Phase 6: guided builders

Причина:

- semantic validation и snippets дают самый большой быстрый прирост UX;
- quick fixes превращают ошибки в рабочий процесс;
- guided builders дают максимальную ценность, но требуют уже хорошей базы.

## Предлагаемый внутренний metadata-слой

Чтобы не разносить UX-логику по каждому редактору отдельно, стоит добавить
небольшой shared metadata-layer поверх schema definitions.

Возможные custom metadata keys:

- `x-ui-title`
- `x-ui-group`
- `x-ui-example`
- `x-ui-insert-template`
- `x-ui-required-when`
- `x-ui-warning`
- `x-ui-doc-link`

Это должны быть editor-facing metadata, а не runtime semantics конфига.

## Конкретные точки интеграции в проекте

### Shared schema/runtime helpers

- `xkeen-ui/static/js/vendor/codemirror_json_schema.js`
- `xkeen-ui/static/js/ui/yaml_schema.js`
- `xkeen-ui/static/js/ui/editor_schema.js`

### Editor runtimes

- `xkeen-ui/static/js/ui/codemirror6_boot.js`
- `xkeen-ui/static/js/ui/monaco_shared.js`

### Feature wiring

- `xkeen-ui/static/js/features/routing.js`
- `xkeen-ui/static/js/features/mihomo_panel.js`
- `xkeen-ui/static/js/ui/json_editor_modal.js`

### Возможные новые shared modules

- `xkeen-ui/static/js/ui/schema_semantic_validation.js`
- `xkeen-ui/static/js/ui/schema_quickfixes.js`
- `xkeen-ui/static/js/ui/schema_snippets.js`

## Acceptance criteria по этапам

### После Phase 1

- hover становится заметно богаче на всех основных блоках;
- важные поля получают примеры и sane defaults;
- transport-specific поля лучше ограничены через schema.

### После Phase 2

- неизвестные ссылки валидируются и объясняются явно;
- несовместимые комбинации полей ловятся до сохранения;
- diagnostics говорят, что нужно переименовать, создать или связать.

### После Phase 3

- новичок может вставлять типовые рабочие блоки без ручной сборки;
- вставленный блок сразу синтаксически валиден.

### После Phase 4

- основные ошибки исправляются в одно действие;
- quick fixes покрывают хотя бы top-10 частых проблем.

### После Phase 5

- diagnostics и hover-подсказки понятны без глубокого знания протоколов.

### После Phase 6

- новичок может собрать базовый рабочий конфиг через guided actions плюс
  минимальные raw edits.

## Non-goals

- полностью заменить raw editing;
- жёстко хардкодить всё знание о протоколах прямо в feature screens;
- превращать schema layer в полноценный runtime emulator;
- пытаться покрыть все экзотические edge cases раньше, чем отполированы типовые
  beginner flows.

## Короткая рекомендация

Если брать только один короткий следующий milestone, то лучше всего делать:

- semantic reference validation;
- snippet insertion для типовых блоков;
- quick fixes для top-10 ошибок.

Именно эта комбинация даст больше реального UX-эффекта, чем просто дальнейшее
расширение схем само по себе.
