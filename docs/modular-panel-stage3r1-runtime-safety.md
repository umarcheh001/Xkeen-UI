# Этап 3R.1. Доработка runtime safety по сверке с кодом

Статус: **закрыт 30 сентября 2026 года**.

Этап 3R.1 закрывает расхождения между предыдущим runtime safety-контрактом и фактическим кодом. Он дополняет backend gates эксплуатационными гарантиями для
работающей сети, recovery state и core-owned maintenance.

## Реализовано в 3R.1

- DNS guard запускается при активном Xray или Mihomo, а service stop lifecycle
  больше не превращается в заглушку в Mihomo-only профиле;
- API не позволяет отключить активное ядро и возвращает `409 active_core_module`;
- если отключение затрагивает активную DNS-защиту, возвращается
  `409 dns_protection_active`;
- self-update, update status, rollback и module-control API доступны без
  `tool.advanced-diagnostics`;
- advanced env/theme/branding/UI endpoints получают `404 module_not_enabled`
  при отключённой расширенной диагностике;
- runtime activation фиксируется процессом, `is_runtime_active()` больше не
  перечитывает изменённый state с диска;
- повреждённый или неизвестный future-schema `modules.json` сохраняется как
  `modules.json.bad.<timestamp>`, после чего включается legacy-full recovery;
- `XKEEN_UI_MODULE_SAFE_MODE=legacy-full` принудительно активирует поставляемый
  legacy набор;
- `integration.happ` имеет зависимость от `core`, поэтому общие subscription
  helpers доступны Xray и Mihomo;
- опубликован owner map для зарегистрированных Blueprint и diagnostics для
  неизвестных владельцев;
- размеры модулей вынесены в generated `xkeen-ui/module-sizes.json`, который
  обновляется `scripts/sync_module_sizes.py`.

## Контракты

Машинные проверки находятся в:

- `tests/test_module_registry.py`;
- `tests/test_module_backend_gates.py`;
- `tests/test_modular_panel_stage0_inventory.py`.

Перед изменением runtime module state проверяются активное ядро и DNS owner.
Операция, которая может оставить сеть без владельца или без DNS release,
отклоняется до перезапуска.

## Recovery

Для аварийного запуска старого полного состава:

```sh
XKEEN_UI_MODULE_SAFE_MODE=legacy-full
```

Также можно удалить `UI_STATE_DIR/modules.json` по SSH: следующая инициализация
создаст безопасный `legacy-full` state. Повреждённый исходный файл сначала
сохраняется в `.bad.<timestamp>`.

## Критерий завершения

Критерий готовности **выполнен**: DNS lifecycle, опасное отключение, recovery,
core-owned maintenance, Happ ownership, owner diagnostics и generated module
size metadata покрыты кодом и тестами.

## Сверка с кодом

- guard использует фактически запущенный core и повторяется при startup;
- optional initialization failure сохраняется в registry как `failed`;
- future schema не перезаписывает исходный `modules.json`;
- installed markers ограничивают legacy-full/safe-mode активным составом файлов;
- owner maps находятся в registry boundary и публикуются в diagnostics;
- baseline initial HTML сохранён до Stage 4.3.


