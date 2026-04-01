import { getRoutingCardsNamespace } from '../routing_cards_namespace.js';

/*
  routing_cards/help_docs.js
  RC-05: Routing field docs extracted from routing_cards.js.
*/
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  const RC = getRoutingCardsNamespace();
  RC.state = RC.state || {};

  if (RC.ROUTING_FIELD_DOCS) return;

  RC.ROUTING_FIELD_DOCS = {
    domainStrategy: {
      title: 'domainStrategy',
      desc: 'Стратегия разрешения доменных имен для маршрутизации.',
      items: [
        '"AsIs": использовать домен как есть (значение по умолчанию).',
        '"IPIfNonMatch": если домен не совпал с правилами, резолвится в IP и выполняется повторное сопоставление.',
        '"IPOnDemand": домен резолвится в IP при первом правиле, требующем IP сопоставления.',
      ],
    },
    domain: {
      title: 'domain',
      desc: 'Список доменных условий. Правило срабатывает при совпадении любого элемента.',
      items: [
        'Простая строка: совпадение по подстроке.',
        'regexp: регулярное выражение.',
        'domain: домен и поддомены.',
        'full: точное совпадение домена.',
        'geosite: имя списка доменов.',
        'ext:файл:тег — домены из файла ресурсов (формат как geosite.dat).',
      ],
    },
    ip: {
      title: 'ip',
      desc: 'Список диапазонов IP назначения. Совпадение любого элемента.',
      items: [
        'IP-адрес, например 127.0.0.1.',
        'CIDR, например 10.0.0.0/8 или ::/0.',
        'geoip:код_страны, например geoip:cn.',
        'geoip:private — частные адреса.',
        'geoip:!cn — исключение (поддерживается отрицание).',
        'ext:файл:тег — IP из файла ресурсов (формат как geoip.dat).',
      ],
    },
    port: {
      title: 'port',
      desc: 'Порты назначения.',
      items: [
        '"a-b": диапазон портов.',
        '"a": один порт.',
        '"a,b,..." смесь диапазонов и одиночных значений.',
      ],
    },
    sourcePort: {
      title: 'sourcePort',
      desc: 'Порты источника. Формат как у port.',
    },
    localPort: {
      title: 'localPort',
      desc: 'Порт локального inbound. Формат как у port/sourcePort.',
    },
    network: {
      title: 'network',
      desc: 'Тип сети для сопоставления.',
      items: [
        '"tcp"', '"udp"', '"tcp,udp"',
      ],
      note: 'tcp,udp можно использовать в качестве catch‑all в конце списка правил.',
    },
    sourceIP: {
      title: 'sourceIP',
      desc: 'IP источника. Форматы такие же, как у ip.',
      note: 'Псевдоним: source.',
    },
    localIP: {
      title: 'localIP',
      desc: 'IP, на котором принято входящее соединение.',
      note: 'Для UDP не работает — localIP не отслеживается.',
    },
    user: {
      title: 'user',
      desc: 'Email пользователя. Поддерживает regexp: для регулярных выражений.',
    },
    vlessRoute: {
      title: 'vlessRoute',
      desc: 'Диапазон данных VLESS (7–8 байты UUID). Формат как у port.',
      note: 'Интерпретируется как uint16 (big‑endian), можно задавать диапазоны.',
    },
    inboundTag: {
      title: 'inboundTag',
      desc: 'Список тегов inbound. Совпадение любого тега.',
    },
    protocol: {
      title: 'protocol',
      desc: 'Протоколы, определяемые sniffing.',
      items: [
        'http, tls, quic, bittorrent',
      ],
      note: 'Для определения протокола должен быть включен sniffing.',
    },
    attrs: {
      title: 'attrs',
      desc: 'HTTP‑атрибуты: ключ/значение строками. Срабатывает, если присутствуют все ключи.',
      items: [
        'Примеры: :method=GET',
        ':path=/test',
        'accept=text/html',
      ],
    },
    outboundTag: {
      title: 'outboundTag',
      desc: 'Тег outbound, куда направлять трафик.',
    },
    balancerTag: {
      title: 'balancerTag',
      desc: 'Тег балансировщика (используется вместо outboundTag).',
      note: 'Нужно указать либо outboundTag, либо balancerTag; при наличии обоих используется outboundTag.',
    },
    balancer: {
      title: 'balancer (routing.balancers)',
      desc: 'Балансировщик выбирает outbound из набора selector и используется в правилах через balancerTag.',
      items: [
        'tag — идентификатор балансировщика (нужен для balancerTag в правилах).',
        'selector — список префиксов outboundTag (выбираются все outbound, чьи теги начинаются с префикса).',
        'strategy — алгоритм выбора (например random или leastPing).',
        'fallbackTag — запасной outbound, если выбранные недоступны (обычно требует observatory).',
      ],
    },
    ruleTag: {
      title: 'ruleTag',
      desc: 'Тег правила для идентификации и логов; на маршрутизацию не влияет.',
      note: 'Рекомендуется задавать уникальный ruleTag — UI использует его как стабильный ключ для сохранения JSONC‑комментариев при reorder/правках.',
    },
    'balancer.tag': {
      title: 'balancer.tag',
      desc: 'Тег балансировщика; используется в balancerTag правил.',
      note: 'Должен быть уникальным — это помогает сохранять JSONC‑комментарии при reorder/правках балансировщиков.',
    },
    'balancer.selector': {
      title: 'balancer.selector',
      desc: 'Список префиксов тегов outbound. Выбираются все outbound, чьи теги начинаются с элемента selector.',
      items: [
        'Пример: "vless-" выберет outbounds с тегами vless-1, vless-2 и т.п.',
        'Можно указывать и полный tag для точного выбора.',
      ],
    },
    'balancer.fallbackTag': {
      title: 'balancer.fallbackTag',
      desc: 'Запасной outbound, если все выбранные недоступны.',
      note: 'Требуется observatory или burstObservatory.',
    },
    'balancer.strategy': {
      title: 'balancer.strategy',
      desc: 'StrategyObject: JSON с алгоритмом балансировки (random/leastLoad и др.).',
    },
  };
})();
