# Документация по frontend

Актуальная документация по frontend migration и текущему ESM-first контракту собрана в living docs. Исторические пошаговые rollout-планы в `docs/` больше не поддерживаются.

## Основные документы

- `README_frontend_migration_plan.md` — текущий статус закрытого migration scope и список guardrails, которые нельзя откатывать.
- `frontend-target-architecture.md` — целевой архитектурный контракт фронтенда в текущем репозитории.
- `frontend-feature-api.md` — правила для feature API, registry и compat-слоя.
- `frontend-page-inventory.md` — человекочитаемая карта страниц и freeze-правила для source graph.
- `frontend-build-workflow.md` — актуальный install/build/verify workflow и связь с CI/archive workflows.
- `adr/0001-frontend-esm-bootstrap.md` — архитектурное решение про build-managed ESM bootstrap.

## Сгенерированные артефакты

- `frontend-page-inventory.json` — snapshot page inventory, который должен оставаться синхронным с `scripts/generate_frontend_inventory.py`.

## Когда обновлять документацию

- при добавлении или удалении page entrypoint;
- при изменении feature registry или публичного runtime/page-config contract;
- при изменении frontend build workflow, manifest bridge или CI/archive-пайплайнов;
- при изменении guardrails, которые считаются архитектурным freeze для stages 0-9.

## Чего здесь больше нет

- отдельных implementation plan-документов по уже закрытым этапам;
- статусных секций вида «что осталось доделать до Stage X», если этап уже закрыт кодом и тестами;
- ссылок на устаревшие workflow-имена или переходные rollout-нотации, которые больше не отражают текущее состояние репозитория.
