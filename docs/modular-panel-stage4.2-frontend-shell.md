# Подэтап 4.2. Выделение общего frontend shell

Статус: **закрыт 29 сентября 2026 года**.

Подэтап выделяет общий серверный shell панели, не перенося screen-specific
разметку и module-owned модальные окна. `panel.html` остаётся совместимой
точкой входа и composition root.

## Выделенные partials

```text
xkeen-ui/templates/panel/
├── macros.html
├── head.html
├── page_config.html
├── shell.html
├── header.html
└── navigation.html
```

Роли:

- `macros.html` — общий `op_icon`;
- `head.html` — doctype, `<html>`, `<head>`, host-assets, CSS и theme bootstrap;
- `page_config.html` — canonical `window.XKeen.pageConfig`;
- `shell.html` — `<body>`, startup fail-open, глобальный spinner, корневой
  container и global controls;
- `header.html` — branding, статус сервиса, core selector, resource summary,
  global actions и logout;
- `navigation.html` — top-level tabs и module-owned navigation slots.

## Composition root

`xkeen-ui/templates/panel.html` теперь:

1. импортирует `op_icon`;
2. подключает `panel/head.html`;
3. подключает `panel/shell.html`;
4. содержит прежнюю screen/modal разметку без её переноса на этом подэтапе;
5. сохраняет прежний footer, entrypoint scripts и порядок body-close.

Это сохраняет текущий route contract `render_template("panel.html")`, но
исключает дублирование shell-разметки при последующем выделении экранов.

## Static source composition

Для inventory и contract-тестов используется:

```text
scripts/panel_template_source.py
```

Он разворачивает локальные `panel/*` includes в эффективный статический
источник. Это нужно потому, что проверки DOM/API-контрактов должны анализировать
составной документ, а не только тонкий `panel.html`.

Генераторы Operator Console, icon inventory и Stage 4.1 contract используют
этот resolver.

## Сохранённые контракты

- DOM id, `data-view`, `data-xk-section`, `data-xk-shell` и `aria-*` не
  переименованы;
- `window.XKeen.pageConfig` публикуется в том же порядке до page entrypoint;
- stylesheet и host/theme assets сохраняют порядок;
- `panel.html` не содержит screen-specific shell-копию;
- routing, Mihomo, Xkeen, logs, commands, files и модальные окна остаются
  в composition root до подэтапов 4.3–4.4.

## Критерий завершения

Критерий готовности **выполнен**:

- общий shell вынесен в partials;
- `panel.html` стал composition root;
- Full/Legacy сохраняют shell и page bootstrap contract;
- static inventory и contract tests умеют анализировать composed template;
- screen-specific markup не перенесён и не продублирован в shell.
