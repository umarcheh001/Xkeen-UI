# Operator Console: Commands

Дата закрытия: 29 июля 2026 года.

Статус: **задача «Commands» Этапа 4 закрыта 29 июля 2026 года**.

## Результат

Команды переведены из capsule-сетки в компактные data rows. На широком экране группы распределяются по трём газетным колонкам без разрыва самой группы, на tablet — по двум, на mobile — в одну. Каждая строка внутри группы имеет три предсказуемые колонки: строковое имя команды, назначение и явное действие «Выполнить». Существующие `id`, `data-flag`, `data-label` и обработчик `.command-item` сохранены.

Повторяющийся prefix (`xkeen`/`panel`) остаётся в DOM только как совместимый runtime-узел и скрыт presentation-слоем. Каноническая строка передаётся через `data-command`: для XKeen это `xkeen <flag>`, для утилит — полное имя утилиты без добавленного prefix.

## Action contract

- `data-action="run"` явно обозначает единственное действие строки;
- `aria-label` сообщает полную команду, а `data-tooltip` сохраняет назначение;
- desktop использует три компактные колонки групп, tablet две, а mobile одну и переносит назначение под имя без горизонтального overflow;
- при запуске строка получает `aria-busy`, action показывает «Выполняется…», затем состояние возвращается независимо от результата PTY/lite terminal;
- PTY и fallback lite terminal, включая существующие API и сообщения об ошибках, не менялись.

## Сохранённые контракты

- каталог `COMMAND_GROUPS`, backend routes, terminal runtime и shell policy не менялись;
- utility commands сохраняют свои специальные `data-flag` и labels;
- prefix nodes не удалены, поэтому старые JS и внешние интеграции продолжают находить их;
- dark/light используют одни `--op-*` tokens, без gradient, glow, transform и pill-геометрии.

## Автоматические проверки

Статический контракт:

```text
python3 -m pytest tests/test_panel_operator_stage4_commands.py
```

Chromium-contract:

```text
npx playwright test e2e/panel_operator_stage4_commands.spec.mjs --project=chromium
```

Критерий задачи выполнен: команды сканируются как компактные строки данных без растягивания каждой записи на ширину экрана, prefix не повторяется визуально, а запуск каждой строки имеет один понятный action.
