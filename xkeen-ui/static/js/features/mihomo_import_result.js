/**
 * Safe, DOM-agnostic presentation model for the Mihomo import workbench.
 *
 * Parsers keep returning their existing YAML-oriented outputs. This module
 * reads only the small non-secret subset needed for result cards, so cards
 * never need to render a source URL, credentials, or raw YAML.
 */

const SECRET_KEY_RE = /(password|uuid|private[-_ ]?key|public[-_ ]?key|token|secret|auth(?:orization)?|sid|short[-_ ]?id)/i;
const URL_RE = /(?:[a-z][a-z\d+.-]*):\/\/[^\s'"<>]+/gi;
const MAX_DIAGNOSTIC_LENGTH = 220;

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function unique(items) {
  return Array.from(new Set((items || []).map(clean).filter(Boolean)));
}

function unquote(value) {
  const text = clean(value);
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
}

function yamlScalar(content, key) {
  const escaped = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(content || '').match(new RegExp(`^\\s*(?:-\\s*)?${escaped}\\s*:\\s*(.+?)\\s*(?:#.*)?$`, 'mi'));
  return match ? unquote(match[1]) : '';
}

function safeHost(value) {
  const raw = clean(value).replace(/^\[|\]$/g, '');
  if (!raw) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return clean(url.hostname).toLowerCase();
  } catch (error) {
    return raw
      .replace(/^[^@/]+@/, '')
      .replace(/[/?#].*$/, '')
      .replace(/[^a-zA-Z0-9.:[\]-]/g, '')
      .slice(0, 160);
  }
}

export function safeMihomoSourceDomain(value) {
  const raw = clean(value);
  if (!raw) return '';
  if (/^happ:\/\//i.test(raw) || /^happ\*:/i.test(raw)) return 'Утилита ссылок подписок';
  try {
    const url = new URL(raw);
    const host = clean(url.hostname).toLowerCase();
    if (!host) return 'внешний источник';
    const nonDefaultPort = url.port && !((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80'));
    return nonDefaultPort ? `${host}:${url.port}` : host;
  } catch (error) {
    return '';
  }
}

export function redactMihomoImportDiagnostic(value) {
  let text = clean(value)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  if (!text) return 'Неизвестная причина.';
  text = text.replace(URL_RE, (url) => {
    const domain = safeMihomoSourceDomain(url);
    return domain ? `источник ${domain}` : 'источник скрыт';
  });
  text = text.replace(/\b(?:vless|vmess|trojan|ss|hy2|hysteria2|wireguard|openvpn|tailscale|vpn):[^\s]+/gi, 'ссылка скрыта');
  text = text.replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer скрыто');
  text = text.replace(/\b([\w.-]*(?:password|uuid|private[-_ ]?key|public[-_ ]?key|token|secret|auth(?:orization)?|sid|short[-_ ]?id)[\w.-]*)\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|"[^\r\n]*|'[^\r\n]*|[^\s,;]+)/gi, '$1: скрыто');
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > MAX_DIAGNOSTIC_LENGTH) text = `${text.slice(0, MAX_DIAGNOSTIC_LENGTH - 1).trimEnd()}…`;
  return text || 'Неизвестная причина.';
}

function proxyFields(output) {
  const content = String(output?.content || '');
  const type = clean(yamlScalar(content, 'type')).toLowerCase();
  const server = safeHost(yamlScalar(content, 'server'));
  const port = clean(yamlScalar(content, 'port'));
  const transport = clean(yamlScalar(content, 'network')).toLowerCase();
  const tls = clean(yamlScalar(content, 'tls')).toLowerCase();
  const reality = /(^|\n)\s*reality-opts\s*:/i.test(content);
  const auth = [
    yamlScalar(content, 'uuid'),
    yamlScalar(content, 'password'),
    yamlScalar(content, 'private-key'),
  ].find(Boolean) || '';
  return { type, server, port, transport, tls, reality, auth };
}

function existingProxyFields(configText) {
  const blocks = String(configText || '').split(/(?=^\s*-\s*name\s*:)/m);
  return blocks
    .filter((block) => /^\s*-\s*name\s*:/m.test(block))
    .map((block) => ({ name: yamlScalar(block, 'name'), ...proxyFields({ content: block }) }))
    .filter((item) => item.type && item.server && item.port);
}

function duplicateConnection(fields, existing) {
  if (!fields.type || !fields.server || !fields.port) return null;
  return (existing || []).find((item) => (
    item.type === fields.type
    && item.server === fields.server
    && item.port === fields.port
    && (!fields.auth || !item.auth || item.auth === fields.auth)
  )) || null;
}

function protocolTitle(type) {
  const labels = {
    vless: 'VLESS', vmess: 'VMess', trojan: 'Trojan', ss: 'Shadowsocks',
    shadowsocks: 'Shadowsocks', hysteria2: 'Hysteria2', wireguard: 'WireGuard',
    openvpn: 'OpenVPN', tailscale: 'Tailscale', direct: 'Direct',
  };
  return labels[String(type || '').toLowerCase()] || 'Узел Mihomo';
}

function modeTitle(mode) {
  const labels = {
    wireguard: 'WireGuard / AmneziaWG', openvpn: 'OpenVPN', tailscale: 'Tailscale',
  };
  return labels[String(mode || '').toLowerCase()] || '';
}

function countText(count, single, few, many) {
  const number = Number(count) || 0;
  const mod10 = number % 10;
  const mod100 = number % 100;
  const word = mod10 === 1 && mod100 !== 11 ? single : (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14) ? few : many);
  return `${number} ${word}`;
}

function sourceKind(output, mode) {
  if (output?.xrayBulk) return 'xray-subscription';
  if (output?.providerStaticBulk) {
    return String(output?.provider_mode || '').toLowerCase() === 'static_happ'
      ? 'hwid-subscription'
      : 'provider-static-subscription';
  }
  if (output?.type === 'proxy-provider') return 'provider-subscription';
  if (output?.amnezia || String(output?.uri || '').toLowerCase() === 'amnezia premium' || mode === 'amnezia-premium') return 'amnezia';
  return 'proxy';
}

function resultError(error, index) {
  if (error && typeof error === 'object') {
    const line = Number(error.line);
    const prefix = line > 0 ? `Строка ${line}: ` : '';
    return `${prefix}${redactMihomoImportDiagnostic(error.message || error.error || '')}`;
  }
  const prefix = index >= 0 ? `Элемент ${index + 1}: ` : '';
  return `${prefix}${redactMihomoImportDiagnostic(error)}`;
}

function classifyDiagnostics(errors) {
  const text = (errors || []).map((error) => clean(
    error && typeof error === 'object'
      ? (error.code || error.status || error.message || error.error)
      : error,
  )).join(' ').toLowerCase();
  if (/(blocked|forbidden|access denied|доступ заблок|доступ запрещ|403)/i.test(text)) return 'blocked';
  if (/(unsupported|not supported|not_xray_json|не поддерж|неверный формат)/i.test(text)) return 'unsupported';
  return 'unknown';
}

function proxyCard(output, mode, existing) {
  const fields = proxyFields(output);
  const notices = [];
  const conflict = output?.name_conflict || output?.nameConflict || null;
  if (conflict && clean(conflict.requested) && clean(conflict.suggested)) {
    notices.push({ tone: 'warning', text: `Имя «${clean(conflict.requested)}» уже занято; предложено «${clean(conflict.suggested)}».` });
  }
  const duplicate = duplicateConnection(fields, existing);
  if (duplicate) {
    notices.push({ tone: 'warning', text: `Похожее подключение уже есть в config.yaml: «${clean(duplicate.name) || 'без имени'}».` });
  }
  const transport = fields.transport ? `Транспорт: ${fields.transport}` : '';
  const security = fields.reality ? 'Защита: Reality' : (fields.tls === 'true' ? 'Защита: TLS' : '');
  const special = modeTitle(mode);
  return {
    kind: 'proxy',
    title: clean(output?.proxy_name) || protocolTitle(fields.type),
    badge: special || protocolTitle(fields.type),
    source: fields.server ? `${fields.server}${fields.port ? `:${fields.port}` : ''}` : 'Адрес не указан parser-ом',
    sourceLabel: fields.server ? 'Адрес' : 'Состояние',
    details: [transport, security].filter(Boolean),
    destination: 'proxies',
    notices,
  };
}

function subscriptionCard(kind, items, mode, errors) {
  const first = items[0] || {};
  const domain = safeMihomoSourceDomain(first.uri);
  const received = items.length;
  const type = kind === 'xray-subscription'
    ? 'Xray-JSON → статические узлы'
    : (kind === 'hwid-subscription'
      ? 'Happ / HWID → статические узлы'
      : (kind === 'provider-static-subscription' ? 'Подписка → статические узлы' : 'Mihomo provider'));
  const destination = kind === 'provider-subscription' ? 'proxy-providers' : 'proxies';
  const notices = [];
  if (!domain && kind !== 'provider-subscription') notices.push({ tone: 'warning', text: 'Источник не раскрыл безопасный домен; адрес не показан.' });
  if (kind === 'hwid-subscription') notices.push({ tone: 'info', text: 'Использован совместимый статический импорт; HWID/заголовки не выводятся в карточке.' });
  if (errors.length) notices.push({ tone: 'warning', text: `Пропущено: ${countText(errors.length, 'элемент', 'элемента', 'элементов')}.` });
  const providerWarnings = unique(items.flatMap((item) => Array.isArray(item?.provider_warnings) ? item.provider_warnings : []));
  providerWarnings.forEach((warning) => notices.push({ tone: 'warning', text: redactMihomoImportDiagnostic(warning) }));
  return {
    kind,
    title: domain || (kind === 'provider-subscription' ? 'Подписка как provider' : 'Подписка'),
    badge: type,
    source: domain || 'Домен не раскрыт',
    sourceLabel: 'Источник',
    details: [`Получено: ${countText(received, 'узел', 'узла', 'узлов')}`, `Назначение: ${destination}`],
    destination,
    notices,
  };
}

function amneziaCard({ outputs, locations, selectedLocations, phase, errors }) {
  const selected = selectedLocations || [];
  const total = (locations || []).length;
  const issued = outputs.length > 0 || phase === 'issued';
  const details = issued
    ? [`Получено: ${countText(outputs.length, 'конфигурация', 'конфигурации', 'конфигураций')}`, `Выбрано локаций: ${selected.length || outputs.length}`]
    : [`Доступно локаций: ${total}`, `Выбрано: ${selected.length} — конфиги ещё не выпущены`];
  const notices = [{ tone: 'info', text: issued
    ? 'Сетевая доступность узлов ещё не проверялась.'
    : 'Выберите локации и явно запросите выпуск конфигураций.' }];
  if (errors.length) notices.push({ tone: 'warning', text: `Не выдано: ${countText(errors.length, 'локация', 'локации', 'локаций')}.` });
  return {
    kind: 'amnezia',
    title: 'Amnezia Premium',
    badge: issued ? 'Конфигурации готовы' : 'Выбор локаций',
    source: issued ? 'Выбранные локации' : 'Выдача ещё не запущена',
    sourceLabel: 'Состояние',
    details,
    destination: issued ? 'proxies' : '',
    notices,
  };
}

/**
 * Converts existing parser outputs into a safe card model. Never returns raw
 * input URLs, YAML, credentials, or backend diagnostics untouched.
 */
export function createMihomoImportPresentation({
  outputs = [],
  errors = [],
  mode = 'auto',
  existingConfig = '',
  amneziaLocations = [],
  selectedAmneziaLocations = [],
  phase = '',
} = {}) {
  const cleanOutputs = Array.isArray(outputs) ? outputs.filter((item) => item && typeof item === 'object') : [];
  const diagnostics = unique((Array.isArray(errors) ? errors : []).map(resultError));
  const existing = existingProxyFields(existingConfig);
  const cards = [];

  if (String(mode) === 'amnezia-premium' && (!cleanOutputs.length || cleanOutputs.some((item) => sourceKind(item, mode) === 'amnezia'))) {
    cards.push(amneziaCard({
      outputs: cleanOutputs,
      locations: amneziaLocations,
      selectedLocations: selectedAmneziaLocations,
      phase,
      errors: diagnostics,
    }));
  }

  const grouped = new Map();
  cleanOutputs.forEach((output) => {
    const kind = sourceKind(output, mode);
    if (kind === 'amnezia') return;
    const key = kind === 'proxy' ? `proxy:${cards.length}:${clean(output.proxy_name)}` : `${kind}:${clean(output.uri) || clean(output.provider_name)}`;
    const list = grouped.get(key) || { kind, items: [] };
    list.items.push(output);
    grouped.set(key, list);
  });

  grouped.forEach(({ kind, items }) => {
    if (kind === 'proxy') items.forEach((output) => cards.push(proxyCard(output, mode, existing)));
    else cards.push(subscriptionCard(kind, items, mode, diagnostics));
  });

  const received = cleanOutputs.length;
  const known = received > 0;
  const outcome = known ? 'received' : classifyDiagnostics(errors);
  const summary = known
    ? `Распознано: ${countText(received, 'элемент', 'элемента', 'элементов')}${diagnostics.length ? `; пропущено: ${countText(diagnostics.length, 'элемент', 'элемента', 'элементов')}` : ''}.`
    : (outcome === 'blocked'
      ? 'Результат не получен: доступ к источнику заблокирован.'
      : (outcome === 'unsupported'
        ? 'Результат не получен: формат источника не поддерживается.'
        : (diagnostics.length ? 'Результат не получен: источник не удалось разобрать.' : 'Результат ещё не получен.')));
  const destinations = unique(cards.map((card) => card.destination).filter(Boolean));

  return {
    known,
    received,
    skipped: diagnostics.length,
    outcome,
    summary,
    diagnostics,
    destinations,
    cards,
  };
}
/** Bound rendering only: parser outputs remain intact for the full import. */
export function limitMihomoImportItems(items, limit = 50) {
  const all = Array.isArray(items) ? items : [];
  return { items: all.slice(0, limit), hidden: Math.max(0, all.length - limit) };
}
