# I2 — Routing Mihomo и связанные формы

Закрыто: 31 июля 2026 года.

## Inventory и mapping

| Область | Действия | Semantic icons |
| --- | --- | --- |
| `#view-mihomo` | save, restart, menu, load config, node import, HWID, proxy tools, Zashboard, format, validate | `save`, `restart`, `more`, `download`, `add-node`, `hwid`, `tools`, `dashboard`, `format`, `validate` |
| Профили и бэкапы | refresh, save profile, clean, open, activate, preview, restore, delete | `refresh`, `save`, `trash`, `download`, `check`, `preview`, `restore` |
| Mihomo generator | back, add subscription/node, refresh subscriptions, import, normalize, preview toolbar, clear log, result/bulk-import controls | `back`, `add-node`, `refresh`, `import`, `normalize`, `format`, `restore`, `duplicate`, `save`, `validate`, `apply`, `trash`, `preview`, `close` |
| Import / Proxy tools / HWID | parse, download static proxies, insert, close, create static proxy, rename, prepare, replace, probe, apply restart | `format`, `download`, `add-node`, `close`, `edit`, `transfer`, `validate`, `restart` |
| Dynamic subscription rows | save interval, pause/play, refresh, detach, delete | `save`, `pause`, `play`, `refresh`, `detach`, `trash` |

## Контракт

- Статическая разметка использует `op_icon`, динамическая — только `XKeen.ui.operatorIcons` / `iconHtml`; локальные inline SVG и emoji-actions не используются.
- Иконки остаются декоративными (`aria-hidden`); icon-only controls сохраняют `aria-label`, `title` и tooltip.
- В allowlist добавлены только используемые Mihomo symbols: `add-node`, `apply`, `back`, `close`, `dashboard`, `detach`, `fullscreen`, `hwid`, `pause`, `play`, `preview`, `validate`.
- Проверка охватывает route `/mihomo_generator`; sprite входит в router archive как файл дерева `xkeen-ui/static/icons/operator.svg`.

## Проверки

- `pytest -q tests/test_operator_icons.py`
- `npm run frontend:verify`
- `npm run archive:user` (включая smoke проверки локального sprite в архиве)
