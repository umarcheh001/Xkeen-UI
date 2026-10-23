# Smart-группы Mihomo

Панель распознаёт группы `type: smart`, которые поддерживает Mihomo-форк с
Smart API. Сам выбор узла выполняет ядро: панель только показывает текущую
группу, веса и ранг узлов, если форк предоставляет `GET /group/weights`.

Поддерживаемые параметры конфигурации:

```yaml
proxy-groups:
  - name: Smart
    type: smart
    proxies: [node-a, node-b]
    prefer-asn: true
    tolerance: 50
    uselightgbm: true
    collectdata: false
    sample-rate: 1
    policy-priority: "Premium:0.9;SG:1.3"
```

Глобальные ML-параметры задаются на верхнем уровне YAML-файла форка:
`lgbm-auto-update`, `lgbm-update-interval`, `lgbm-url` и
`smart-collector-size`. Панель их не переписывает и оставляет под контролем
конфигурации ядра.

Кнопка «Сбросить Smart» появляется только при наличии fork-specific
`POST /cache/smart/flush`. Для обычного Mihomo Smart-веса и ML-контролы
недоступны, но стандартные группы продолжают работать.

В разделе соединений кнопка `Smart: заблокировать узел для хоста` появляется
только когда ядро помечает соединение как доступное для Smart-блокировки.
Панель передаёт команду в `DELETE /connections/smart/{id}` и не пытается
самостоятельно изменять маршрутизацию или YAML.
