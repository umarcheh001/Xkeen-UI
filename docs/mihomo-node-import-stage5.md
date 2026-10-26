# Mihomo node import — Этап 5: назначение, группы и автообновление

**Статус:** закрыт 26 октября 2026 года.

Этап добавляет явное назначение результата и подключение к proxy-groups. Он не
сохраняет файл и не запускает Mihomo: это остаётся scope Этапа 6.

## Реализовано

- Для подписок появился явный выбор назначения:
  - **Provider** — запись в `proxy-providers`, имя provider и интервал в часах;
  - **Статические узлы** — запись в `proxies`, если источник отдаёт проверенный
    static flow.
- Для provider выбранные группы подключаются через `use`, а не через `proxies`.
  Существующие `use`, filters и комментарии сохраняются.
- Для статических узлов используется существующий patch pipeline `proxies`.
  Неизвестные группы не создаются молча: backend возвращает `missing_groups`, а
  модал показывает их в итоговом уведомлении.
- Группы показывают счётчик выбора и честно объясняют пустой выбор: узлы/provider
  могут сохраниться в конфиге, но не использоваться в маршрутизации.
- Provider interval задаётся в часах и переводится в Mihomo seconds при
  подготовке candidate-фрагмента. Для Xray/HWID static subscriptions сохранён
  отдельный интервал автообновления 1–168 часов.
- Автообновление регистрируется только после вставки выбранного результата;
  parse и смена назначения не регистрируют подписку. Фактический `next_update`
  продолжает отображаться только из ответа backend для уже зарегистрированных
  записей.
- Amnezia Premium и одиночные VPN-конфигурации не получают неподдерживаемый
  provider selector: они остаются статическими узлами.

## Backend boundary

Добавлен `POST /api/mihomo/patch/attach_providers`, который добавляет provider
names в `proxy-groups[].use` и возвращает `attached_groups`/`missing_groups`.
Существующий `POST /api/mihomo/patch/apply_insert` теперь также сообщает
неизвестные группы, не ломая старый `content` response. Текстовые helpers
остаются framework-free и сохраняют inline/block YAML формы.

## Проверки

- Route tests: provider `use`, inline lists, unknown groups и static `proxies`.
- Playwright: provider/static switch без повторного parse результата, provider
  name/interval, group counter, Amnezia/special source guards, lifecycle/layout.
- Unit/contracts, frontend build, static verification и inventories выполнены.

## Граница этапа

Этап не создаёт save/apply candidate, backup или restart job. Нажатие «Вставить
в конфиг» по-прежнему обновляет только главный editor; полноценные save-only и
save-and-apply остаются Этапом 6.

**Следующий шаг:** Этап 6 — полный candidate, summary и действия
сохранения/применения.
