# Подэтап 4.3. Xray logs screen

Статус: **закрыт 30 сентября 2026 года**.

Второй экран Этапа 4.3 вынесен из composition root в module-owned partial:

```text
xkeen-ui/templates/panel/screens/xray_logs.html
```

## Владение

- module owner: `engine.xray`;
- server gate: `{% if has_xray %}` в `panel.html` вокруг include;
- screen root: `#view-xray-logs`;
- navigation contract: `data-xk-section="xray-logs"`;
- frontend root: `logs_shell.shared.js` лениво импортирует
  `features/xray_logs.js` только при открытии вкладки.

## Изменение поведения

До выделения `#view-xray-logs` не был закрыт gate и попадал в initial HTML
Mihomo-only профиля, хотя навигация на него не вела. Теперь разметка экрана
рендерится только при активном `engine.xray`, как требует профиль
`mihomo-minimal` контракта 4.1.

Frontend проверен на отсутствие root:

- `logs_shell.shared.js` возвращает `false` из `isLogsSectionVisible()` без
  `#view-xray-logs` и не активирует feature;
- `panel_shell.shared.js` и `routing_cards.js` пропускают отсутствующие
  sections и нормализуют сохранённый в `localStorage` view на доступный;
- badge и polling `/api/xray-logs/status` в header закрыты `hasXrayCore()`;
- делегированные обработчики `panel.lazy_bindings.runtime.js` используют
  `closest('#view-xray-logs …')` и без root не срабатывают.

## Сохранённый контракт

- DOM id и порядок разметки экрана не изменены, экран остаётся после
  `#view-files`;
- live log card и restart log card остались внутри одного partial;
- модальное окно `#xray-context-modal` осталось в `panel.html` — его перенос
  относится к подэтапу 4.4;
- `panel.html` подключает экран через один Jinja include.

## Проверка

- `tests/test_modular_panel_stage4_3_xray_logs_screen.py` — владение partial,
  DOM-контракт после composition, рендер partial с `op_icon` и полный
  server-side рендер страницы для Xray-only и Mihomo-only;
- Stage 4.1 contract и Stage 0 inventory пересобраны после extraction.

Browser smoke Mihomo-only профиля с проверкой console errors не выполнялся:
локальный профиль без бинарника `mihomo` не активирует `engine.mihomo`.
Проверка входит в E2E-guardrails Этапа 5.

## Критерий завершения

Критерий завершения **выполнен**: markup логов Xray имеет единственного
владельца `engine.xray`, отсутствует в физическом composition root и в
initial HTML профиля без `engine.xray`, а DOM/bootstrap contract сохранён.
