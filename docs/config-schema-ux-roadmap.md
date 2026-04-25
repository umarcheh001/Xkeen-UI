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
- Phase 2: частично закрыта.
- Phase 3: почти закрыта.
- Phase 4: закрыта как MVP, нужна полировка.
- Phase 5: частично закрыта.
- Phase 6: пока не начата как полноценный слой.

Если смотреть на реальный UX-эффект, проект уже сильно продвинулся вперёд:

- schema hover и completion работают в CodeMirror 6 и Monaco;
- JSON/JSONC и YAML валидируются на уровне редактора;
- есть semantic validation;
- есть task-oriented snippets;
- есть quick fixes;
- есть beginner-mode hover и recovery hints.

Но до "финального результата" всё ещё не хватает трёх вещей:

1. добить conditional/schema constraints и semantic coverage до полного Xray/Mihomo сценария;
2. отполировать Phase 4-5 до состояния без явных UX-зазоров и флейков;
3. добавить guided builders для самых частых beginner flows.

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

Статус: частично закрыта

### Что закрыто

- Есть отдельный shared semantic layer:
  - `xkeen-ui/static/js/ui/schema_semantic_validation.js`
- Для Mihomo уже ловятся:
  - missing `proxy-group.proxies` targets;
  - missing `proxy-group.use` providers;
  - missing `proxy-provider` / `rule-provider` references;
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
- Semantic diagnostics уже реально доходят до editor runtimes.

### Что закрыто частично

- Xray semantic coverage по сути сейчас сосредоточена на routing, а не на полном
  config UX.
- Для Xray inbounds/outbounds/full config многие transport/TLS/protocol
  compatibility checks ещё не выражены как полноценный semantic-pass.
- Severity pipeline уже готов к `error` / `warning` / `suggestion`, но реальные
  producers почти всё ещё отдают только `error` и `warning`.

### Что осталось доделать

- Расширить Xray semantic validation с routing на:
  - `streamSettings`
  - `tlsSettings`
  - `realitySettings`
  - protocol-specific outbound/inbound checks
  - взаимоисключающие transport/security combinations
- Добавить больше Mihomo semantic checks для сомнительных, но формально
  валидных конфигов.
- Начать реально эмитить `suggestion`/`info` diagnostics там, где это полезнее,
  чем `warning`.
- Добиться более полной parity между schema-level и semantic-level diagnostic
  explanations.

### Когда можно считать Phase 2 закрытой

- неизвестные ссылки валидируются и объясняются явно;
- несовместимые комбинации полей ловятся до сохранения;
- semantic diagnostics покрывают не только routing, а весь основной UX Xray и
  Mihomo.

## Phase 3: Task-Oriented Snippets И Шаблоны Блоков

Статус: почти закрыта

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
  - stream/transport settings
  - DNS block
- Для Mihomo уже есть snippets как минимум для:
  - proxies
  - proxy-groups
  - proxy-providers
  - rule-providers
  - DNS block
  - TUN block
  - sniffer block
- Keenetic-specific non-default blocks уже помечены warning-ами и не выглядят
  как baseline-by-default.
- Сниппеты в целом вставляют рабочие scaffold-блоки, а не пустые объекты.

### Что закрыто частично

- Контекстная адаптация под текущее место курсора есть, но не для всех
  сценариев одинаково глубока.
- Не все типовые beginner flows ещё доступны как "один лучший scaffold" без
  выбора из нескольких вариантов.

### Что осталось доделать

- Дошлифовать context-aware snippet selection, чтобы реже предлагались
  нерелевантные варианты.
- Проверить, что top beginner tasks покрыты кратчайшим путём:
  - VLESS Reality
  - proxy-group url-test
  - rule-provider + rule
  - observatory + balancer
- При необходимости добавить ещё 2-3 high-value snippets для самых частых
  сценариев из поддержки/полевой практики.

### Когда можно считать Phase 3 закрытой

- новичок может вставлять типовые рабочие блоки без ручной сборки;
- вставленный блок сразу синтаксически валиден;
- Keenetic-specific dangerous defaults не выглядят как "рекомендуемый старт".

## Phase 4: Quick Fixes

Статус: закрыта как MVP, нужна полировка

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
  - некоторые semantic-fixes вроде подъёма LAN/private-IP rule вверх.
- Monaco получает code actions / quick fixes.
- CodeMirror и shared toolbar умеют применять best quick fix.
- Quick fix providers реально подключены в routing и Mihomo editors.

### Что закрыто частично

- Phase 4 пока больше "сильный MVP", чем финально отполированный UX.
- Не все quick fixes сопровождаются одинаково хорошим ranking/prioritization.
- Browser-level e2e по routing quick fix сейчас не полностью зелёный: есть
  race/flaky scenario вокруг загрузки исходного routing текста и cursor setup.

### Что осталось доделать

- Починить и стабилизировать routing quick fix e2e.
- Пройтись по top-10 реальных частых проблем и проверить, что на каждую есть
  либо fix, либо сознательное объяснение, почему fix не нужен.
- Доработать ranking/prioritization fixes, чтобы best fix почти всегда совпадал
  с ожидаемым действием пользователя.
- При необходимости добавить ещё несколько safe-fix сценариев для transport/TLS
  mismatches.

### Когда можно считать Phase 4 закрытой

- основные ошибки исправляются в одно действие;
- top-10 частых проблем действительно покрыты;
- quick fix UX стабилен и в runtime, и в e2e.

## Phase 5: Beginner Mode И Explain-First Hover

Статус: частично закрыта

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

### Что закрыто частично

- Beginner metadata покрывает не все важные schema nodes одинаково полно.
- "Почему поле показано именно здесь" пока закрыто только частично:
  conditional reasoning объясняется не везде.
- Severity tiers поддерживаются инфраструктурно лучше, чем реально используются
  semantic producers.
- Для части сложных протокольных полей hover уже богаче, но ещё не всегда
  достаточно "без глубокого знания темы".

### Что осталось доделать

- Добить coverage `x-ui-*` metadata на оставшихся high-impact fields.
- Добавить explain-first пояснения для conditional fields и частых confusing
  branches.
- Начать реально выдавать `suggestion` diagnostics там, где не нужен warning.
- Провести финальную beginner-polish волну по самым сложным местам:
  - Xray transport/security
  - Mihomo proxy/proxy-group/provider
  - routing target selection

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
- Quick fixes как MVP
- Beginner-mode foundation

## Что Осталось До Финального Результата

### Блок A: Довести до конца существующие фазы

- Phase 1: добавить настоящие `if/then/else` и `dependentRequired`, а не только
  текстовые описания зависимостей.
- Phase 2: расширить semantic validation на полный Xray config, а не только
  routing.
- Phase 4: стабилизировать routing quick-fix e2e и добить top-10 error flows.
- Phase 5: выровнять beginner metadata coverage и начать реально использовать
  `suggestion` tier.

### Блок B: Сделать финальный UX-скачок

- Phase 6: guided builders для 4-6 самых частых beginner сценариев.

## Рекомендуемый Следующий Milestone

Если брать один короткий milestone, который даст максимальный реальный эффект,
лучший порядок сейчас такой:

1. закрыть remaining gaps Phase 2 для Xray inbounds/outbounds/full config;
2. довести Phase 4 до стабильного green-state в e2e;
3. завершить Phase 5 polish на top confusing fields;
4. после этого начать Phase 6 с двух мастеров:
   - VLESS Reality proxy
   - Mihomo proxy-group/url-test

## Non-Goals

- полностью заменить raw editing;
- хардкодить всё знание о протоколах прямо в feature screens;
- превращать schema layer в runtime emulator;
- тратить время на редкие edge cases раньше, чем отполированы типовые beginner
  flows.
