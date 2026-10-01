# Подэтап 4.6. Совместимость, тесты и удаление монолита

Статус: **закрыт 1 октября 2026 года**.

Подэтап 4.6 завершает серверную часть Этапа 4. Все screen, shell-slot и modal
surfaces уже выбираются allow-listed manifest из `routes/pages.py`; этот этап
собрал проверку совместимости в один воспроизводимый контракт и зафиксировал,
что в entrypoint не осталось старой монолитной разметки.

## Контракт совместимости

`scripts/generate_modular_panel_stage4_6_compatibility.py` создаёт
`modular-panel-stage4.6-compatibility.json`. Снимок связывает:

- исторический Stage 4.1 profile baseline;
- текущие `PANEL_COMPOSITION` и `PANEL_NAVIGATION`;
- обязательные root `id`, navigation `data-view`/`data-xk-section`/URL и
  выбранные modal `data-*` атрибуты;
- составные ownership requirements для modal partials.

Проверка всегда рендерит реальный Flask route, а не Jinja-фрагменты отдельно.
Для Full и Legacy сравниваются в том числе все `id` в документном порядке,
`data-*` каждого id-bearing элемента, navigation и modal root ids. Это
сохраняет user-visible и frontend-consumed DOM-контракт при legacy fallback.

## Профили

| Набор | Проверка |
| --- | --- |
| Legacy / Full | Полный public DOM contract совпадает между обоими путями. |
| Xray-minimal | Нет Mihomo, terminal, files и diagnostics screen/modal/shell HTML. |
| Mihomo-minimal | Нет Xray, terminal, files и diagnostics screen/modal/shell HTML. |
| core-only | Остаются Xkeen screen, core navigation и shared modals. |
| empty active set | Shell рендерится без optional templates, screens, modals и navigation. |

Фактическое расхождение было найдено в старом machine-readable Stage 4.1
contract: `fm-editor-modal` попадало в Xray/Mihomo-minimal только по своему
целевому модулю `tool.editor`. Теперь `owner_requirements` читается из
runtime manifest; окно требует одновременно `tool.files` и `tool.editor`,
поэтому корректно отсутствует в обоих minimal-профилях.

## Удаление монолита

Проверка entrypoint подтверждает, что `xkeen-ui/templates/panel.html` содержит
только literal includes shell/head, циклы selected partials, toast, footer и
entrypoint scripts. В нём нет `view-*` roots и `.modal` markup, поэтому к
моменту 4.6 дубликаты старого монолита уже были удалены предыдущими
подэтапами. Новой разметки удалять не потребовалось.

## Проверка

```bash
python scripts/generate_modular_panel_stage4_1_contract.py --root .
python scripts/generate_modular_panel_stage4_6_compatibility.py --root .
python -m pytest -q tests/test_modular_panel_stage4_1_contract.py tests/test_modular_panel_stage4_2_shell.py tests/test_modular_panel_stage4_3_routing_screen.py tests/test_modular_panel_stage4_3_xray_logs_screen.py tests/test_modular_panel_stage4_3_mihomo_screen.py tests/test_modular_panel_stage4_3_xkeen_screen.py tests/test_modular_panel_stage4_3_tool_screens.py tests/test_modular_panel_stage4_4_modals.py tests/test_modular_panel_stage4_5_composition.py tests/test_modular_panel_stage4_6_compatibility.py
python -m pytest -q
```

## Вне границ

Этап 4 не меняет frontend bundles, static imports, dynamic `import()`, lazy
CSS или API/WS calls выключенных модулей. Эти задачи остаются Этапом 5.

## Критерий завершения

Критерий завершения **выполнен**: initial HTML каждого профиля соответствует
своему набору модулей, Full и Legacy сохраняют один public DOM contract, а
`panel.html` больше не владеет screen-specific и modal markup.
