# Статус Roadmap: UX для схем Xray и Mihomo

## Назначение

Этот документ больше не описывает только "идеальный roadmap". Теперь это
рабочий статус-документ: что уже реализовано, что закрыто частично и что ещё
нужно доделать, чтобы довести schema-driven UX до финального состояния.

Цель остаётся прежней:

- не просто валидировать конфиг;
- а помогать новичку собрать рабочий блок без постоянного похода в внешние
  доки;
- и превращать редактор из "строгого валидатора" в "помощник по сборке
  конфига".

## North Star

Новичок должен уметь:

1. выбрать задачу вроде "добавить VLESS Reality proxy" или "создать url-test group";
2. вставить минимальный корректный блок одним действием;
3. получать направляющие подсказки по следующим обязательным полям;
4. видеть понятные объяснения ошибок человеческим языком;
5. применять типовые исправления в один клик;
6. в финале собирать базовый рабочий конфиг через guided actions плюс минимум
   raw-редактирования.

## Краткий итог аудита

- Phase 1: частично закрыта.
- Phase 2: закрыта.
- Phase 3: закрыта.
- Phase 4: закрыта.
- Phase 5: закрыта.
- Phase 6: пока не начата как полноценный слой.

Если смотреть на реальный UX-эффект, проект уже сильно продвинулся вперёд:

- schema hover и completion работают в CodeMirror 6 и Monaco;
- JSON/JSONC и YAML валидируются на уровне редактора;
- есть semantic validation;
- есть task-oriented snippets;
- есть quick fixes;
- есть beginner-mode hover и recovery hints.

Но до "финального результата" всё ещё не хватает двух вещей:

1. добить оставшиеся conditional/schema constraints;
2. добавить guided builders для самых частых beginner flows.

## Что Уже Реально Есть

- JSON Schema для Xray-фрагментов в `xkeen-ui/static/schemas/*.json`
- YAML Schema для Mihomo в `xkeen-ui/static/schemas/mihomo-config.schema.json`
- schema hover и completion в CodeMirror 6
- schema hover и completion в Monaco
- editor-level validation для JSON/JSONC и YAML
- отдельный semantic-pass поверх schema validation
- shared runtime для snippets и quick fixes
- task-oriented snippets для Xray и Mihomo
- Monaco code actions / quick fixes
- quick fix toolbar для CodeMirror / shared UI
- beginner-mode metadata и explain-first hover

## Phase 1: Обогащение Схем

Статус: частично закрыта

### Что закрыто

- В схемах уже много расширенных `description`, `examples` и `default`.
- Важные транспортные и routing-блоки заметно лучше документированы, чем раньше.
- Добавлены `deprecatedValues` и migration hints для части устаревающих
  transport-опций.
- Для Mihomo и части Xray-сущностей добавлены beginner-oriented metadata поля:
  `x-ui-explain`, `x-ui-use-case`, `x-ui-example`, `x-ui-warning`.
- Hover уже умеет показывать richer description, enum values, defaults,
  deprecation hints и beginner-блоки.

### Что закрыто частично

- `oneOf` используется, но не везде доведён до по-настоящему "человеческих"
  веток.
- Beginner metadata покрывает не все важные entry points одинаково ровно.
- Часть ограничений всё ещё зашита в `description`, а не выражена формально в
  schema.

### Что осталось доделать

- Добавить реальные conditional schema rules через:
  - `if/then/else`
  - `dependentRequired`
- Формально ограничить transport-specific комбинации там, где сейчас есть только
  текстовая подсказка.
- Добить coverage beginner metadata для оставшихся верхнеуровневых и
  frequently-touched узлов.
- Пройтись по Xray/Mihomo полям, которые уже имеют UX-важность, но до сих пор
  не получили нормальные `examples` или `default`.

### Когда можно считать Phase 1 закрытой

- hover остаётся богатым на основных блоках;
- важные поля имеют sane defaults и примеры;
- критичные conditional rules выражены не только словами, но и schema-логикой.

## Phase 2: Semantic Validation Поверх Схем

Статус: закрыта

### Что закрыто

- Есть отдельный shared semantic layer:
  - `xkeen-ui/static/js/ui/schema_semantic_validation.js`
- Для Mihomo уже ловятся:
  - missing `proxy-group.proxies` targets;
  - missing `proxy-group.use` providers;
  - missing `proxy-provider` / `rule-provider` references;
  - циклы между `proxy-groups`;
  - empty groups;
  - groups без `url` для `url-test` / `fallback` / `load-balance`;
  - transport option blocks на неподходящем `network`;
  - TLS-only поля без `tls: true`;
  - protocol-specific поля вроде `alterId` и `flow` не на том типе прокси;
  - rule target / rule-provider errors.
- Для Xray routing уже ловятся:
  - missing `outboundTag`;
  - missing `balancerTag`;
  - missing `inboundTag`;
  - duplicate `ruleTag`;
  - правило с несколькими route targets одновременно;
  - правило без target;
  - пустой `balancer.selector`;
  - отдельный warning по опасному порядку private-IP rule после negated geoip.
- Для Xray full config / fragment-level editor теперь ловятся:
  - duplicate `inbounds[].tag`, `outbounds[].tag`, `balancers[].tag`;
  - missing `proxySettings.tag` и `streamSettings.sockopt.dialerProxy`;
  - protocol-specific gaps внутри `settings.vnext` / `settings.clients` /
    `settings.servers`;
  - `balancer.selector`, который не матчится ни в один outbound tag/prefix;
  - missing `fallbackTag`;
  - `leastPing` без `observatory`;
  - `leastLoad` без `burstObservatory`;
  - `observatory.subjectSelector` / `burstObservatory.subjectSelector`, которые не матчятся ни в один outbound;
  - `reality` не на `protocol: vless`;
  - missing client/server Reality keys (`publicKey`, `privateKey`, `shortIds`);
  - mux + `grpc` / `xhttp`;
  - `xtls-rprx-vision` вместе с mux или `grpc` / `xhttp`.
- Generic JSON editor schema-loader теперь умеет автоматически подцеплять
  semanticValidation по `schemaKind`, а не только вручную в routing feature.
- Generic Monaco JSON path теперь тоже получает shared semantic markers, а не
  только schema-level diagnostics.
- Severity pipeline реально начала использовать `info` / `suggestion`, а не
  только `error` / `warning`.
- Semantic diagnostics уже реально доходят до editor runtimes.

### Что закрыто частично

- Часть Xray/Mihomo diagnostics всё ещё может звучать менее "domain-aware", чем
  хотелось бы для самых сложных transport/protocol сценариев, но это уже polish,
  а не blocker фазы.

### Что осталось доделать

- Обязательных blocker-задач для закрытия Phase 2 больше нет.
- Как optional polish можно добавить:
  - ещё более "domain-aware" hints по TLS/REALITY edge-cases;
  - дополнительные cross-file/context-aware checks там, где fragment ссылается
    на внешний блок;
  - ещё 2-3 Mihomo warnings для спорных, но формально валидных transport mixes.

### Когда можно считать Phase 2 закрытой

- неизвестные ссылки валидируются и объясняются явно;
- несовместимые комбинации полей ловятся до сохранения;
- semantic diagnostics покрывают не только routing, а весь основной UX Xray и
  Mihomo.

## Phase 3: Task-Oriented Snippets И Шаблоны Блоков

Статус: закрыта

### Что закрыто

- Есть shared snippets layer:
  - `xkeen-ui/static/js/ui/schema_snippets.js`
- Snippet providers подключены в:
  - routing editor
  - mihomo editor
  - json editor modal
  - Monaco
  - CodeMirror
- Для Xray уже есть snippets как минимум для:
  - routing rules
  - outbounds
  - inbounds
  - balancers
  - observatory
  - observatory + balancer scaffold
  - stream/transport settings
  - DNS block
- Для Mihomo уже есть snippets как минимум для:
  - proxies
  - proxy-groups
  - proxy-providers
  - rule-providers
  - rules
  - rule-provider + RULE-SET scaffold
  - DNS block
  - TUN block
  - sniffer block
- Контекстная выдача сниппетов стала точнее:
  - `proxy-providers` / `rule-providers` больше не предлагаются внутри вложенных
    provider-объектов;
  - array-snippets для Mihomo корректно работают и по numeric-path контексту из
    YAML runtime.
- Top beginner flows теперь закрыты коротким scaffold-путём:
  - VLESS Reality
  - proxy-group url-test
  - rule-provider + rule
  - observatory + balancer
- Keenetic-specific non-default blocks уже помечены warning-ами и не выглядят
  как baseline-by-default.
- Сниппеты в целом вставляют рабочие scaffold-блоки, а не пустые объекты.

### Что закрыто частично

- Можно ещё полировать ranking и wording отдельных snippet descriptions, но это
  уже quality-pass, а не blocker фазы.

### Что осталось доделать

- Обязательных blocker-задач для закрытия Phase 3 больше нет.
- Как optional polish можно добавить:
  - ещё более domain-aware ranking для сниппетов в спорных местах курсора;
  - 2-3 дополнительных support-driven scaffolds, если их реально подтвердит
    полевая практика.

### Когда можно считать Phase 3 закрытой

- новичок может вставлять типовые рабочие блоки без ручной сборки;
- вставленный блок сразу синтаксически валиден;
- Keenetic-specific dangerous defaults не выглядят как "рекомендуемый старт".

## Phase 4: Quick Fixes

Статус: закрыта

### Что закрыто

- Есть shared quick fixes layer:
  - `xkeen-ui/static/js/ui/schema_quickfixes.js`
- Quick fixes уже покрывают:
  - missing required fields;
  - scalar -> array coercion;
  - transport option block insertion;
  - replacement unknown tag/reference на ближайший существующий;
  - создание missing `proxy-group`, `proxy-provider`, `rule-provider`;
  - deprecated value replacement;
  - observatory / burstObservatory scaffolds для leastPing / leastLoad;
  - TLS/SNI safe-fixes (`tls: true`, `serverName` / `servername`);
  - некоторые semantic-fixes вроде подъёма LAN/private-IP rule вверх.
- Monaco получает code actions / quick fixes.
- CodeMirror и shared toolbar умеют применять best quick fix.
- Quick fix providers реально подключены в routing и Mihomo editors.
- Ranking/prioritization стала заметно ровнее:
  - replace-fix обычно идёт выше create-fix;
  - safe one-shot fixes приоритетнее общих scaffold-ов.
- Browser-level routing quick fix e2e стабилизирован:
  - stale load больше не перетирает более новые локальные правки;
  - toolbar quick fix стабильно срабатывает и в CodeMirror, и в Monaco.

### Что закрыто частично

- Можно ещё полировать wording/title отдельных fixes, но это уже quality-pass,
  а не blocker фазы.

### Что осталось доделать

- Обязательных blocker-задач для закрытия Phase 4 больше нет.
- Как optional polish можно добавить:
  - ещё несколько safe-fix сценариев для более спорных transport mixes;
  - дополнительный ranking-pass на редких edge-cases, где возможно несколько
    одинаково правдоподобных действий.

### Когда можно считать Phase 4 закрытой

- основные ошибки исправляются в одно действие;
- top-10 частых проблем действительно покрыты;
- quick fix UX стабилен и в runtime, и в e2e.

## Phase 5: Beginner Mode И Explain-First Hover

Статус: закрыта

### Что закрыто

- Beginner mode уже существует как реальный режим, а не только идея.
- В JSON и YAML hover есть support для:
  - простого объяснения;
  - use case;
  - примера;
  - warning-а;
  - doc link.
- `hint` уже прокидывается в diagnostics и показывается в редакторе как
  "Подсказка: ...".
- Pipeline severity уже понимает:
  - `error`
  - `warning`
  - `info` / `suggestion` / `hint`
- Есть UI setting для `beginnerModeEnabled`.
- Coverage `x-ui-*` metadata доведён на самых confusing/high-impact узлах:
  - Xray `streamSettings`, `security`, `tlsSettings`, `realitySettings`,
    `xhttpSettings`
  - Mihomo `proxy`, `proxyProvider`, `proxyGroup`, `ruleProvider`
  - Mihomo nested explain-first fields: `reality-opts`, `health-check`,
    `proxies`, `use`, `behavior`
- Explain-first hover теперь реально покрыт runtime-тестами и для JSON/Xray, и
  для YAML/Mihomo.
- Semantic producers начали использовать более мягкий уровень там, где warning
  слишком агрессивен (`alterId`, `flow`, `servername`-style suggestions).

### Что осталось доделать

- Обязательных blocker-задач для закрытия Phase 5 больше нет.
- Как optional polish позже можно:
  - добавить beginner metadata на менее частые edge-case поля;
  - расширить explain-first формулировки для совсем редких transport-веток;
  - при желании сохранить отдельный `suggestion` tier до UI вместо текущего
    общего `info`.

### Когда можно считать Phase 5 закрытой

- diagnostics и hover понятны без глубокого знания протоколов;
- hint/suggestion уровни используются не только инфраструктурно, но и по факту;
- beginner mode помогает, а не просто показывает больше текста.

## Phase 6: Guided Builders И Мастера

Статус: не начата как полноценная фаза

### Что пока есть как база

- Schema
- semantic validation
- snippets
- quick fixes
- beginner-mode hover

Этой базы уже достаточно, чтобы строить guided builders без большого
дублирования логики.

### Что осталось доделать

- Мастера для типовых сценариев:
  - добавить Xray routing rule;
  - добавить Mihomo proxy;
  - добавить Mihomo proxy-group;
  - включить DNS fake-ip;
  - включить sniffer;
  - добавить VLESS Reality transport block.
- Запись результата обратно в raw editor.
- Генерация только schema-valid и stylistically consistent блоков.

### Когда можно считать финальный результат достигнутым

- новичок может собрать базовый рабочий конфиг через guided actions плюс
  минимальные raw edits;
- raw editor остаётся основным advanced workflow;
- guided UX не ломает schema-driven single source of truth.

## Что Считать Уже Закрытым На Практике

- Базовая schema-driven UX-инфраструктура
- Shared schema/runtime helpers
- Monaco + CodeMirror parity по основным assist-функциям
- Semantic validation как отдельный слой
- Task-oriented snippets
- Quick fixes
- Beginner-mode foundation

## Что Осталось До Финального Результата

### Блок A: Довести до конца существующие фазы

- Phase 1: добавить настоящие `if/then/else` и `dependentRequired`, а не только
  текстовые описания зависимостей.

### Блок B: Сделать финальный UX-скачок

- Phase 6: guided builders для 4-6 самых частых beginner сценариев.

## Рекомендуемый Следующий Milestone

Если брать один короткий milestone, который даст максимальный реальный эффект,
лучший порядок сейчас такой:

1. закрыть оставшиеся formal constraints из Phase 1;
2. после этого начать Phase 6 с двух мастеров:
   - VLESS Reality proxy
   - Mihomo proxy-group/url-test

## Non-Goals

- полностью заменить raw editing;
- хардкодить всё знание о протоколах прямо в feature screens;
- превращать schema layer в runtime emulator;
- тратить время на редкие edge cases раньше, чем отполированы типовые beginner
  flows.
