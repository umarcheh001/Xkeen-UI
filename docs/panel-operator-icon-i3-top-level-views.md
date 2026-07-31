# I3 — остальные top-level views основной панели

Закрыто: 31 июля 2026 года.

## Inventory и semantic mapping

| Область | Действия | Semantic icons |
| --- | --- | --- |
| Header / global | theme, UI settings, logout и текстовая top navigation | `sun`, `moon`, `settings`; текстовые controls остаются текстовыми |
| Порты и команды | save, text-first run rows, restart-log filters, refresh/clear/copy/fullscreen | `save`, `refresh`, `clear`, `duplicate`, `fullscreen`, `fullscreen-exit`; строки run остаются text-first actions |
| Логи Xray | view, enable/stop, pause/resume, clear buffer/files, copy, devices, filter clear, more, fullscreen | `search`, `play`, `stop`, `pause`, `clear`, `trash`, `duplicate`, `devices`, `close`, `more`, `fullscreen`, `fullscreen-exit` |
| Файлы: static toolbar | volumes, operations, root/home, up, refresh, filter clear, help | `storage`, `list-details`, `home`, `move-up`, `refresh`, `close`, `help` |
| Файлы: dynamic controls | terminal, create folder/file, upload/download, clear trash, retry/reset filter, context-menu actions, bookmarks, fullscreen | `terminal`, `folder-add`, `file-add`, `upload`, `download`, `clear`, `refresh`, `open`, `duplicate`, `transfer`, `edit`, `trash`, `restore`, `compare`, `permissions`, `owner`, `settings`, `bookmark`, `fullscreen`, `fullscreen-exit` |
| States | loading/error/warning/success are state containers, not competing action glyphs | `loading`, `alert`, `warning`, `check` where a visual phase marker is needed |

## Контракт

- Статическая разметка использует `op_icon`; динамические элементы импортируют только `iconHtml` из `js/ui/operator_icons.js`. Feature-local SVG paths не добавлены.
- Icon-only controls сохраняют `title` и `aria-label`; controls с видимой подписью добавляют декоративный SVG и сохраняют текст в `.xk-action-label`.
- Одинаковые операции во всех top-level views имеют одно XKeen-имя: `refresh`, `clear`, `duplicate`, `trash`, `fullscreen`/`fullscreen-exit`, `play` и `stop`.
- Status color остаётся у state-container (`data-tone`, error/warning classes); SVG получает `currentColor` и не хранит свой semantic color.
- Быстрые пути и управление избранным используют `bookmark`/`settings`; presentation emoji (`📌`, `⭐`, `🗑`, `⛔`) удалены из action controls и подписей этого dialog.
- Content-type marks в файловой таблице (`📁`, `📄`, `🔗`, `💽`) не являются actions. Они остаются явным I3-исключением до отдельного inventory контентных/статусных меток. Terminal и прочие modal families не входят в I3 и перейдут в I4.

## Static guard

`tests/test_operator_icons.py` проверяет для закрываемой top-level области:

- наличие required semantic names в static markup;
- использование `iconHtml` в динамических File Manager, Xray Logs, restart-log и theme controls;
- отсутствие emoji-action и feature-local inline SVG в закрытых view controls;
- детерминированное соответствие allowlist и committed sprite.

## Проверки

- `python -m pytest -q tests/test_operator_icons.py tests/test_panel_operator_stage4_files.py tests/test_panel_operator_stage4_logs.py tests/test_panel_operator_stage4_commands.py tests/test_panel_operator_stage4_ports.py`
- `npm run frontend:verify`
