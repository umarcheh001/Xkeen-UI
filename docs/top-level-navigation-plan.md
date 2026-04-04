# Итог: top-level navigation между `/`, `/backups`, `/devtools`, `/xkeen` и `/mihomo_generator`

## Статус

Документ больше не является активным implementation plan.

На 04.04.2026 five-route инициатива закрыта полностью:

- top-level переходы между всеми five canonical entrypoints переведены с full document navigation на in-app navigation;
- direct URL entry и hard reload сохранены для `/`, `/backups`, `/devtools`, `/xkeen` и `/mihomo_generator`;
- общий top-level shell/router, screen registry и shared host contract работают для всех пяти экранов;
- `backups` и `xkeen` доведены до того же keep-alive screen lifecycle, что уже был у `panel`, `devtools` и `mihomo_generator`;
- guardrails, inventory updates, verification и архитектурная документация синхронизированы под final five-route contract.

## Что было закрыто

Все этапы инициативы считаются выполненными:

- `P0` — runtime contract cleanup и быстрые подготовительные улучшения.
- `P1` — общий top-level shell/router.
- `P2` — `mihomo_generator` как первый keep-alive screen.
- `P3` — `devtools` как второй keep-alive screen.
- `P4` — shared top-level host partials вместо дублирования общего host-каркаса.
- `P5` — guardrails, tests, cleanup и фиксация нового контракта для `/`, `/devtools` и `/mihomo_generator`.
- `P6` — route/screen registry расширен до пяти canonical entrypoints.
- `P7` — `backups.html` и `xkeen.html` выровнены под shared top-level host contract.
- `P8` — `/backups` и `/xkeen` переведены на top-level screen bootstrap и общий screen host.
- `P9` — добран page-specific lifecycle/state retention для `backups` и `xkeen`.
- `P10` — guardrails, verification, docs/inventory sync и финальная фиксация five-route runtime contract.

## Финальный runtime contract

Под "задача закрыта" теперь понимается следующее:

- normal-path переходы между зарегистрированными top-level маршрутами не меняют HTML-документ;
- top-level router работает через фиксированный five-route registry и `pushState`/`popstate`;
- hard navigation остаётся только fallback-only path для direct URL entry, missing screen и transition failure.
- direct entrypoint каждого маршрута остаётся canonical source entry и продолжает работать без already-bootstrapped shell;
- `backups` и `xkeen` сохраняют локальное runtime-состояние достаточно, чтобы возврат на экран не вёл к лишней переинициализации, duplicate polling или сбросу базового view/editor state.

## Что закрепил `P10`

Финальный этап закрыл остатки вокруг нового охвата:

- guardrail-тесты теперь фиксируют route registry, shared top-level template contract и screen/bootstrap wiring уже для всех пяти canonical entrypoints;
- inventory-документация и `docs/frontend-page-inventory.json` синхронизированы с текущим source graph, где `/backups` и `/xkeen` уже входят в тот же top-level shell/runtime path;
- архитектурные документы больше не описывают общий top-level router/shell как контракт только для трёх экранов;
- hard navigation отдельно зафиксирован как fallback-path, а не normal path перехода между этими top-level screens.

## Как использовать этот файл дальше

Документ нужно читать только как закрывающую заметку по полностью завершённому five-route rollout.

Он полезен как краткая фиксация того, что именно уже считается обязательным контрактом:

- есть один top-level shell/runtime path для всех five canonical entrypoints;
- keep-alive screen lifecycle и screen registry распространяются на `/backups` и `/xkeen` так же, как на остальные top-level экраны;
- изменения в router, page templates, inventory и runtime guardrails не должны откатывать normal-path переходы обратно к full document reload.
