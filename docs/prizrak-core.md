# Prizrak-Core в Mihomo-конфигурациях

YAML-редактор Xkeen UI подсказывает поля Prizrak-Core: `ping-config`, `fallback-urls`,
`freedom`, `finalmask`, `mux.cool`, XHTTP HTTP/2 flow control и Reality ML-DSA-65.
Эти расширения требуют Prizrak-Core; обычный Mihomo может их не принять.

## QUIC только через выбранные узлы

Начиная с Prizrak-Core v1.19.33-r10, `udp-443: reject` можно указать у отдельного
прокси или в `proxy-providers.<name>.override`. Это отклоняет UDP/443 через эти
узлы, сохраняя QUIC на DIRECT и других маршрутах:

```yaml
proxy-providers:
  main:
    type: http
    url: https://example.com/sub
    interval: 21600
    override:
      udp-443: reject
```

Для одного узла добавьте `udp-443: reject` прямо в его YAML-блок. Алиас
`quic: reject` тоже поддерживается, но `udp-443` не пересекается с boolean-полем
`quic` у TrustTunnel. Если оба алиаса указаны, их значения должны совпадать.
Существующие глобальные правила блокировки QUIC панель автоматически не удаляет:
при переходе на точечную политику проверьте свой список `rules`.

## Remnawave Host Mapper

В Remnawave откройте настройки конкретного Host, раздел Advanced, Mapper.
Операции в `mihomo` меняют именно Mihomo-ответ подписки. Например, для узла,
который должен блокировать UDP/443 и использовать Mux.Cool:

```json
{
  "xrayJson": [],
  "mihomo": [
    { "op": "set", "value": "reject", "to": "['udp-443']" },
    {
      "op": "set",
      "value": { "enabled": true, "max-concurrency": 8 },
      "to": "['mux.cool']"
    }
  ],
  "base64": []
}
```

`mux.cool` здесь буквальное имя поля с точкой. Включайте Mux.Cool только если
его поддерживает сервер, и не сочетайте со `smux`. Аналогично можно передать
`['reality-opts']['mldsa65-verify']`, `['finalmask']` и
`['xhttp-opts']['h2-flow']`. Готовый Mihomo YAML из Remnawave панель сохраняет
с этими полями; для Xray JSON и URI поддерживаемые параметры переносит парсер.

См. [документацию Prizrak-Core](https://docs.prizrak.app/ru/for-devs/remnawave-integration/)
и [изменение UDP/443 в r10](https://github.com/legiz-ru/Prizrak-Core/releases/tag/v1.19.33-r10).
