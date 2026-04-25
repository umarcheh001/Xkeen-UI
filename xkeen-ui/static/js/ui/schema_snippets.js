/**
 * schema_snippets.js — task-oriented block templates для Xray JSON и Mihomo YAML.
 *
 * Используется из CM6 (через jsonCompletion/completeYamlTextFromSchema с опцией snippetProvider)
 * и из Monaco (через registerCompletionItemProvider в monaco_shared.js).
 *
 * Источник сниппетов — плоские массивы, фильтруемые по контексту вставки (schemaKind/pointer/path).
 * Каждый сниппет содержит insertText (для CM6) и monacoSnippet (с ${1:placeholder} tabstops).
 *
 * Keenetic-специфика: сниппеты DNS block и TUN block (Mihomo), DNS (Xray) содержат поле
 * warning с напоминанием, что эти блоки обычно требуют особой настройки роутера
 * и/или инструкции https://jameszero.net/3398.htm (для Xray DNS).
 */

const KEENETIC_XRAY_DNS_NOTE =
  'На Keenetic Xray DNS обычно настраивают по инструкции https://jameszero.net/3398.htm: вместе с dns-out outbound, routing rules для портa 53 и domainStrategy на proxy/direct.';

const KEENETIC_MIHOMO_DNS_NOTE =
  'На Keenetic DNS-блок Mihomo редко используется напрямую: обычно требует перенастройки системного резолвера и firewall, иначе ломается разрешение имён для самого роутера.';

const KEENETIC_MIHOMO_TUN_NOTE =
  'На Keenetic TUN-блок Mihomo редко используется: требует включения TUN-режима в прошивке и корректных ip-rules/route таблиц, иначе роутер не маршрутизирует трафик.';

/* ════════════════════════════════════════════════════════════
 *  Xray · routing rules (вставка в массив rules)
 * ════════════════════════════════════════════════════════════ */

const XRAY_ROUTING_RULES_SNIPPETS = [
  {
    id: 'xray-rule-block-domain',
    label: 'rule: block by domain',
    detail: 'Xray · routing.rules[]',
    documentation: 'Правило блокировки трафика к указанным доменам. Поддерживает exact-домены и ссылки geosite:*.',
    insertText: '{\n  "type": "field",\n  "domain": [\n    "geosite:category-ads-all"\n  ],\n  "outboundTag": "block"\n}',
    monacoSnippet: '{\n  "type": "field",\n  "domain": [\n    "${1:geosite:category-ads-all}"\n  ],\n  "outboundTag": "${2:block}"\n}$0',
  },
  {
    id: 'xray-rule-block-ip',
    label: 'rule: block by IP / CIDR',
    detail: 'Xray · routing.rules[]',
    documentation: 'Блокировка трафика на IP, CIDR или geoip:*.',
    insertText: '{\n  "type": "field",\n  "ip": [\n    "geoip:private"\n  ],\n  "outboundTag": "block"\n}',
    monacoSnippet: '{\n  "type": "field",\n  "ip": [\n    "${1:geoip:private}"\n  ],\n  "outboundTag": "${2:block}"\n}$0',
  },
  {
    id: 'xray-rule-block-quic',
    label: 'rule: block QUIC',
    detail: 'Xray В· routing.rules[]',
    documentation: 'Блокировка QUIC в Xray через правило для UDP/443. Обычно такое правило ставят выше общих proxy/direct rules.',
    insertText: '{\n  "type": "field",\n  "network": "udp",\n  "port": "443",\n  "outboundTag": "block"\n}',
    monacoSnippet: '{\n  "type": "field",\n  "network": "udp",\n  "port": "${1:443}",\n  "outboundTag": "${2:block}"\n}$0',
  },
  {
    id: 'xray-rule-proxy-domain',
    label: 'rule: proxy by domain',
    detail: 'Xray · routing.rules[]',
    documentation: 'Направить трафик по списку доменов через proxy/balancer outbound.',
    insertText: '{\n  "type": "field",\n  "domain": [\n    "geosite:geolocation-!cn"\n  ],\n  "outboundTag": "proxy"\n}',
    monacoSnippet: '{\n  "type": "field",\n  "domain": [\n    "${1:geosite:geolocation-!cn}"\n  ],\n  "outboundTag": "${2:proxy}"\n}$0',
  },
  {
    id: 'xray-rule-direct-domain',
    label: 'rule: direct by domain',
    detail: 'Xray · routing.rules[]',
    documentation: 'Пропустить трафик напрямую (freedom) по списку доменов.',
    insertText: '{\n  "type": "field",\n  "domain": [\n    "geosite:private",\n    "geosite:ru"\n  ],\n  "outboundTag": "direct"\n}',
    monacoSnippet: '{\n  "type": "field",\n  "domain": [\n    "${1:geosite:private}",\n    "${2:geosite:ru}"\n  ],\n  "outboundTag": "${3:direct}"\n}$0',
  },
  {
    id: 'xray-rule-proxy-by-port',
    label: 'rule: proxy by port',
    detail: 'Xray · routing.rules[]',
    documentation: 'Проксировать трафик по port/port-range (например TCP 443, UDP 443 — QUIC).',
    insertText: '{\n  "type": "field",\n  "network": "tcp,udp",\n  "port": "443",\n  "outboundTag": "proxy"\n}',
    monacoSnippet: '{\n  "type": "field",\n  "network": "${1|tcp,udp,tcp,udp|}",\n  "port": "${2:443}",\n  "outboundTag": "${3:proxy}"\n}$0',
  },
  {
    id: 'xray-rule-proxy-by-process',
    label: 'rule: proxy by process name',
    detail: 'Xray · routing.rules[]',
    documentation: 'Проксировать трафик конкретного процесса (по имени исполняемого файла).',
    insertText: '{\n  "type": "field",\n  "process": [\n    "chrome.exe"\n  ],\n  "outboundTag": "proxy"\n}',
    monacoSnippet: '{\n  "type": "field",\n  "process": [\n    "${1:chrome.exe}"\n  ],\n  "outboundTag": "${2:proxy}"\n}$0',
  },
  {
    id: 'xray-rule-via-balancer',
    label: 'rule: route via balancer',
    detail: 'Xray · routing.rules[]',
    documentation: 'Направить трафик в balancer вместо конкретного outbound.',
    insertText: '{\n  "type": "field",\n  "domain": [\n    "geosite:geolocation-!cn"\n  ],\n  "balancerTag": "balancer-auto"\n}',
    monacoSnippet: '{\n  "type": "field",\n  "domain": [\n    "${1:geosite:geolocation-!cn}"\n  ],\n  "balancerTag": "${2:balancer-auto}"\n}$0',
  },
];

/* ════════════════════════════════════════════════════════════
 *  Xray · routing balancers (вставка в массив balancers)
 * ════════════════════════════════════════════════════════════ */

const XRAY_ROUTING_BALANCERS_SNIPPETS = [
  {
    id: 'xray-balancer-auto',
    label: 'balancer: auto (observatory)',
    detail: 'Xray · routing.balancers[]',
    documentation: 'Автоматический balancer с observatory-стратегией. На Keenetic осторожно с количеством селекторов — 300+ узлов кладут роутер.',
    insertText: '{\n  "tag": "balancer-auto",\n  "selector": [\n    "proxy-"\n  ],\n  "strategy": {\n    "type": "leastPing"\n  }\n}',
    monacoSnippet: '{\n  "tag": "${1:balancer-auto}",\n  "selector": [\n    "${2:proxy-}"\n  ],\n  "strategy": {\n    "type": "${3|leastPing,random,roundRobin,leastLoad|}"\n  }\n}$0',
  },
  {
    id: 'xray-balancer-leastload',
    label: 'balancer: leastLoad',
    detail: 'Xray · routing.balancers[]',
    documentation: 'Balancer с leastLoad — использует observatory-метрики для выбора наименее загруженного исходящего.',
    insertText: '{\n  "tag": "balancer-leastload",\n  "selector": [\n    "proxy-"\n  ],\n  "strategy": {\n    "type": "leastLoad",\n    "settings": {\n      "baselines": [\n        "300ms",\n        "500ms"\n      ],\n      "expected": 2\n    }\n  }\n}',
    monacoSnippet: '{\n  "tag": "${1:balancer-leastload}",\n  "selector": [\n    "${2:proxy-}"\n  ],\n  "strategy": {\n    "type": "leastLoad",\n    "settings": {\n      "baselines": [\n        "${3:300ms}",\n        "${4:500ms}"\n      ],\n      "expected": ${5:2}\n    }\n  }\n}$0',
  },
];

/* ════════════════════════════════════════════════════════════
 *  Xray · outbounds (вставка в массив outbounds)
 * ════════════════════════════════════════════════════════════ */

const XRAY_OUTBOUNDS_SNIPPETS = [
  {
    id: 'xray-outbound-direct',
    label: 'outbound: direct (freedom)',
    detail: 'Xray · outbounds[]',
    documentation: 'Прямой исходящий — freedom protocol. Обычный tag: "direct".',
    insertText: '{\n  "tag": "direct",\n  "protocol": "freedom",\n  "settings": {\n    "domainStrategy": "UseIPv4"\n  }\n}',
    monacoSnippet: '{\n  "tag": "${1:direct}",\n  "protocol": "freedom",\n  "settings": {\n    "domainStrategy": "${2|UseIPv4,UseIP,UseIPv6,AsIs|}"\n  }\n}$0',
  },
  {
    id: 'xray-outbound-block',
    label: 'outbound: block (blackhole)',
    detail: 'Xray · outbounds[]',
    documentation: 'Блокирующий исходящий — blackhole protocol. Используется с outboundTag: "block" в rules.',
    insertText: '{\n  "tag": "block",\n  "protocol": "blackhole",\n  "settings": {\n    "response": {\n      "type": "http"\n    }\n  }\n}',
    monacoSnippet: '{\n  "tag": "${1:block}",\n  "protocol": "blackhole",\n  "settings": {\n    "response": {\n      "type": "${2|http,none|}"\n    }\n  }\n}$0',
  },
  {
    id: 'xray-outbound-vless-reality',
    label: 'outbound: VLESS Reality',
    detail: 'Xray · outbounds[]',
    documentation: 'VLESS-исходящий с Reality-транспортом. Подставь реальные address, id, serverName, publicKey, shortId.',
    insertText: '{\n  "tag": "proxy-reality",\n  "protocol": "vless",\n  "settings": {\n    "vnext": [\n      {\n        "address": "example.com",\n        "port": 443,\n        "users": [\n          {\n            "id": "00000000-0000-0000-0000-000000000000",\n            "encryption": "none",\n            "flow": "xtls-rprx-vision"\n          }\n        ]\n      }\n    ]\n  },\n  "streamSettings": {\n    "network": "tcp",\n    "security": "reality",\n    "realitySettings": {\n      "serverName": "example.com",\n      "fingerprint": "chrome",\n      "publicKey": "",\n      "shortId": ""\n    }\n  }\n}',
    monacoSnippet: '{\n  "tag": "${1:proxy-reality}",\n  "protocol": "vless",\n  "settings": {\n    "vnext": [\n      {\n        "address": "${2:example.com}",\n        "port": ${3:443},\n        "users": [\n          {\n            "id": "${4:00000000-0000-0000-0000-000000000000}",\n            "encryption": "none",\n            "flow": "${5|xtls-rprx-vision,|}"\n          }\n        ]\n      }\n    ]\n  },\n  "streamSettings": {\n    "network": "tcp",\n    "security": "reality",\n    "realitySettings": {\n      "serverName": "${6:example.com}",\n      "fingerprint": "${7|chrome,firefox,safari,edge,ios,android,random|}",\n      "publicKey": "${8}",\n      "shortId": "${9}"\n    }\n  }\n}$0',
  },
  {
    id: 'xray-outbound-vless-xhttp',
    label: 'outbound: VLESS XHTTP',
    detail: 'Xray · outbounds[]',
    documentation: 'VLESS-исходящий через XHTTP-транспорт (современный замен ws/grpc в ряде сценариев).',
    insertText: '{\n  "tag": "proxy-xhttp",\n  "protocol": "vless",\n  "settings": {\n    "vnext": [\n      {\n        "address": "example.com",\n        "port": 443,\n        "users": [\n          {\n            "id": "00000000-0000-0000-0000-000000000000",\n            "encryption": "none"\n          }\n        ]\n      }\n    ]\n  },\n  "streamSettings": {\n    "network": "xhttp",\n    "security": "tls",\n    "tlsSettings": {\n      "serverName": "example.com",\n      "alpn": ["h2"]\n    },\n    "xhttpSettings": {\n      "host": "example.com",\n      "path": "/",\n      "mode": "stream-one"\n    }\n  }\n}',
    monacoSnippet: '{\n  "tag": "${1:proxy-xhttp}",\n  "protocol": "vless",\n  "settings": {\n    "vnext": [\n      {\n        "address": "${2:example.com}",\n        "port": ${3:443},\n        "users": [\n          {\n            "id": "${4:00000000-0000-0000-0000-000000000000}",\n            "encryption": "none"\n          }\n        ]\n      }\n    ]\n  },\n  "streamSettings": {\n    "network": "xhttp",\n    "security": "tls",\n    "tlsSettings": {\n      "serverName": "${5:example.com}",\n      "alpn": ["h2"]\n    },\n    "xhttpSettings": {\n      "host": "${6:example.com}",\n      "path": "${7:/}",\n      "mode": "${8|stream-one,packet-up,stream-up|}"\n    }\n  }\n}$0',
  },
  {
    id: 'xray-outbound-trojan',
    label: 'outbound: Trojan',
    detail: 'Xray · outbounds[]',
    documentation: 'Trojan-исходящий через TLS. Простая замена Shadowsocks c TLS-маскировкой.',
    insertText: '{\n  "tag": "proxy-trojan",\n  "protocol": "trojan",\n  "settings": {\n    "servers": [\n      {\n        "address": "example.com",\n        "port": 443,\n        "password": "your-password"\n      }\n    ]\n  },\n  "streamSettings": {\n    "network": "tcp",\n    "security": "tls",\n    "tlsSettings": {\n      "serverName": "example.com"\n    }\n  }\n}',
    monacoSnippet: '{\n  "tag": "${1:proxy-trojan}",\n  "protocol": "trojan",\n  "settings": {\n    "servers": [\n      {\n        "address": "${2:example.com}",\n        "port": ${3:443},\n        "password": "${4:your-password}"\n      }\n    ]\n  },\n  "streamSettings": {\n    "network": "tcp",\n    "security": "tls",\n    "tlsSettings": {\n      "serverName": "${5:example.com}"\n    }\n  }\n}$0',
  },
  {
    id: 'xray-outbound-shadowsocks',
    label: 'outbound: Shadowsocks',
    detail: 'Xray · outbounds[]',
    documentation: 'Shadowsocks-исходящий. Для современных серверов используй 2022-шифры.',
    insertText: '{\n  "tag": "proxy-ss",\n  "protocol": "shadowsocks",\n  "settings": {\n    "servers": [\n      {\n        "address": "example.com",\n        "port": 8388,\n        "method": "2022-blake3-aes-128-gcm",\n        "password": "your-password"\n      }\n    ]\n  }\n}',
    monacoSnippet: '{\n  "tag": "${1:proxy-ss}",\n  "protocol": "shadowsocks",\n  "settings": {\n    "servers": [\n      {\n        "address": "${2:example.com}",\n        "port": ${3:8388},\n        "method": "${4|2022-blake3-aes-128-gcm,2022-blake3-aes-256-gcm,aes-128-gcm,aes-256-gcm,chacha20-poly1305|}",\n        "password": "${5:your-password}"\n      }\n    ]\n  }\n}$0',
  },
];

/* ════════════════════════════════════════════════════════════
 *  Xray · inbounds (вставка в массив inbounds)
 * ════════════════════════════════════════════════════════════ */

const XRAY_INBOUNDS_SNIPPETS = [
  {
    id: 'xray-inbound-socks',
    label: 'inbound: socks',
    detail: 'Xray · inbounds[]',
    documentation: 'Socks5-входящий без авторизации, слушает локально. udp: true нужен для QUIC/UDP-трафика.',
    insertText: '{\n  "tag": "socks-in",\n  "listen": "127.0.0.1",\n  "port": 10808,\n  "protocol": "socks",\n  "settings": {\n    "auth": "noauth",\n    "udp": true\n  },\n  "sniffing": {\n    "enabled": true,\n    "destOverride": ["http", "tls", "quic"]\n  }\n}',
    monacoSnippet: '{\n  "tag": "${1:socks-in}",\n  "listen": "${2:127.0.0.1}",\n  "port": ${3:10808},\n  "protocol": "socks",\n  "settings": {\n    "auth": "${4|noauth,password|}",\n    "udp": ${5|true,false|}\n  },\n  "sniffing": {\n    "enabled": true,\n    "destOverride": ["http", "tls", "quic"]\n  }\n}$0',
  },
  {
    id: 'xray-inbound-http',
    label: 'inbound: http',
    detail: 'Xray · inbounds[]',
    documentation: 'HTTP-прокси входящий. Полезен для браузеров, не поддерживающих SOCKS5.',
    insertText: '{\n  "tag": "http-in",\n  "listen": "127.0.0.1",\n  "port": 10809,\n  "protocol": "http",\n  "settings": {\n    "allowTransparent": false\n  }\n}',
    monacoSnippet: '{\n  "tag": "${1:http-in}",\n  "listen": "${2:127.0.0.1}",\n  "port": ${3:10809},\n  "protocol": "http",\n  "settings": {\n    "allowTransparent": false\n  }\n}$0',
  },
  {
    id: 'xray-inbound-dokodemo',
    label: 'inbound: dokodemo-door (transparent)',
    detail: 'Xray · inbounds[]',
    documentation: 'Transparent-входящий для iptables REDIRECT / TPROXY. На Keenetic — для перехвата трафика LAN.',
    insertText: '{\n  "tag": "transparent-in",\n  "listen": "0.0.0.0",\n  "port": 12345,\n  "protocol": "dokodemo-door",\n  "settings": {\n    "network": "tcp,udp",\n    "followRedirect": true\n  },\n  "streamSettings": {\n    "sockopt": {\n      "tproxy": "tproxy"\n    }\n  },\n  "sniffing": {\n    "enabled": true,\n    "destOverride": ["http", "tls", "quic"]\n  }\n}',
    monacoSnippet: '{\n  "tag": "${1:transparent-in}",\n  "listen": "${2:0.0.0.0}",\n  "port": ${3:12345},\n  "protocol": "dokodemo-door",\n  "settings": {\n    "network": "tcp,udp",\n    "followRedirect": true\n  },\n  "streamSettings": {\n    "sockopt": {\n      "tproxy": "${4|tproxy,redirect,off|}"\n    }\n  },\n  "sniffing": {\n    "enabled": true,\n    "destOverride": ["http", "tls", "quic"]\n  }\n}$0',
  },
];

/* ════════════════════════════════════════════════════════════
 *  Xray · streamSettings (вставка внутри streamSettings объекта)
 * ════════════════════════════════════════════════════════════ */

const XRAY_STREAM_SETTINGS_SNIPPETS = [
  {
    id: 'xray-stream-ws',
    label: 'streamSettings: WebSocket',
    detail: 'Xray · streamSettings',
    documentation: 'WebSocket-транспорт для VLESS/VMess/Trojan. Часто используется за CDN.',
    insertText: '"network": "ws",\n"wsSettings": {\n  "path": "/",\n  "headers": {\n    "Host": "example.com"\n  }\n}',
    monacoSnippet: '"network": "ws",\n"wsSettings": {\n  "path": "${1:/}",\n  "headers": {\n    "Host": "${2:example.com}"\n  }\n}$0',
  },
  {
    id: 'xray-stream-grpc',
    label: 'streamSettings: gRPC',
    detail: 'Xray · streamSettings',
    documentation: 'gRPC-транспорт. Требует TLS и совпадающий serviceName на клиенте/сервере.',
    insertText: '"network": "grpc",\n"grpcSettings": {\n  "serviceName": "xray-svc",\n  "multiMode": false\n}',
    monacoSnippet: '"network": "grpc",\n"grpcSettings": {\n  "serviceName": "${1:xray-svc}",\n  "multiMode": ${2|false,true|}\n}$0',
  },
  {
    id: 'xray-stream-xhttp',
    label: 'streamSettings: XHTTP',
    detail: 'Xray · streamSettings',
    documentation: 'XHTTP-транспорт (новое поколение). Mode stream-one обычно ок для browser-traffic, packet-up — для UDP-like нагрузок.',
    insertText: '"network": "xhttp",\n"xhttpSettings": {\n  "host": "example.com",\n  "path": "/",\n  "mode": "stream-one"\n}',
    monacoSnippet: '"network": "xhttp",\n"xhttpSettings": {\n  "host": "${1:example.com}",\n  "path": "${2:/}",\n  "mode": "${3|stream-one,packet-up,stream-up|}"\n}$0',
  },
  {
    id: 'xray-stream-tcp-http',
    label: 'streamSettings: TCP+HTTP obfuscation',
    detail: 'Xray · streamSettings',
    documentation: 'Raw TCP с HTTP-заголовками для обхода DPI. Устаревает в пользу XHTTP, но ещё встречается.',
    insertText: '"network": "tcp",\n"tcpSettings": {\n  "header": {\n    "type": "http",\n    "request": {\n      "path": ["/"],\n      "headers": {\n        "Host": ["example.com"]\n      }\n    }\n  }\n}',
    monacoSnippet: '"network": "tcp",\n"tcpSettings": {\n  "header": {\n    "type": "http",\n    "request": {\n      "path": ["${1:/}"],\n      "headers": {\n        "Host": ["${2:example.com}"]\n      }\n    }\n  }\n}$0',
  },
];

/* ════════════════════════════════════════════════════════════
 *  Xray · config top-level (dns, observatory)
 * ════════════════════════════════════════════════════════════ */

const XRAY_CONFIG_TOP_LEVEL_SNIPPETS = [
  {
    id: 'xray-config-dns',
    label: 'dns block (Keenetic — по инструкции)',
    detail: 'Xray · config.dns',
    documentation: 'DNS-блок Xray для DNS-over-VLESS сценария. На Keenetic обычно используется вместе с dns-out outbound, routing rules для port 53/dns-in и domainStrategy на proxy/direct.',
    warning: KEENETIC_XRAY_DNS_NOTE,
    insertText: '"dns": {\n  "tag": "dns-in",\n  "servers": [\n    "8.8.8.8"\n  ],\n  "queryStrategy": "UseIP"\n}',
    monacoSnippet: '"dns": {\n  "tag": "${1:dns-in}",\n  "servers": [\n    "${2:8.8.8.8}"\n  ],\n  "queryStrategy": "${3|UseIP,UseIPv4,UseIPv6|}"\n}$0',
  },
  {
    id: 'xray-config-observatory',
    label: 'observatory block',
    detail: 'Xray · config.observatory',
    documentation: 'Observatory — фоновое тестирование outbounds для balancer leastPing/leastLoad. Осторожно с числом subjectSelector — чем больше outbounds, тем выше нагрузка на роутер.',
    insertText: '"observatory": {\n  "subjectSelector": [\n    "proxy-"\n  ],\n  "probeUrl": "http://www.gstatic.com/generate_204",\n  "probeInterval": "5m"\n}',
    monacoSnippet: '"observatory": {\n  "subjectSelector": [\n    "${1:proxy-}"\n  ],\n  "probeUrl": "${2:http://www.gstatic.com/generate_204}",\n  "probeInterval": "${3:5m}"\n}$0',
  },
  {
    id: 'xray-config-observatory-balancer',
    label: 'observatory + balancer scaffold',
    detail: 'Xray · observatory + routing',
    documentation: 'Полный scaffold для leastPing-маршрутизации: observatory, balancer и базовое rule через balancerTag.',
    insertText: '"observatory": {\n  "subjectSelector": [\n    "proxy-"\n  ],\n  "probeUrl": "http://www.gstatic.com/generate_204",\n  "probeInterval": "5m"\n},\n"routing": {\n  "balancers": [\n    {\n      "tag": "balancer-auto",\n      "selector": [\n        "proxy-"\n      ],\n      "strategy": {\n        "type": "leastPing"\n      },\n      "fallbackTag": "direct"\n    }\n  ],\n  "rules": [\n    {\n      "type": "field",\n      "domain": [\n        "geosite:geolocation-!cn"\n      ],\n      "balancerTag": "balancer-auto"\n    }\n  ]\n}',
    monacoSnippet: '"observatory": {\n  "subjectSelector": [\n    "${1:proxy-}"\n  ],\n  "probeUrl": "${2:http://www.gstatic.com/generate_204}",\n  "probeInterval": "${3:5m}"\n},\n"routing": {\n  "balancers": [\n    {\n      "tag": "${4:balancer-auto}",\n      "selector": [\n        "${5:proxy-}"\n      ],\n      "strategy": {\n        "type": "${6|leastPing,leastLoad,random,roundRobin|}"\n      },\n      "fallbackTag": "${7:direct}"\n    }\n  ],\n  "rules": [\n    {\n      "type": "field",\n      "domain": [\n        "${8:geosite:geolocation-!cn}"\n      ],\n      "balancerTag": "${4:balancer-auto}"\n    }\n  ]\n}$0',
  },
];

/* ════════════════════════════════════════════════════════════
 *  Mihomo · proxies (вставка в массив proxies)
 * ════════════════════════════════════════════════════════════ */

const MIHOMO_PROXIES_SNIPPETS = [
  {
    id: 'mihomo-proxy-vless',
    label: 'proxy: vless',
    detail: 'Mihomo · proxies[]',
    documentation: 'VLESS-прокси через TLS. flow xtls-rprx-vision совместим с Xray Reality.',
    insertText: 'name: "vless-proxy"\ntype: vless\nserver: example.com\nport: 443\nuuid: "00000000-0000-0000-0000-000000000000"\nnetwork: tcp\ntls: true\nservername: example.com\nflow: xtls-rprx-vision\nudp: true',
    monacoSnippet: 'name: "${1:vless-proxy}"\ntype: vless\nserver: ${2:example.com}\nport: ${3:443}\nuuid: "${4:00000000-0000-0000-0000-000000000000}"\nnetwork: ${5|tcp,ws,grpc|}\ntls: true\nservername: ${6:example.com}\nflow: ${7|xtls-rprx-vision,|}\nudp: true$0',
  },
  {
    id: 'mihomo-proxy-vmess',
    label: 'proxy: vmess',
    detail: 'Mihomo · proxies[]',
    documentation: 'VMess-прокси. Часто используется с ws+tls за CDN.',
    insertText: 'name: "vmess-proxy"\ntype: vmess\nserver: example.com\nport: 443\nuuid: "00000000-0000-0000-0000-000000000000"\nalterId: 0\ncipher: auto\nnetwork: ws\ntls: true\nservername: example.com\nws-opts:\n  path: /\n  headers:\n    Host: example.com\nudp: true',
    monacoSnippet: 'name: "${1:vmess-proxy}"\ntype: vmess\nserver: ${2:example.com}\nport: ${3:443}\nuuid: "${4:00000000-0000-0000-0000-000000000000}"\nalterId: ${5:0}\ncipher: ${6|auto,aes-128-gcm,chacha20-poly1305,none|}\nnetwork: ws\ntls: true\nservername: ${7:example.com}\nws-opts:\n  path: ${8:/}\n  headers:\n    Host: ${9:example.com}\nudp: true$0',
  },
  {
    id: 'mihomo-proxy-trojan',
    label: 'proxy: trojan',
    detail: 'Mihomo · proxies[]',
    documentation: 'Trojan-прокси через TLS. Минимальные поля — server/port/password/sni.',
    insertText: 'name: "trojan-proxy"\ntype: trojan\nserver: example.com\nport: 443\npassword: "your-password"\nsni: example.com\nudp: true',
    monacoSnippet: 'name: "${1:trojan-proxy}"\ntype: trojan\nserver: ${2:example.com}\nport: ${3:443}\npassword: "${4:your-password}"\nsni: ${5:example.com}\nudp: true$0',
  },
  {
    id: 'mihomo-proxy-ss',
    label: 'proxy: shadowsocks',
    detail: 'Mihomo · proxies[]',
    documentation: 'Shadowsocks-прокси. Поддерживает 2022-шифры и AEAD.',
    insertText: 'name: "ss-proxy"\ntype: ss\nserver: example.com\nport: 8388\ncipher: 2022-blake3-aes-128-gcm\npassword: "your-password"\nudp: true',
    monacoSnippet: 'name: "${1:ss-proxy}"\ntype: ss\nserver: ${2:example.com}\nport: ${3:8388}\ncipher: ${4|2022-blake3-aes-128-gcm,2022-blake3-aes-256-gcm,aes-128-gcm,aes-256-gcm,chacha20-ietf-poly1305|}\npassword: "${5:your-password}"\nudp: true$0',
  },
];

/* ════════════════════════════════════════════════════════════
 *  Mihomo · proxy-groups
 * ════════════════════════════════════════════════════════════ */

const MIHOMO_PROXY_GROUPS_SNIPPETS = [
  {
    id: 'mihomo-group-select',
    label: 'proxy-group: select',
    detail: 'Mihomo · proxy-groups[]',
    documentation: 'Ручной выбор — пользователь выбирает активный прокси в UI.',
    insertText: 'name: "select-manual"\ntype: select\nproxies:\n  - "vless-proxy"\n  - "trojan-proxy"\n  - "DIRECT"',
    monacoSnippet: 'name: "${1:select-manual}"\ntype: select\nproxies:\n  - "${2:vless-proxy}"\n  - "${3:trojan-proxy}"\n  - "${4:DIRECT}"$0',
  },
  {
    id: 'mihomo-group-url-test',
    label: 'proxy-group: url-test',
    detail: 'Mihomo · proxy-groups[]',
    documentation: 'Автовыбор самого быстрого прокси по ping URL. На Keenetic interval >= 300 — 300+ прокси нагружают роутер.',
    insertText: 'name: "auto"\ntype: url-test\nproxies:\n  - "vless-proxy"\n  - "trojan-proxy"\nurl: "http://www.gstatic.com/generate_204"\ninterval: 300\ntolerance: 50',
    monacoSnippet: 'name: "${1:auto}"\ntype: url-test\nproxies:\n  - "${2:vless-proxy}"\n  - "${3:trojan-proxy}"\nurl: "${4:http://www.gstatic.com/generate_204}"\ninterval: ${5:300}\ntolerance: ${6:50}$0',
  },
  {
    id: 'mihomo-group-fallback',
    label: 'proxy-group: fallback',
    detail: 'Mihomo · proxy-groups[]',
    documentation: 'Переключается на следующий прокси, если предыдущий недоступен.',
    insertText: 'name: "fallback"\ntype: fallback\nproxies:\n  - "vless-proxy"\n  - "trojan-proxy"\n  - "ss-proxy"\nurl: "http://www.gstatic.com/generate_204"\ninterval: 300',
    monacoSnippet: 'name: "${1:fallback}"\ntype: fallback\nproxies:\n  - "${2:vless-proxy}"\n  - "${3:trojan-proxy}"\n  - "${4:ss-proxy}"\nurl: "${5:http://www.gstatic.com/generate_204}"\ninterval: ${6:300}$0',
  },
  {
    id: 'mihomo-group-load-balance',
    label: 'proxy-group: load-balance',
    detail: 'Mihomo · proxy-groups[]',
    documentation: 'Распределяет соединения по прокси. Стратегия round-robin или consistent-hashing.',
    insertText: 'name: "load-balance"\ntype: load-balance\nproxies:\n  - "vless-proxy"\n  - "trojan-proxy"\nurl: "http://www.gstatic.com/generate_204"\ninterval: 300\nstrategy: round-robin',
    monacoSnippet: 'name: "${1:load-balance}"\ntype: load-balance\nproxies:\n  - "${2:vless-proxy}"\n  - "${3:trojan-proxy}"\nurl: "${4:http://www.gstatic.com/generate_204}"\ninterval: ${5:300}\nstrategy: ${6|round-robin,consistent-hashing,sticky-sessions|}$0',
  },
];

/* ════════════════════════════════════════════════════════════
 *  Mihomo · proxy-providers / rule-providers
 * ════════════════════════════════════════════════════════════ */

const MIHOMO_PROXY_PROVIDERS_SNIPPETS = [
  {
    id: 'mihomo-proxy-provider-http',
    label: 'proxy-provider: http (subscription)',
    detail: 'Mihomo · proxy-providers',
    documentation: 'Provider подписки. health-check.interval = 300+ рекомендуется, чтобы не перегружать роутер.',
    insertText: 'subscription:\n  type: http\n  url: "https://example.com/subscription"\n  interval: 86400\n  path: ./providers/subscription.yaml\n  health-check:\n    enable: true\n    interval: 300\n    url: "http://www.gstatic.com/generate_204"',
    monacoSnippet: '${1:subscription}:\n  type: http\n  url: "${2:https://example.com/subscription}"\n  interval: ${3:86400}\n  path: ${4:./providers/subscription.yaml}\n  health-check:\n    enable: true\n    interval: ${5:300}\n    url: "${6:http://www.gstatic.com/generate_204}"$0',
  },
];

const MIHOMO_RULE_PROVIDERS_SNIPPETS = [
  {
    id: 'mihomo-rule-provider-domain',
    label: 'rule-provider: domain list',
    detail: 'Mihomo · rule-providers',
    documentation: 'Provider списка доменов (rule type: domain).',
    insertText: 'ads-list:\n  type: http\n  behavior: domain\n  url: "https://example.com/ads.yaml"\n  interval: 86400\n  path: ./rules/ads-list.yaml\n  format: yaml',
    monacoSnippet: '${1:ads-list}:\n  type: http\n  behavior: ${2|domain,ipcidr,classical|}\n  url: "${3:https://example.com/ads.yaml}"\n  interval: ${4:86400}\n  path: ${5:./rules/ads-list.yaml}\n  format: ${6|yaml,text,mrs|}$0',
  },
];

/* ════════════════════════════════════════════════════════════
 *  Mihomo · rules
 * ════════════════════════════════════════════════════════════ */

const MIHOMO_RULES_SNIPPETS = [
  {
    id: 'mihomo-rule-ruleset',
    label: 'rule: RULE-SET -> group',
    detail: 'Mihomo · rules[]',
    documentation: 'Применяет rule-provider через RULE-SET и направляет совпадения в proxy-group или встроенный target.',
    insertText: 'RULE-SET,custom-list,auto',
    monacoSnippet: 'RULE-SET,${1:custom-list},${2:auto}$0',
  },
  {
    id: 'mihomo-rule-domain-suffix',
    label: 'rule: DOMAIN-SUFFIX -> group',
    detail: 'Mihomo · rules[]',
    documentation: 'Маршрутизация по доменному суффиксу. Подходит для простых targeted-rules без provider.',
    insertText: 'DOMAIN-SUFFIX,example.com,auto',
    monacoSnippet: 'DOMAIN-SUFFIX,${1:example.com},${2:auto}$0',
  },
  {
    id: 'mihomo-rule-geoip-direct',
    label: 'rule: GEOIP -> DIRECT',
    detail: 'Mihomo · rules[]',
    documentation: 'Направляет трафик выбранной страны напрямую. Типовой baseline для локального/регионального трафика.',
    insertText: 'GEOIP,RU,DIRECT',
    monacoSnippet: 'GEOIP,${1:RU},${2:DIRECT}$0',
  },
];

/* ════════════════════════════════════════════════════════════
 *  Mihomo · top-level (dns, tun, sniffer)
 * ════════════════════════════════════════════════════════════ */

const MIHOMO_TOP_LEVEL_SNIPPETS = [
  {
    id: 'mihomo-bundle-rule-provider-ruleset',
    label: 'rule-provider + RULE-SET',
    detail: 'Mihomo · rule-providers + rules',
    documentation: 'Готовый scaffold для provider и соответствующего RULE-SET правила. Хороший старт для ads/custom lists.',
    insertText: 'rule-providers:\n  custom-list:\n    type: http\n    behavior: domain\n    url: "https://example.com/rules/custom-list.yaml"\n    interval: 86400\n    path: ./rules/custom-list.yaml\n    format: yaml\nrules:\n  - RULE-SET,custom-list,auto',
    monacoSnippet: 'rule-providers:\n  ${1:custom-list}:\n    type: http\n    behavior: ${2|domain,ipcidr,classical|}\n    url: "${3:https://example.com/rules/custom-list.yaml}"\n    interval: ${4:86400}\n    path: ${5:./rules/custom-list.yaml}\n    format: ${6|yaml,text,mrs|}\nrules:\n  - RULE-SET,${1:custom-list},${7:auto}$0',
  },
  {
    id: 'mihomo-dns-block',
    label: 'dns block (Keenetic — обычно не нужен)',
    detail: 'Mihomo · dns',
    documentation: 'DNS-блок Mihomo. Настраивает nameserver, fake-ip и fallback. Обычно нужен только если активно используется TUN/transparent-режим.',
    warning: KEENETIC_MIHOMO_DNS_NOTE,
    insertText: 'dns:\n  enable: true\n  ipv6: false\n  enhanced-mode: fake-ip\n  fake-ip-range: 198.18.0.1/16\n  fake-ip-filter:\n    - "*.lan"\n    - "localhost.ptlogin2.qq.com"\n  nameserver:\n    - https://1.1.1.1/dns-query\n    - https://dns.google/dns-query\n  fallback:\n    - tls://8.8.4.4:853\n  fallback-filter:\n    geoip: true\n    geoip-code: RU',
    monacoSnippet: 'dns:\n  enable: true\n  ipv6: ${1|false,true|}\n  enhanced-mode: ${2|fake-ip,redir-host|}\n  fake-ip-range: ${3:198.18.0.1/16}\n  fake-ip-filter:\n    - "*.lan"\n    - "localhost.ptlogin2.qq.com"\n  nameserver:\n    - ${4:https://1.1.1.1/dns-query}\n    - ${5:https://dns.google/dns-query}\n  fallback:\n    - ${6:tls://8.8.4.4:853}\n  fallback-filter:\n    geoip: true\n    geoip-code: ${7:RU}$0',
  },
  {
    id: 'mihomo-tun-block',
    label: 'tun block (Keenetic — обычно не нужен)',
    detail: 'Mihomo · tun',
    documentation: 'TUN-блок Mihomo. Включает виртуальный сетевой интерфейс для transparent-проксирования.',
    warning: KEENETIC_MIHOMO_TUN_NOTE,
    insertText: 'tun:\n  enable: true\n  stack: system\n  auto-route: true\n  auto-detect-interface: true\n  dns-hijack:\n    - any:53\n    - tcp://any:53\n  mtu: 9000\n  strict-route: true',
    monacoSnippet: 'tun:\n  enable: ${1|true,false|}\n  stack: ${2|system,gvisor,mixed|}\n  auto-route: true\n  auto-detect-interface: true\n  dns-hijack:\n    - any:53\n    - tcp://any:53\n  mtu: ${3:9000}\n  strict-route: ${4|true,false|}$0',
  },
  {
    id: 'mihomo-sniffer-block',
    label: 'sniffer block',
    detail: 'Mihomo · sniffer',
    documentation: 'Sniffer — восстанавливает host/SNI из пакетов для правильного матчинга в rules. На Keenetic безопасен и рекомендуется.',
    insertText: 'sniffer:\n  enable: true\n  sniff:\n    HTTP:\n    TLS:',
    monacoSnippet: 'sniffer:\n  enable: ${1|true,false|}\n  sniff:\n    HTTP:\n    TLS:$0',
  },
];

/* ════════════════════════════════════════════════════════════
 *  Matching helpers
 * ════════════════════════════════════════════════════════════ */

function normalizePointer(pointer) {
  if (pointer == null) return '';
  let value = String(pointer);
  if (!value) return '';
  if (value.charAt(0) !== '/') value = `/${value}`;
  return value;
}

function normalizePath(path) {
  if (!Array.isArray(path)) return [];
  return path.map((item) => String(item == null ? '' : item));
}

function pathToPointer(path) {
  const parts = normalizePath(path).map((item) => {
    return item.replace(/~/g, '~0').replace(/\//g, '~1');
  });
  return parts.length ? `/${parts.join('/')}` : '';
}

function isNumericSegment(segment) {
  if (segment == null) return false;
  return /^\d+$/.test(String(segment));
}

function normalizeContextKind(kind) {
  const value = String(kind || '').toLowerCase();
  return value === 'array-item' || value === 'key' || value === 'value' ? value : '';
}

function matchesXrayRoutingRulesPointer(pointer) {
  const normalized = normalizePointer(pointer);
  if (!normalized) return false;
  if (/^\/rules$/.test(normalized)) return true;
  if (/^\/routing\/rules$/.test(normalized)) return true;
  return false;
}

function matchesXrayRoutingBalancersPointer(pointer) {
  const normalized = normalizePointer(pointer);
  if (!normalized) return false;
  if (/^\/balancers$/.test(normalized)) return true;
  if (/^\/routing\/balancers$/.test(normalized)) return true;
  return false;
}

function matchesXrayOutboundsArrayPointer(pointer) {
  const normalized = normalizePointer(pointer);
  if (!normalized) return false;
  return /^\/outbounds$/.test(normalized);
}

function matchesXrayInboundsArrayPointer(pointer) {
  const normalized = normalizePointer(pointer);
  if (!normalized) return false;
  return /^\/inbounds$/.test(normalized);
}

function matchesXrayStreamSettingsPointer(pointer) {
  const normalized = normalizePointer(pointer);
  if (!normalized) return false;
  return /\/streamSettings$/.test(normalized);
}

function matchesXrayConfigRootPointer(pointer) {
  const normalized = normalizePointer(pointer);
  return normalized === '' || normalized === '/';
}

function matchesMihomoRootPath(path) {
  const normalized = normalizePath(path);
  return normalized.length === 0;
}

function matchesMihomoArrayPath(path, rootKey, kind, options = {}) {
  const normalized = normalizePath(path);
  const contextKind = normalizeContextKind(kind);
  const allowValue = Boolean(options.allowValue);
  if (!normalized.length) return false;
  if (normalized[0] !== rootKey) return false;
  if (normalized.length === 1) return !contextKind || contextKind === 'key';
  if (normalized.length !== 2 || !isNumericSegment(normalized[1])) return false;
  if (!contextKind || contextKind === 'array-item' || contextKind === 'key') return true;
  return allowValue && contextKind === 'value';
}

function matchesMihomoMapEntryPath(path, rootKey, kind) {
  const normalized = normalizePath(path);
  const contextKind = normalizeContextKind(kind);
  if (!normalized.length) return false;
  if (normalized[0] !== rootKey) return false;
  return normalized.length === 1 && (!contextKind || contextKind === 'key');
}

function matchesMihomoProxiesArrayPath(path, kind) {
  return matchesMihomoArrayPath(path, 'proxies', kind);
}

function matchesMihomoProxyGroupsArrayPath(path, kind) {
  return matchesMihomoArrayPath(path, 'proxy-groups', kind);
}

function matchesMihomoRulesArrayPath(path, kind) {
  return matchesMihomoArrayPath(path, 'rules', kind, { allowValue: true });
}

function matchesMihomoProxyProvidersPath(path, kind) {
  return matchesMihomoMapEntryPath(path, 'proxy-providers', kind);
}

function matchesMihomoRuleProvidersPath(path, kind) {
  return matchesMihomoMapEntryPath(path, 'rule-providers', kind);
}

/* ════════════════════════════════════════════════════════════
 *  Public API — Xray
 * ════════════════════════════════════════════════════════════ */

function normalizeXraySchemaKind(value) {
  const raw = String(value || '').toLowerCase();
  if (!raw) return '';
  if (raw.includes('routing')) return 'xray-routing';
  if (raw.includes('outbound')) return 'xray-outbounds';
  if (raw.includes('inbound')) return 'xray-inbounds';
  if (raw.includes('config')) return 'xray-config';
  if (raw === 'xray') return 'xray-config';
  return raw;
}

export function getXraySnippets(params) {
  const input = params && typeof params === 'object' ? params : {};
  const schemaKind = normalizeXraySchemaKind(input.schemaKind);
  const pointer = normalizePointer(input.pointer);
  const list = [];

  if (schemaKind === 'xray-routing' || schemaKind === 'xray-config') {
    if (matchesXrayRoutingRulesPointer(pointer)) list.push(...XRAY_ROUTING_RULES_SNIPPETS);
    if (matchesXrayRoutingBalancersPointer(pointer)) list.push(...XRAY_ROUTING_BALANCERS_SNIPPETS);
  }
  if (schemaKind === 'xray-outbounds') {
    if (matchesXrayOutboundsArrayPointer(pointer) || pointer === '' || pointer === '/') {
      list.push(...XRAY_OUTBOUNDS_SNIPPETS);
    }
    if (matchesXrayStreamSettingsPointer(pointer)) list.push(...XRAY_STREAM_SETTINGS_SNIPPETS);
  }
  if (schemaKind === 'xray-inbounds') {
    if (matchesXrayInboundsArrayPointer(pointer) || pointer === '' || pointer === '/') {
      list.push(...XRAY_INBOUNDS_SNIPPETS);
    }
    if (matchesXrayStreamSettingsPointer(pointer)) list.push(...XRAY_STREAM_SETTINGS_SNIPPETS);
  }
  if (schemaKind === 'xray-config') {
    if (matchesXrayOutboundsArrayPointer(pointer)) list.push(...XRAY_OUTBOUNDS_SNIPPETS);
    if (matchesXrayInboundsArrayPointer(pointer)) list.push(...XRAY_INBOUNDS_SNIPPETS);
    if (matchesXrayStreamSettingsPointer(pointer)) list.push(...XRAY_STREAM_SETTINGS_SNIPPETS);
    if (matchesXrayConfigRootPointer(pointer)) list.push(...XRAY_CONFIG_TOP_LEVEL_SNIPPETS);
  }

  return list.map(cloneSnippet);
}

/* ════════════════════════════════════════════════════════════
 *  Public API — Mihomo
 * ════════════════════════════════════════════════════════════ */

export function getMihomoSnippets(params) {
  const input = params && typeof params === 'object' ? params : {};
  const path = normalizePath(input.path);
  const kind = normalizeContextKind(input.kind);
  const list = [];

  if (matchesMihomoRootPath(path)) {
    list.push(...MIHOMO_TOP_LEVEL_SNIPPETS);
  }
  if (matchesMihomoProxiesArrayPath(path, kind)) {
    list.push(...MIHOMO_PROXIES_SNIPPETS);
  }
  if (matchesMihomoProxyGroupsArrayPath(path, kind)) {
    list.push(...MIHOMO_PROXY_GROUPS_SNIPPETS);
  }
  if (matchesMihomoProxyProvidersPath(path, kind)) {
    list.push(...MIHOMO_PROXY_PROVIDERS_SNIPPETS);
  }
  if (matchesMihomoRuleProvidersPath(path, kind)) {
    list.push(...MIHOMO_RULE_PROVIDERS_SNIPPETS);
  }
  if (matchesMihomoRulesArrayPath(path, kind)) {
    list.push(...MIHOMO_RULES_SNIPPETS);
  }

  return list.map(cloneSnippet);
}

/* ════════════════════════════════════════════════════════════
 *  Snippet provider factories — используются редакторами
 * ════════════════════════════════════════════════════════════ */

export function createXraySnippetProvider(schemaKind) {
  const kind = normalizeXraySchemaKind(schemaKind);
  return function xraySnippetProvider(ctx) {
    const context = ctx && typeof ctx === 'object' ? ctx : {};
    return getXraySnippets({
      schemaKind: context.schemaKind || kind,
      pointer: context.pointer || '',
    });
  };
}

export function createMihomoSnippetProvider() {
  return function mihomoSnippetProvider(ctx) {
    const context = ctx && typeof ctx === 'object' ? ctx : {};
    return getMihomoSnippets({
      path: context.path || [],
      kind: context.kind || '',
    });
  };
}

function cloneSnippet(snippet) {
  if (!snippet || typeof snippet !== 'object') return snippet;
  return {
    id: String(snippet.id || ''),
    label: String(snippet.label || ''),
    kind: 'snippet',
    detail: String(snippet.detail || ''),
    documentation: String(snippet.documentation || ''),
    warning: snippet.warning ? String(snippet.warning) : null,
    insertText: String(snippet.insertText || ''),
    monacoSnippet: String(snippet.monacoSnippet || snippet.insertText || ''),
  };
}

/* ════════════════════════════════════════════════════════════
 *  Helpers for editor runtimes
 * ════════════════════════════════════════════════════════════ */

export function renderSnippetDocumentation(snippet) {
  if (!snippet || typeof snippet !== 'object') return '';
  const parts = [];
  if (snippet.documentation) parts.push(String(snippet.documentation));
  if (snippet.warning) parts.push(`⚠ ${String(snippet.warning)}`);
  return parts.join('\n\n');
}

export function snippetsToCompletionOptions(snippets, options = {}) {
  const list = Array.isArray(snippets) ? snippets : [];
  const mode = options && options.mode === 'monaco' ? 'monaco' : 'cm6';
  return list
    .filter((item) => item && typeof item === 'object' && item.label && (item.insertText || item.monacoSnippet))
    .map((item) => ({
      id: item.id,
      label: item.label,
      type: 'snippet',
      detail: item.detail || '',
      insertText: mode === 'monaco' ? (item.monacoSnippet || item.insertText) : item.insertText,
      useSnippetSyntax: mode === 'monaco',
      documentation: renderSnippetDocumentation(item),
      warning: item.warning || null,
    }));
}

export const schemaSnippetsApi = Object.freeze({
  getXraySnippets,
  getMihomoSnippets,
  createXraySnippetProvider,
  createMihomoSnippetProvider,
  renderSnippetDocumentation,
  snippetsToCompletionOptions,
});
