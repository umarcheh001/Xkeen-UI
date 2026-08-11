import { iconHtml } from '../../ui/operator_icons.js';
import { confirmMihomoAction } from '../mihomo_runtime.js';
import {
  fetchMihomoClashGroups,
  selectMihomoClashProxy,
  testMihomoClashDelay,
  unfixMihomoClashProxy,
} from './client.js';

const SELECTABLE_TYPES = new Set(['selector', 'select', 'urltest', 'fallback', 'smart']);
// Probe one target at a time. Mihomo itself serializes delay checks on
// low-power routers; browser-side parallelism only creates a long busy queue.
const MAX_DELAY_CONCURRENCY = 1;
const MAX_BUSY_RETRIES = 2;
const DELAY_BATCH_CADENCE_MS = 120;
const TIMEOUT_HIDE_THRESHOLD = 3;
const AUTOMATIC_TYPES = new Set(['urltest', 'fallback', 'smart']);

let root = null;
let active = false;
let payload = null;
let filterText = '';
let showHidden = false;
let request = null;
let requestSequence = 0;
let selection = null;
let capabilities = {};
let sortMode = 'config';
let showTimeoutHidden = false;
let delayRun = null;
const collapsedGroups = new Set();
let disclosureSeeded = false;
const latestDelays = new Map();
const timeoutCounts = new Map();

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function groups() {
  return payload && Array.isArray(payload.groups) ? payload.groups : [];
}

function errorCode(error) {
  return error && error.data && error.data.code ? String(error.data.code) : '';
}

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function notify(message, kind = 'info') {
  try {
    if (window.XKeen?.ui && typeof window.XKeen.ui.toast === 'function') {
      window.XKeen.ui.toast(String(message || ''), kind);
      return;
    }
    if (typeof window.toast === 'function') window.toast(String(message || ''), kind);
  } catch (error) {}
}

function connectionResultCopy(result) {
  const connections = result && result.connections;
  if (!connections || connections.requested !== true) return '';
  const copy = ` Завершено соединений: ${connections.disconnected || 0}`
    + (connections.failed ? `, ошибок: ${connections.failed}` : '')
    + (connections.truncated ? '. Список был ограничен.' : '.');
  return copy;
}

function delayTone(delay) {
  if (!Number.isFinite(delay)) return 'unknown';
  if (delay <= 250) return 'good';
  if (delay <= 650) return 'warning';
  return 'bad';
}

function delayKey(name, provider = '') {
  return `${String(provider || '')}\u0000${String(name || '')}`;
}

function nodeDelayResult(node) {
  const key = delayKey(node.name, node.provider);
  return (delayRun && delayRun.results.get(key)) || latestDelays.get(key);
}

function nodeProbeStatus(node) {
  const result = nodeDelayResult(node);
  if (result?.state === 'pending') {
    return { state: 'pending', label: 'проверка', tooltip: 'Выполняется проверка задержки узла.' };
  }
  if (result?.state === 'timeout') {
    return { state: 'timeout', label: 'таймаут', tooltip: 'Проверка задержки превысила допустимое время ожидания.' };
  }
  if (result?.state === 'failed') {
    return {
      state: 'failed',
      label: 'ошибка',
      tooltip: 'Ручная проверка задержки не вернула пригодный результат. Нажмите, чтобы повторить.',
    };
  }
  if (result?.state === 'cancelled') {
    return { state: 'cancelled', label: 'отменено', tooltip: 'Проверка задержки была отменена.' };
  }
  if (result && Number.isFinite(result.delay)) {
    const delay = result.delay;
    return {
      state: delayTone(delay),
      label: `${delay} мс`,
      tooltip: `Последняя измеренная задержка: ${delay} мс. Нажмите, чтобы проверить снова.`,
    };
  }
  if (node.availability === 'unavailable' || node.alive === false) {
    return {
      state: 'unavailable',
      label: 'недоступен',
      tooltip: 'Последняя фоновая healthcheck Mihomo вернула alive=false. Нажмите, чтобы выполнить ручную проверку задержки.',
    };
  }
  if (Number.isFinite(node.delay_ms)) {
    return {
      state: delayTone(node.delay_ms),
      label: `${node.delay_ms} мс`,
      tooltip: `Последняя измеренная задержка: ${node.delay_ms} мс. Нажмите, чтобы проверить снова.`,
    };
  }
  return {
    state: 'unknown',
    label: '—',
    tooltip: 'Mihomo ещё не сообщил результат healthcheck. Нажмите, чтобы проверить задержку.',
  };
}

function nodeSearchText(node) {
  return [node.name, node.type, node.provider, ...(node.provider_candidates || [])]
    .join(' ')
    .toLocaleLowerCase('ru');
}

function filteredGroups() {
  const query = filterText.trim().toLocaleLowerCase('ru');
  return groups().reduce((result, group) => {
    if (group.hidden && !showHidden) return result;
    const groupMatches = !query || [group.name, group.type, group.now].join(' ').toLocaleLowerCase('ru').includes(query);
    const nodes = Array.isArray(group.nodes)
      ? group.nodes.filter((node) => (
        (showTimeoutHidden || (timeoutCounts.get(delayKey(node.name, node.provider)) || 0) < TIMEOUT_HIDE_THRESHOLD)
        && (groupMatches || nodeSearchText(node).includes(query))
      ))
      : [];
    if (groupMatches || nodes.length) result.push({ ...group, nodes: sortNodes(group, nodes) });
    return result;
  }, []);
}

function nodeDelayValue(node) {
  const result = nodeDelayResult(node);
  return result && Number.isFinite(result.delay) ? result.delay : (Number.isFinite(node.delay_ms) ? node.delay_ms : Number.POSITIVE_INFINITY);
}

function sortNodes(group, nodes) {
  if (sortMode === 'config') return [...nodes];
  const indexed = nodes.map((node, index) => ({ node, index }));
  indexed.sort((left, right) => {
    const leftCurrent = left.node.name === group.now ? 1 : 0;
    const rightCurrent = right.node.name === group.now ? 1 : 0;
    if (leftCurrent !== rightCurrent) return rightCurrent - leftCurrent;
    let comparison = 0;
    if (sortMode === 'name') comparison = String(left.node.name).localeCompare(String(right.node.name), 'ru', { sensitivity: 'base' });
    if (sortMode === 'delay') comparison = nodeDelayValue(left.node) - nodeDelayValue(right.node);
    if (sortMode === 'availability') comparison = Number(right.node.alive === true) - Number(left.node.alive === true);
    return comparison || left.index - right.index;
  });
  return indexed.map((item) => item.node);
}

function providerCopy(node) {
  if (node.provider) return node.provider;
  const candidates = Array.isArray(node.provider_candidates) ? node.provider_candidates : [];
  if (node.provider_ambiguous && candidates.length) return `${candidates.length} providers`;
  return 'local';
}

const NODE_COUNTRY_NAMES = Object.freeze({
  AE: 'United Arab Emirates', AU: 'Australia', BR: 'Brazil', CA: 'Canada', CH: 'Switzerland',
  CN: 'China', CZ: 'Czechia', DE: 'Germany', ES: 'Spain', FI: 'Finland', FR: 'France',
  GB: 'United Kingdom', HK: 'Hong Kong', ID: 'Indonesia', IL: 'Israel', IN: 'India',
  IT: 'Italy', JP: 'Japan', KR: 'South Korea', KZ: 'Kazakhstan', LV: 'Latvia',
  MY: 'Malaysia', NL: 'Netherlands', NO: 'Norway', PL: 'Poland', RU: 'Russia',
  SE: 'Sweden', SG: 'Singapore', TH: 'Thailand', TR: 'Turkey', TW: 'Taiwan',
  UA: 'Ukraine', US: 'United States', VN: 'Vietnam',
});

const NODE_COUNTRY_RULES = Object.freeze([
  [/\b(HONG\s*KONG|HKG)\b/i, 'HK'], [/\b(SINGAPORE)\b/i, 'SG'],
  [/\b(JAPAN|TOKYO|OSAKA)\b/i, 'JP'], [/\b(KOREA|SEOUL)\b/i, 'KR'],
  [/\b(UNITED\s*STATES|USA|NEW\s*YORK|LOS\s*ANGELES|CHICAGO)\b/i, 'US'],
  [/\b(UNITED\s*KINGDOM|GREAT\s*BRITAIN|LONDON)\b/i, 'GB'],
  [/\b(GERMANY|DEUTSCHLAND|BERLIN|FRANKFURT)\b/i, 'DE'],
  [/\b(SWITZERLAND|SWISS|ZURICH|ZÜRICH|GENEVA)\b/i, 'CH'],
  [/\b(CZECHIA|CZECH\s*REPUBLIC|PRAGUE|PRAHA)\b/i, 'CZ'],
  [/\b(LATVIA|RIGA)\b/i, 'LV'], [/\b(SWEDEN|STOCKHOLM)\b/i, 'SE'],
  [/\b(NETHERLANDS|AMSTERDAM|HOLLAND)\b/i, 'NL'], [/\b(FRANCE|PARIS)\b/i, 'FR'],
  [/\b(SPAIN|MADRID)\b/i, 'ES'], [/\b(INDIA|MUMBAI|DELHI)\b/i, 'IN'],
  [/\b(TURKEY|ISTANBUL)\b/i, 'TR'], [/\b(KAZAKHSTAN|ALMATY|ASTANA)\b/i, 'KZ'],
  [/\b(ISRAEL|TEL\s*AVIV)\b/i, 'IL'], [/\b(RUSSIA|MOSCOW|SAINT\s*PETERSBURG)\b/i, 'RU'],
  [/\b(ITALY|MILAN|ROME)\b/i, 'IT'], [/\b(CANADA|TORONTO|MONTREAL)\b/i, 'CA'],
  [/\b(AUSTRALIA|SYDNEY|MELBOURNE)\b/i, 'AU'], [/\b(FINLAND|HELSINKI)\b/i, 'FI'],
  [/\b(NORWAY|OSLO)\b/i, 'NO'], [/\b(POLAND|WARSAW)\b/i, 'PL'],
  [/\b(UKRAINE|KYIV|KIEV)\b/i, 'UA'], [/\b(BRAZIL|SAO\s*PAULO)\b/i, 'BR'],
  [/\b(CHINA|BEIJING|SHANGHAI)\b/i, 'CN'], [/\b(TAIWAN|TAIPEI)\b/i, 'TW'],
  [/\b(VIETNAM|HANOI)\b/i, 'VN'], [/\b(THAILAND|BANGKOK)\b/i, 'TH'],
  [/\b(MALAYSIA|KUALA\s*LUMPUR)\b/i, 'MY'], [/\b(INDONESIA|JAKARTA)\b/i, 'ID'],
  [/\b(UAE|DUBAI|ABU\s*DHABI)\b/i, 'AE'],
]);

function nodeCountryCode(name) {
  const value = String(name || '');
  const indicators = Array.from(value);
  for (let index = 0; index < indicators.length - 1; index += 1) {
    const first = indicators[index].codePointAt(0);
    const second = indicators[index + 1].codePointAt(0);
    if (first >= 0x1F1E6 && first <= 0x1F1FF && second >= 0x1F1E6 && second <= 0x1F1FF) {
      const code = String.fromCharCode(65 + first - 0x1F1E6, 65 + second - 0x1F1E6);
      if (NODE_COUNTRY_NAMES[code]) return code;
    }
  }
  const normalized = value.replace(/[_.\/-]+/g, ' ');
  const token = normalized.match(/^(?:\s*)([A-Z]{2,3})(?=\s|$)/)?.[1];
  const aliases = { UK: 'GB', UAE: 'AE', USA: 'US', SH: 'CH' };
  const tokenCode = aliases[token] || token;
  if (NODE_COUNTRY_NAMES[tokenCode]) return tokenCode;
  return NODE_COUNTRY_RULES.find(([rule]) => rule.test(normalized))?.[1] || '';
}

function nodeDisplayName(node, countryCode) {
  let value = String(node.name || '').trim();
  if (!countryCode) return value;
  // A provider-supplied emoji is replaced by our rectangular flag, rather
  // than being rendered beside it as a duplicate country marker.
  value = value.replace(/^(?:(?:[\u{1F1E6}-\u{1F1FF}]{2})|\uFE0F|\u200D|\s)+/gu, '').trim();
  const aliases = countryCode === 'GB' ? 'GB|UK' : countryCode;
  return value.replace(new RegExp(`^(?:${aliases})(?=$|[\\s._:-])(?:[\\s._:-]+)?`, 'i'), '').trim() || String(node.name || '').trim();
}

function nodeFlagHtml(countryCode) {
  if (!countryCode) return '';
  const label = NODE_COUNTRY_NAMES[countryCode] || countryCode;
  // Mihomo cards share the CSS flag renderer with Xray subscription cards.
  // Keeping the content asset in one place avoids broken inline SVG variants.
  return `<span class="xk-sub-node-country xk-mihomo-node-country" data-country="${countryCode}" role="img" aria-label="${escapeHtml(label)}" data-tooltip="${escapeHtml(label)}"></span>`;
}

function nodeConnectionSummary(node) {
  const endpoint = [node.server, node.port].filter((value) => value !== '' && value != null).join(':');
  const route = [node.path ? `path=${node.path}` : '', node.host ? `host=${node.host}` : ''].filter(Boolean).join(' · ');
  const extra = [node.sni ? `SNI=${node.sni}` : '', node.flow ? `flow=${node.flow}` : ''].filter(Boolean).join(' · ');
  return [endpoint, route, extra].filter(Boolean).join(' · ');
}

function renderNodeProbe(node) {
  const status = nodeProbeStatus(node);
  const probeLabel = `Проверить задержку узла ${node.name}`;
  const probeData = `data-mihomo-node-delay="1" data-node="${escapeHtml(node.name)}" data-provider="${escapeHtml(node.provider || '')}"`;
  const checking = status.state === 'pending';
  const statusIcon = status.state === 'unavailable'
    ? 'server-off'
    : (status.state === 'failed' ? 'alert' : '');
  const content = statusIcon
    ? `<span class="xk-visually-hidden">${escapeHtml(status.label)}</span>${iconHtml(statusIcon)}`
    : escapeHtml(status.label);
  return checking
    ? `<button type="button" class="xk-mihomo-node-probe is-pending" ${probeData}
        aria-label="Проверяем задержку узла ${escapeHtml(node.name)}" aria-busy="true" data-tooltip-silent="1" disabled>${iconHtml('loading')}</button>`
    : `<button type="button" class="xk-mihomo-node-probe xk-mihomo-node-delay" ${probeData}
        data-delay-tone="${escapeHtml(status.state)}" aria-label="${escapeHtml(probeLabel)}: ${escapeHtml(status.label)}"
        data-tooltip="${escapeHtml(status.tooltip)}">${content}</button>`;
}

function renderNode(group, node) {
  const selected = group.now === node.name;
  const fixed = group.fixed === node.name;
  const selectPending = selection && selection.group === group.name && selection.node === node.name;
  const checking = nodeDelayResult(node)?.state === 'pending';
  const selectable = !!group.selectable && SELECTABLE_TYPES.has(String(group.type || '').toLowerCase());
  const alive = nodeDelayResult(node)?.state === 'done' || node.availability === 'available' || node.alive === true
    ? 'доступен'
    : (node.availability === 'unavailable' || node.alive === false ? 'недоступен' : 'нет данных');
  const countryCode = nodeCountryCode(node.name);
  const displayName = nodeDisplayName(node, countryCode);
  const protocol = [node.type || 'unknown', node.network, node.security].filter(Boolean).join(' · ');
  const meta = [protocol, providerCopy(node), node.udp === true ? 'UDP' : ''].filter(Boolean).join(' · ');
  const endpoint = [node.server, node.port].filter((value) => value !== '' && value != null).join(':');
  const connectionSummary = nodeConnectionSummary(node);
  return `
    <li class="xk-mihomo-node-row${selected ? ' is-current' : ''}${fixed ? ' is-fixed' : ''}${checking ? ' is-checking' : ''}" data-node-key="${escapeHtml(encodeURIComponent(delayKey(node.name, node.provider)))}" data-node-name="${escapeHtml(node.name)}" data-alive="${escapeHtml(alive)}">
      <button type="button" class="xk-mihomo-node-select" data-mihomo-group-select="1"
        data-group="${escapeHtml(group.name)}" data-node="${escapeHtml(node.name)}"
        aria-pressed="${selected ? 'true' : 'false'}" ${!selectable || selected || selectPending || selection ? 'disabled' : ''}>
        <span class="xk-mihomo-node-main" ${connectionSummary ? `data-tooltip="${escapeHtml(connectionSummary)}"` : ''}>
          <strong>${fixed ? iconHtml('lock') : ''}${nodeFlagHtml(countryCode)}<span>${escapeHtml(displayName)}</span></strong>
          <small>${escapeHtml(meta)}</small>
          ${endpoint ? `<small class="xk-mihomo-node-endpoint">${escapeHtml(endpoint)}</small>` : ''}
        </span>
      </button>
      ${renderNodeProbe(node)}
    </li>`;
}

function groupSummary(group) {
  const nodes = Array.isArray(group.nodes) ? group.nodes : [];
  const aliveCount = nodes.filter((node) => node.alive === true).length;
  const selectable = !!group.selectable && SELECTABLE_TYPES.has(String(group.type || '').toLowerCase());
  const automatic = AUTOMATIC_TYPES.has(String(group.type || '').toLowerCase());
  const mode = automatic ? (group.fixed ? 'зафиксирован' : 'автоматически') : (selectable ? 'ручной выбор' : 'автоматически');
  return `${group.type || 'Unknown'} · ${mode} · ${aliveCount}/${nodes.length} доступны`;
}

function renderGroup(group) {
  const nodes = Array.isArray(group.nodes) ? group.nodes : [];
  // A search result must never stay hidden inside a previously collapsed group.
  // Keep the persisted disclosure state and only expand matches for the duration
  // of the active filter.
  const collapsed = collapsedGroups.has(group.name) && !filterText.trim();
  const panelId = `mihomo-group-${encodeURIComponent(group.name).replace(/%/g, '-').replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const automatic = AUTOMATIC_TYPES.has(String(group.type || '').toLowerCase());
  const canUnfix = automatic && !!group.fixed && capabilities.proxy_unfix === true;
  const fixedLabel = automatic && group.fixed
    ? `<span class="xk-mihomo-group-fixed">${iconHtml('lock')}Зафиксирован: <strong>${escapeHtml(group.fixed)}</strong></span>`
    : '';
  return `
    <section class="xk-mihomo-group" data-group-name="${escapeHtml(group.name)}">
      <header class="xk-mihomo-group-head${collapsed ? ' is-collapsed' : ''}">
        <button type="button" class="xk-mihomo-group-toggle" data-mihomo-group-toggle="1"
          data-group="${escapeHtml(group.name)}" aria-expanded="${collapsed ? 'false' : 'true'}" aria-controls="${panelId}">
          ${iconHtml('chevron-down')}
          <span class="xk-visually-hidden">${collapsed ? 'Развернуть' : 'Свернуть'} группу ${escapeHtml(group.name)}</span>
        </button>
        <div class="xk-mihomo-group-title">
          <div><strong>${escapeHtml(group.name)}</strong>${group.hidden ? '<span class="xk-mihomo-group-flag">hidden</span>' : ''}</div>
          <small>${escapeHtml(groupSummary(group))}</small>
          ${fixedLabel}
        </div>
        <div class="xk-mihomo-group-actions">
          ${canUnfix ? `<button type="button" class="btn-secondary xk-mihomo-group-unfix" data-mihomo-group-unfix="1" data-group="${escapeHtml(group.name)}">${iconHtml('lock')}<span>Вернуть автоматический выбор</span></button>` : ''}
          ${collapsed ? '' : `<button type="button" class="btn-secondary xk-mihomo-group-test" data-mihomo-group-delay="1"
            data-group="${escapeHtml(group.name)}">${iconHtml('ping')}<span class="xk-action-label">Тест группы</span></button>`}
        </div>
      </header>
      <div id="${panelId}" class="xk-mihomo-group-body" ${collapsed ? 'hidden' : ''}>
        <ul class="xk-mihomo-node-list" aria-label="Узлы группы ${escapeHtml(group.name)}">
          ${nodes.length ? nodes.map((node) => renderNode(group, node)).join('') : '<li class="xk-mihomo-groups-empty">Нет узлов по текущему фильтру.</li>'}
        </ul>
      </div>
    </section>`;
}

function render() {
  if (!root) return;
  const list = document.getElementById('mihomo-clash-groups-list');
  const count = document.getElementById('mihomo-clash-groups-count');
  const hiddenToggle = document.getElementById('mihomo-clash-show-hidden');
  const collapseButton = document.getElementById('mihomo-clash-groups-collapse');
  const timeoutButton = document.getElementById('mihomo-clash-show-timeout-hidden');
  if (!list) return;
  const visibleGroups = filteredGroups();
  const visibleNodes = visibleGroups.reduce((sum, group) => sum + (group.nodes || []).length, 0);
  const visibleExpandedNodes = visibleGroups.reduce(
    (sum, group) => sum + (collapsedGroups.has(group.name) && !filterText.trim() ? 0 : (group.nodes || []).length),
    0,
  );
  if (count) count.textContent = `${visibleGroups.length} групп · ${visibleNodes} узлов`;
  if (hiddenToggle) hiddenToggle.checked = showHidden;
  const hiddenTimeoutCount = new Set(
    groups().flatMap((group) => group.nodes || [])
      .map((node) => delayKey(node.name, node.provider))
      .filter((key) => (timeoutCounts.get(key) || 0) >= TIMEOUT_HIDE_THRESHOLD),
  ).size;
  if (timeoutButton) {
    timeoutButton.hidden = hiddenTimeoutCount === 0;
    timeoutButton.setAttribute('aria-pressed', showTimeoutHidden ? 'true' : 'false');
    const value = timeoutButton.querySelector('span');
    if (value) value.textContent = String(hiddenTimeoutCount);
  }
  if (collapseButton) {
    const allCollapsed = visibleGroups.length > 0 && visibleGroups.every((group) => collapsedGroups.has(group.name));
    collapseButton.dataset.mode = allCollapsed ? 'expand' : 'collapse';
    collapseButton.setAttribute('aria-label', allCollapsed ? 'Развернуть все группы' : 'Свернуть все группы');
    const label = collapseButton.querySelector('span:not(.xk-action-icon)');
    if (label) label.textContent = allCollapsed ? 'Развернуть' : 'Свернуть';
  }
  list.innerHTML = visibleGroups.length
    ? visibleGroups.map(renderGroup).join('')
    : '<div class="xk-mihomo-groups-empty">Группы или узлы по текущему фильтру не найдены.</div>';
  syncDelayControls(visibleExpandedNodes);
}

function setDelayActionTesting(button, testing, progress = null) {
  if (!button) return;
  button.disabled = testing;
  button.setAttribute('aria-busy', testing ? 'true' : 'false');
  button.dataset.mihomoDelayTesting = testing ? 'true' : 'false';
  const label = button.querySelector('.xk-action-label');
  if (label) {
    if (!label.dataset.defaultLabel) label.dataset.defaultLabel = String(label.textContent || '').trim();
    label.textContent = testing && progress
      ? `Проверка ${Math.min(progress.completed, progress.total)}/${progress.total}`
      : label.dataset.defaultLabel;
  }
  const existing = button.querySelector('.xk-mihomo-delay-spinner');
  if (testing && !existing) {
    const spinner = document.createElement('span');
    spinner.className = 'xk-mihomo-delay-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    button.prepend(spinner);
  } else if (!testing && existing) {
    existing.remove();
  }
}

function syncDelayControls(visibleExpandedNodes) {
  const runButton = document.getElementById('mihomo-clash-test-visible');
  const visibleCount = Number.isFinite(visibleExpandedNodes)
    ? visibleExpandedNodes
    : filteredGroups().reduce(
      (sum, group) => sum + (collapsedGroups.has(group.name) && !filterText.trim() ? 0 : (group.nodes || []).length),
      0,
    );
  const busy = !!delayRun;
  const source = delayRun?.source || {};
  if (runButton) {
    const testing = busy && source.type === 'visible';
    setDelayActionTesting(runButton, testing, delayRun);
    runButton.disabled = testing || !visibleCount;
  }
  if (!root) return;
  // The backend queue rejects an overlapping request. Keep unrelated controls
  // unchanged, so the only altered button is the action actually in progress.
  root.querySelectorAll('[data-mihomo-group-delay]').forEach((button) => {
    const testing = busy
      && source.type === 'group'
      && source.group === String(button.dataset.group || '');
    setDelayActionTesting(button, testing, delayRun);
  });
}

function renderDelayNodes(keys) {
  if (!root) return;
  const keySet = new Set(keys || []);
  if (!keySet.size) return;
  const cards = new Map();
  root.querySelectorAll('[data-node-key]').forEach((card) => {
    const key = card.dataset.nodeKey;
    if (!key) return;
    const matches = cards.get(key) || [];
    matches.push(card);
    cards.set(key, matches);
  });
  for (const group of filteredGroups()) {
    for (const node of group.nodes || []) {
      const nodeKey = delayKey(node.name, node.provider);
      if (!keySet.has(nodeKey)) continue;
      const matchingCards = cards.get(encodeURIComponent(nodeKey)) || [];
      for (const card of matchingCards) {
        const probe = card.querySelector('.xk-mihomo-node-probe');
        if (!probe) continue;
        probe.outerHTML = renderNodeProbe(node);
        card.classList.toggle('is-checking', nodeDelayResult(node)?.state === 'pending');
      }
    }
  }
}

function abortLoad() {
  requestSequence += 1;
  if (request) request.abort();
  request = null;
}

export async function refreshMihomoClashGroups() {
  if (!active) return false;
  abortLoad();
  const sequence = ++requestSequence;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  request = controller;
  root?.setAttribute('aria-busy', 'true');
  try {
    const next = await fetchMihomoClashGroups({ signal: controller?.signal });
    if (!active || sequence !== requestSequence) return false;
    payload = next && typeof next === 'object' ? next : { groups: [] };
    if (!disclosureSeeded) {
      for (const group of groups()) collapsedGroups.add(group.name);
      disclosureSeeded = true;
    }
    render();
    return true;
  } catch (error) {
    if (controller?.signal.aborted || sequence !== requestSequence) return false;
    return false;
  } finally {
    if (sequence === requestSequence) request = null;
    root?.setAttribute('aria-busy', 'false');
  }
}

function replaceGroup(group) {
  if (!payload || !Array.isArray(payload.groups) || !group || !group.name) return;
  payload.groups = payload.groups.map((item) => item.name === group.name ? { ...item, ...group } : item);
}

async function selectProxy(group, node) {
  if (!active || selection || delayRun) return;
  const previous = groups().find((item) => item.name === group);
  if (!previous || previous.now === node) return;
  const disconnectAffected = document.getElementById('mihomo-clash-disconnect-after-select')?.checked === true;
  const accepted = await confirmMihomoAction({
    title: `Переключить группу «${group}»?`,
    message: disconnectAffected
      ? `Выбрать «${node}» и после успешного переключения завершить только соединения, затронутые группой «${group}»?`
      : `Выбрать «${node}» для группы «${group}»? Текущие соединения продолжат работу.`,
    okText: 'Переключить',
    cancelText: 'Отменить',
    danger: disconnectAffected,
  }, `Переключить ${group} на ${node}?`);
  if (!accepted || !active) return;
  selection = { group, node };
  render();
  try {
    const result = await selectMihomoClashProxy(group, node, { disconnectAffected });
    if (!active) return;
    if (result && result.group) replaceGroup(result.group);
    render();
    notify(`Группа «${group}» переключена на «${node}».${connectionResultCopy(result)}`, 'success');
    if (!result || !result.reconciled) await refreshMihomoClashGroups();
  } catch (error) {
    const stale = error && error.data && error.data.code === 'proxy_selection_not_available';
    if (stale) await refreshMihomoClashGroups();
    notify(error?.message || 'Не удалось переключить группу Mihomo.', 'error');
  } finally {
    selection = null;
    render();
  }
}

async function unfixProxy(groupName) {
  if (!active || selection || delayRun || capabilities.proxy_unfix !== true) return;
  const group = groups().find((item) => item.name === groupName);
  if (!group?.fixed || !AUTOMATIC_TYPES.has(String(group.type || '').toLowerCase())) return;
  const disconnectAffected = document.getElementById('mihomo-clash-disconnect-after-select')?.checked === true;
  const accepted = await confirmMihomoAction({
    title: 'Вернуть автоматический выбор?',
    message: disconnectAffected
      ? `Снять фиксацию «${group.fixed}» в группе «${group.name}» и завершить затронутые соединения после успешного изменения?`
      : `Снять фиксацию «${group.fixed}» в группе «${group.name}»? Mihomo снова будет выбирать узел автоматически.`,
    okText: 'Вернуть автоматический выбор',
    cancelText: 'Отменить',
    danger: disconnectAffected,
  }, `Снять фиксацию группы ${group.name}?`);
  if (!accepted || !active) return;
  selection = { group: group.name, node: group.fixed, unfix: true };
  render();
  try {
    const result = await unfixMihomoClashProxy(group.name, { disconnectAffected });
    if (!active) return;
    if (result?.group) replaceGroup(result.group);
    render();
    notify(`Для группы «${group.name}» возвращён автоматический выбор.${connectionResultCopy(result)}`, 'success');
    if (!result?.reconciled) await refreshMihomoClashGroups();
  } catch (error) {
    if (errorCode(error) === 'proxy_unfix_not_available') await refreshMihomoClashGroups();
    notify(error?.message || 'Не удалось вернуть автоматический выбор.', 'error');
  } finally {
    selection = null;
    render();
  }
}

function delayKeysForProbe(scope, name, provider = '') {
  if (scope !== 'group') return [delayKey(name, provider)];
  const group = groups().find((item) => item.name === name);
  return group && Array.isArray(group.nodes)
    ? group.nodes.map((node) => delayKey(node.name, node.provider))
    : [];
}

function applyDelayResults(results, provider = '', groupName = '') {
  if (!delayRun) return;
  for (const item of Array.isArray(results) ? results : []) {
    if (!item || !item.name || !Number.isFinite(item.delay_ms)) continue;
    const group = groupName ? groups().find((candidate) => candidate.name === groupName) : null;
    const matchingNodes = group && Array.isArray(group.nodes)
      ? group.nodes.filter((node) => node.name === item.name)
      : [];
    const keys = matchingNodes.length
      ? matchingNodes.map((node) => delayKey(node.name, node.provider))
      : [delayKey(item.name, provider)];
    for (const key of keys) {
      delayRun.results.set(key, { state: 'done', delay: Number(item.delay_ms) });
    }
  }
}

async function probeDelay(scope, name, provider = '') {
  if (!delayRun || delayRun.cancelled) return;
  const keys = delayKeysForProbe(scope, name, provider);
  for (const key of keys) delayRun.results.set(key, { state: 'pending' });
  try {
    let result = null;
    let busyRetries = 0;
    while (delayRun && !delayRun.cancelled) {
      try {
        result = await testMihomoClashDelay(scope, name, { provider, signal: delayRun.controller?.signal });
        break;
      } catch (error) {
        if (errorCode(error) !== 'action_busy' || busyRetries >= MAX_BUSY_RETRIES) throw error;
        busyRetries += 1;
        await wait(150 + (busyRetries * 35));
      }
    }
    if (!delayRun || delayRun.cancelled) return;
    applyDelayResults(result && result.results, provider, scope === 'group' ? name : '');
    for (const key of keys) {
      if (!delayRun.results.has(key) || delayRun.results.get(key).state === 'pending') {
        delayRun.results.set(key, { state: 'failed' });
      } else if (delayRun.results.get(key).state === 'done') {
        timeoutCounts.delete(key);
      }
    }
  } catch (error) {
    if (!delayRun || delayRun.cancelled) return;
    const timedOut = error && (
      error.code === 'timeout'
      || error.name === 'TimeoutError'
      || error.isTimeout === true
      || (error.data && error.data.code === 'upstream_timeout')
    );
    for (const key of keys) {
      delayRun.results.set(key, { state: timedOut ? 'timeout' : 'failed' });
      if (timedOut) timeoutCounts.set(key, Math.min(TIMEOUT_HIDE_THRESHOLD, (timeoutCounts.get(key) || 0) + 1));
      else timeoutCounts.delete(key);
    }
  } finally {
    if (delayRun) delayRun.completed += 1;
    if (!showTimeoutHidden && keys.some((key) => (timeoutCounts.get(key) || 0) >= TIMEOUT_HIDE_THRESHOLD)) render();
    else renderDelayNodes(keys);
    syncDelayControls();
  }
}

async function runDelayQueue(items, source = {}) {
  if (!active || delayRun || !items.length) return;
  const queueItems = [...items];
  delayRun = {
    controller: typeof AbortController === 'function' ? new AbortController() : null,
    results: new Map(),
    source,
    total: queueItems.length,
    completed: 0,
    cancelled: false,
  };
  for (const item of queueItems) {
    for (const key of delayKeysForProbe(item.scope, item.name, item.provider)) {
      delayRun.results.set(key, { state: 'pending' });
    }
  }
  const affectedKeys = [...delayRun.results.keys()];
  renderDelayNodes(affectedKeys);
  syncDelayControls();
  let cursor = 0;
  const worker = async () => {
    while (delayRun && !delayRun.cancelled && cursor < queueItems.length) {
      const item = queueItems[cursor++];
      await probeDelay(item.scope, item.name, item.provider);
      if (delayRun && !delayRun.cancelled && cursor < queueItems.length) {
        await wait(DELAY_BATCH_CADENCE_MS);
      }
    }
  };
  const workers = Array.from({ length: Math.min(MAX_DELAY_CONCURRENCY, queueItems.length) }, worker);
  for (const workerPromise of workers) await workerPromise;
  if (!delayRun) return;
  const finished = delayRun;
  for (const [key, value] of finished.results) latestDelays.set(key, value);
  delayRun = null;
  renderDelayNodes([...finished.results.keys()]);
  syncDelayControls();
}

function cancelDelayQueue() {
  if (!delayRun) return;
  delayRun.cancelled = true;
  delayRun.controller?.abort();
  for (const [name, result] of delayRun.results) {
    if (result.state === 'pending') delayRun.results.set(name, { state: 'cancelled' });
  }
}

function nodeQueue(nodes) {
  const names = new Set();
  const items = [];
  for (const node of nodes || []) {
    const key = delayKey(node.name, node.provider);
    if (names.has(key)) continue;
    names.add(key);
    items.push(node.provider
      ? { scope: 'provider-proxy', name: node.name, provider: node.provider }
      : { scope: 'proxy', name: node.name });
  }
  return items;
}

function visibleNodeQueue() {
  return nodeQueue(filteredGroups().flatMap((group) => (
    collapsedGroups.has(group.name) && !filterText.trim() ? [] : (group.nodes || [])
  )));
}

function groupNodeQueue(name) {
  const group = groups().find((item) => item.name === name);
  return nodeQueue(group?.nodes || []);
}

function bind() {
  if (!root || root.dataset.bound === '1') return;
  root.dataset.bound = '1';
  root.addEventListener('input', (event) => {
    if (event.target?.id !== 'mihomo-clash-groups-filter') return;
    filterText = String(event.target.value || '');
    render();
  });
  root.addEventListener('change', (event) => {
    if (event.target?.id === 'mihomo-clash-groups-sort') {
      sortMode = String(event.target.value || 'config');
      render();
      return;
    }
    if (event.target?.id !== 'mihomo-clash-show-hidden') return;
    showHidden = !!event.target.checked;
    if (showHidden) {
      for (const group of groups()) {
        if (group.hidden) collapsedGroups.add(group.name);
      }
    }
    render();
  });
  root.addEventListener('click', (event) => {
    const target = event.target?.closest?.('[data-mihomo-groups-collapse], [data-mihomo-group-toggle], [data-mihomo-group-select], [data-mihomo-group-unfix], [data-mihomo-node-delay], [data-mihomo-group-delay], [data-mihomo-delay-visible], #mihomo-clash-show-timeout-hidden');
    if (!target) return;
    if (target.hasAttribute('data-mihomo-groups-collapse')) {
      const visibleGroups = filteredGroups();
      const shouldExpand = target.dataset.mode === 'expand';
      for (const group of visibleGroups) {
        if (shouldExpand) collapsedGroups.delete(group.name);
        else collapsedGroups.add(group.name);
      }
      render();
    }
    if (target.hasAttribute('data-mihomo-group-toggle')) {
      const name = String(target.dataset.group || '');
      if (collapsedGroups.has(name)) collapsedGroups.delete(name);
      else collapsedGroups.add(name);
      render();
    }
    if (target.hasAttribute('data-mihomo-group-select')) void selectProxy(target.dataset.group, target.dataset.node);
    if (target.hasAttribute('data-mihomo-group-unfix')) void unfixProxy(target.dataset.group);
    if (target.id === 'mihomo-clash-show-timeout-hidden') { showTimeoutHidden = !showTimeoutHidden; render(); }
    if (target.hasAttribute('data-mihomo-node-delay')) {
      const provider = String(target.dataset.provider || '');
      void runDelayQueue([provider
        ? { scope: 'provider-proxy', name: target.dataset.node, provider }
        : { scope: 'proxy', name: target.dataset.node }], {
        type: 'node',
        node: String(target.dataset.node || ''),
        provider,
      });
    }
    if (target.hasAttribute('data-mihomo-group-delay')) {
      void runDelayQueue(groupNodeQueue(target.dataset.group), {
        type: 'group',
        group: String(target.dataset.group || ''),
      });
    }
    if (target.hasAttribute('data-mihomo-delay-visible')) void runDelayQueue(visibleNodeQueue(), { type: 'visible' });
  });
}

export function initMihomoClashGroups() {
  if (root) return true;
  root = document.getElementById('mihomo-clash-groups');
  if (!root) return false;
  bind();
  render();
  return true;
}

export function activateMihomoClashGroups(nextCapabilities = {}) {
  if (!initMihomoClashGroups()) return false;
  active = true;
  capabilities = nextCapabilities || {};
  if (!payload) void refreshMihomoClashGroups();
  return true;
}

export function deactivateMihomoClashGroups() {
  active = false;
  abortLoad();
  cancelDelayQueue();
  delayRun = null;
  selection = null;
  render();
}

export function invalidateMihomoClashGroups() {
  payload = null;
}

export const mihomoClashGroupsApi = Object.freeze({
  init: initMihomoClashGroups,
  activate: activateMihomoClashGroups,
  deactivate: deactivateMihomoClashGroups,
  invalidate: invalidateMihomoClashGroups,
  refresh: refreshMihomoClashGroups,
});
