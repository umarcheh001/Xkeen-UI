# Release note: встроенный Mihomo operator runtime

Дата: 10 августа 2026 года.

- Добавлен same-origin operator runtime Mihomo: status, группы/latency, connections, rules, providers и on-demand logs.
- Новые bundled templates и generator используют Unix socket `./mihomo-api.sock`; controller не публикуется в LAN по умолчанию.
- Старые конфиги не переписываются при установке. При первом открытии **Mihomo → Управление** отсутствие controller определяется автоматически и показывается помощник **«Настроить автоматически»**; вручную редактировать YAML не требуется.
- Помощник также исправляет LAN controller без `secret`. До подтверждения доступен preview; apply выполняет `mihomo -t`, создаёт backup и сохраняет config. Для первичной настройки нужный restart заранее включён, но остаётся видимым и управляемым пользователем.
- Mihomo JSON Schema содержит `external-controller-unix` с подсказкой, примером `./mihomo-api.sock`, назначением и предупреждением безопасности для YAML hover.
- Доступен совместимый loopback TCP режим с новым случайным secret. Пароль панели не копируется.
- Zashboard сохранён как optional external tool, но больше не является частью основного runtime workflow.
- Runtime logs перенесены из перекрывающего рабочую область drawer в полноценную вкладку **«Логи»** рядом с управлением, соединениями и правилами; WebSocket по-прежнему живёт только пока эта вкладка активна.
- �� **«Соединениях»** и рядом с IP-адресами в **«Логах»** показываются имена устройств из списка Keenetic. Используется тот же источник ручных и роутерных имён, что и в логах Xray, с общим коротким кэшем без запроса к роутеру на каждую строку.

Rollout не требует feature flag: API маршруты защищены существующими session/CSRF guards, UI lazy-loaded, а миграция всегда opt-in. Rollback — восстановить созданный Mihomo backup и перезапустить ядро.
