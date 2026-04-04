# Итог: top-level navigation между `/`, `/devtools` и `/mihomo_generator`

## Статус

Документ больше не является активным implementation plan.

На 04.04.2026 эта инициатива закрыта полностью:

- top-level переходы между `/`, `/devtools` и `/mihomo_generator` переведены с full document navigation на in-app navigation;
- direct URL entry для всех трёх маршрутов сохранён;
- введены общий top-level shell/router и screen registry;
- `mihomo_generator` и `devtools` работают как top-level screen modules с lifecycle;
- состояние `mihomo_generator` сохраняется между переходами;
- `devtools` больше не поднимает тяжёлые секции прежним eager-способом;
- добавлены guardrails, inventory updates и проверки под новый runtime contract.

## Что было закрыто

Все этапы исходного плана считаются выполненными:

- `P0` — runtime contract cleanup и быстрые подготовительные улучшения;
- `P1` — общий top-level shell/router;
- `P2` — `mihomo_generator` как первый keep-alive screen;
- `P3` — `devtools` как второй keep-alive screen;
- `P4` — shared top-level host partials вместо дублирования общего host-каркаса;
- `P5` — guardrails, tests, cleanup и фиксация нового контракта.

## Практический итог

Задача "убрать подгрузки" для трёх основных top-level маршрутов закрыта.

Под "закрыта" здесь понимается именно следующее:

- внутри уже открытого UI переходы между этими экранами больше не должны менять HTML-документ;
- normal path теперь идёт через in-app router, а hard navigation остаётся fallback-only;
- текущее решение уже закреплено кодом, тестами и документацией.

## Что может понадобиться позже

Если мы захотим распространить тот же UX-подход на остальные canonical page entrypoints, следующими кандидатами будут:

- `/backups`
- `/xkeen`

С высокой вероятностью для них понадобится тот же тип работы:

- перевод в top-level screen modules;
- подключение к общему router/shell;
- проверка lifecycle и side effects;
- отдельные guardrails и обновление page inventory/docs.

## Как использовать этот файл дальше

Считать его короткой закрывающей заметкой по уже завершённой инициативе, а не рабочим планом.
