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
`lgbm-auto-update`, `lgbm-update-interval` и `lgbm-url`. Размер хранилища
собранных данных — внутри `profile`:

```yaml
profile:
  smart-collector-size: 100   # МБ
```

На верхнем уровне `smart-collector-size` форк не читает. Панель эти параметры
не переписывает и оставляет под контролем конфигурации ядра.

Кнопка «Сбросить Smart» (`POST /cache/smart/flush`) появляется, когда ядро
отдало веса через `GET /group/weights`. Если веса недоступны (обычный Mihomo
или форк без Smart-хранилища), Smart-контролы скрыты, а стандартные группы
продолжают работать.

В разделе соединений кнопка `Smart: заблокировать узел для хоста` появляется
только у соединений, которые ядро пометило `smartBlock: normal`. Панель
передаёт команду в `DELETE /connections/smart/{id}`: форк запоминает узел как
заблокированный для этого хоста и закрывает соединение. Маршрутизацию и YAML
панель сама не меняет.
