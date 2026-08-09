import { iconHtml } from '../../ui/operator_icons.js';
import {
  fetchMihomoClashGroups,
  selectMihomoClashProxy,
  testMihomoClashDelay,
} from './client.js';

const SELECTABLE_TYPES = new Set(['selector', 'select', 'urltest', 'fallback', 'smart']);
// Keep a bounded browser queue. The backend guard intentionally serializes
// each authenticated subject, so workers retry short `action_busy` responses.
const MAX_DELAY_CONCURRENCY = 3;
const MAX_BUSY_RETRIES = 20;

let root = null;
let active = false;
let payload = null;
let filterText = '';
let showHidden = false;
let request = null;
let requestSequence = 0;
let selection = null;
let delayRun = null;
const collapsedGroups = new Set();
let disclosureSeeded = false;
const latestDelays = new Map();
let messageTimer = 0;

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

function errorCopy(error, fallback) {
  const data = error && error.data && typeof error.data === 'object' ? error.data : null;
  const code = data && data.code ? String(data.code) : '';
  if (code === 'action_busy') return 'Другая операция ещё выполняется. Повторите через секунду.';
  if (code === 'action_rate_limited') return 'Лимит проверок исчерпан. Подождите и повторите.';
  if (code === 'proxy_selection_not_available') return 'Группа или узел уже изменились. Данные обновлены.';
  if (code === 'upstream_timeout') return 'Mihomo не ответил вовремя.';
  return fallback;
}

function errorCode(error) {
  return error && error.data && error.data.code ? String(error.data.code) : '';
}

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function setMessage(text, tone = 'neutral', sticky = false) {
  const node = document.getElementById('mihomo-clash-groups-message');
  if (!node) return;
  window.clearTimeout(messageTimer);
  node.textContent = String(text || '');
  node.dataset.tone = tone;
  node.hidden = !text;
  if (text && !sticky) {
    messageTimer = window.setTimeout(() => {
      node.hidden = true;
      node.textContent = '';
    }, 5000);
  }
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

function delayCopy(node) {
  const runValue = nodeDelayResult(node);
  if (runValue && runValue.state === 'pending') return 'проверка';
  if (runValue && runValue.state === 'timeout') return 'таймаут';
  if (runValue && runValue.state === 'failed') return 'ошибка';
  if (runValue && runValue.state === 'cancelled') return 'отменено';
  const delay = runValue && Number.isFinite(runValue.delay) ? runValue.delay : node.delay_ms;
  return Number.isFinite(delay) ? `${delay} мс` : '—';
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
      ? group.nodes.filter((node) => groupMatches || nodeSearchText(node).includes(query))
      : [];
    if (groupMatches || nodes.length) result.push({ ...group, nodes });
    return result;
  }, []);
}

function providerCopy(node) {
  if (node.provider) return node.provider;
  const candidates = Array.isArray(node.provider_candidates) ? node.provider_candidates : [];
  if (node.provider_ambiguous && candidates.length) return `${candidates.length} providers`;
  return 'local';
}

function renderNode(group, node) {
  const selected = group.now === node.name;
  const selectPending = selection && selection.group === group.name && selection.node === node.name;
  const runValue = nodeDelayResult(node);
  const delay = runValue && Number.isFinite(runValue.delay) ? runValue.delay : node.delay_ms;
  const tone = runValue && runValue.state !== 'done' ? runValue.state : delayTone(delay);
  const selectable = !!group.selectable && SELECTABLE_TYPES.has(String(group.type || '').toLowerCase());
  const alive = node.alive === true ? 'доступен' : (node.alive === false ? 'недоступен' : 'нет данных');
  const aliveTone = node.alive === true ? 'positive' : (node.alive === false ? 'danger' : 'neutral');
  const meta = [node.type || 'unknown', providerCopy(node), node.udp === true ? 'UDP' : ''].filter(Boolean).join(' · ');
  return `
    <li class="xk-mihomo-node-row${selected ? ' is-current' : ''}" data-node-name="${escapeHtml(node.name)}">
      <button type="button" class="xk-mihomo-node-select" data-mihomo-group-select="1"
        data-group="${escapeHtml(group.name)}" data-node="${escapeHtml(node.name)}"
        aria-pressed="${selected ? 'true' : 'false'}" ${!selectable || selected || selectPending || selection ? 'disabled' : ''}
        title="${selectable ? `Выбрать ${escapeHtml(node.name)}` : 'Эта группа управляется автоматически'}">
        <span class="xk-mihomo-node-marker" aria-hidden="true"></span>
        <span class="xk-mihomo-node-main">
          <strong title="${escapeHtml(node.name)}">${escapeHtml(node.name)}</strong>
          <small title="${escapeHtml(meta)}">${escapeHtml(meta)}</small>
        </span>
      </button>
      <span class="xk-mihomo-node-alive" data-tone="${aliveTone}"><span aria-hidden="true"></span>${alive}</span>
      <span class="xk-mihomo-node-delay" data-delay-tone="${tone}">${escapeHtml(delayCopy(node))}</span>
      <button type="button" class="btn-secondary btn-icon xk-mihomo-node-test" data-mihomo-node-delay="1"
        data-node="${escapeHtml(node.name)}" data-provider="${escapeHtml(node.provider || '')}" aria-label="Проверить задержку узла ${escapeHtml(node.name)}"
        title="Проверить задержку" ${delayRun ? 'disabled' : ''}>${iconHtml('ping')}</button>
    </li>`;
}

function groupSummary(group) {
  const nodes = Array.isArray(group.nodes) ? group.nodes : [];
  const aliveCount = nodes.filter((node) => node.alive === true).length;
  const selectable = !!group.selectable && SELECTABLE_TYPES.has(String(group.type || '').toLowerCase());
  const mode = selectable ? 'ручной выбор' : 'автоматически';
  return `${group.type || 'Unknown'} · ${mode} · ${aliveCount}/${nodes.length} доступны`;
}

function renderGroup(group) {
  const nodes = Array.isArray(group.nodes) ? group.nodes : [];
  // A search result must never stay hidden inside a previously collapsed group.
  // Keep the persisted disclosure state and only expand matches for the duration
  // of the active filter.
  const collapsed = collapsedGroups.has(group.name) && !filterText.trim();
  const panelId = `mihomo-group-${encodeURIComponent(group.name).replace(/%/g, '-').replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  return `
    <section class="xk-mihomo-group" data-group-name="${escapeHtml(group.name)}">
      <header class="xk-mihomo-group-head${collapsed ? ' is-collapsed' : ''}">
        <button type="button" class="xk-mihomo-group-toggle" data-mihomo-group-toggle="1"
          data-group="${escapeHtml(group.name)}" aria-expanded="${collapsed ? 'false' : 'true'}" aria-controls="${panelId}">
          ${iconHtml('chevron-down')}
          <span class="xk-visually-hidden">${collapsed ? 'Развернуть' : 'Свернуть'} группу ${escapeHtml(group.name)}</span>
        </button>
        <div class="xk-mihomo-group-title">
          <div><strong title="${escapeHtml(group.name)}">${escapeHtml(group.name)}</strong>${group.hidden ? '<span class="xk-mihomo-group-flag">hidden</span>' : ''}</div>
          <small>${escapeHtml(groupSummary(group))}</small>
        </div>
        <div class="xk-mihomo-group-current"><span>Сейчас</span><strong title="${escapeHtml(group.now || '—')}">${escapeHtml(group.now || '—')}</strong></div>
        <button type="button" class="btn-secondary xk-mihomo-group-test" data-mihomo-group-delay="1"
          data-group="${escapeHtml(group.name)}" ${delayRun ? 'disabled' : ''}>${iconHtml('ping')}<span>Тест группы</span></button>
      </header>
      <div id="${panelId}" class="xk-mihomo-group-body" ${collapsed ? 'hidden' : ''}>
        <div class="xk-mihomo-node-head" aria-hidden="true"><span>Узел / provider</span><span>Состояние</span><span>Задержка</span><span></span></div>
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
  const runButton = document.getElementById('mihomo-clash-test-visible');
  const cancelButton = document.getElementById('mihomo-clash-delay-cancel');
  const progress = document.getElementById('mihomo-clash-delay-progress');
  const collapseButton = document.getElementById('mihomo-clash-groups-collapse');
  if (!list) return;
  const visibleGroups = filteredGroups();
  const visibleNodes = visibleGroups.reduce((sum, group) => sum + (group.nodes || []).length, 0);
  const visibleExpandedNodes = visibleGroups.reduce(
    (sum, group) => sum + (collapsedGroups.has(group.name) && !filterText.trim() ? 0 : (group.nodes || []).length),
    0,
  );
  if (count) count.textContent = `${visibleGroups.length} групп · ${visibleNodes} узлов`;
  if (hiddenToggle) hiddenToggle.checked = showHidden;
  if (runButton) runButton.disabled = !!delayRun || !visibleExpandedNodes;
  if (collapseButton) {
    const allCollapsed = visibleGroups.length > 0 && visibleGroups.every((group) => collapsedGroups.has(group.name));
    collapseButton.dataset.mode = allCollapsed ? 'expand' : 'collapse';
    collapseButton.setAttribute('aria-label', allCollapsed ? 'Развернуть все группы' : 'Свернуть все группы');
    const label = collapseButton.querySelector('span:not(.xk-action-icon)');
    if (label) label.textContent = allCollapsed ? 'Развернуть' : 'Свернуть';
  }
  if (cancelButton) cancelButton.hidden = !delayRun;
  if (progress) {
    progress.hidden = !delayRun;
    progress.textContent = delayRun ? `${delayRun.completed}/${delayRun.total}` : '';
  }
  list.innerHTML = visibleGroups.length
    ? visibleGroups.map(renderGroup).join('')
    : '<div class="xk-mihomo-groups-empty">Группы или узлы по текущему фильтру не найдены.</div>';
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
  setMessage('Обновляем группы и providers…', 'neutral', true);
  try {
    const next = await fetchMihomoClashGroups({ signal: controller?.signal });
    if (!active || sequence !== requestSequence) return false;
    payload = next && typeof next === 'object' ? next : { groups: [] };
    if (!disclosureSeeded) {
      for (const group of groups()) collapsedGroups.add(group.name);
      disclosureSeeded = true;
    }
    render();
    setMessage(groups().length ? 'Данные Mihomo обновлены.' : 'Mihomo не вернул рабочих групп.', groups().length ? 'positive' : 'warning');
    return true;
  } catch (error) {
    if (controller?.signal.aborted || sequence !== requestSequence) return false;
    setMessage(errorCopy(error, 'Не удалось загрузить группы Mihomo.'), 'danger', true);
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
  selection = { group, node };
  render();
  setMessage(`Переключаем группу «${group}»…`, 'neutral', true);
  try {
    const result = await selectMihomoClashProxy(group, node);
    if (!active) return;
    if (result && result.group) replaceGroup(result.group);
    render();
    setMessage(result && result.reconciled ? `Mihomo подтвердил выбор «${node}».` : 'Выбор отправлен, выполняем сверку.', result && result.reconciled ? 'positive' : 'warning');
    if (!result || !result.reconciled) await refreshMihomoClashGroups();
  } catch (error) {
    const stale = error && error.data && error.data.code === 'proxy_selection_not_available';
    setMessage(errorCopy(error, 'Не удалось переключить узел. Предыдущее состояние сохранено.'), 'danger', true);
    if (stale) await refreshMihomoClashGroups();
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
  render();
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
    }
  } finally {
    if (delayRun) delayRun.completed += 1;
    render();
  }
}

async function runDelayQueue(items) {
  if (!active || delayRun || !items.length) return;
  delayRun = {
    controller: typeof AbortController === 'function' ? new AbortController() : null,
    results: new Map(),
    total: items.length,
    completed: 0,
    cancelled: false,
  };
  render();
  setMessage(`Проверяем задержку: 0/${items.length}.`, 'neutral', true);
  let cursor = 0;
  const worker = async () => {
    while (delayRun && !delayRun.cancelled && cursor < items.length) {
      const item = items[cursor++];
      await probeDelay(item.scope, item.name, item.provider);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_DELAY_CONCURRENCY, items.length) }, worker));
  if (!delayRun) return;
  const finished = delayRun;
  for (const [key, value] of finished.results) latestDelays.set(key, value);
  const successes = [...finished.results.values()].filter((item) => item.state === 'done').length;
  const failures = [...finished.results.values()].filter((item) => item.state === 'failed' || item.state === 'timeout').length;
  delayRun = null;
  render();
  setMessage(finished.cancelled ? 'Очередь проверки остановлена.' : `Проверка завершена: ${successes} успешно, ${failures} с ошибкой.`, finished.cancelled || failures ? 'warning' : 'positive');
}

function cancelDelayQueue() {
  if (!delayRun) return;
  delayRun.cancelled = true;
  delayRun.controller?.abort();
  for (const [name, result] of delayRun.results) {
    if (result.state === 'pending') delayRun.results.set(name, { state: 'cancelled' });
  }
}

function visibleNodeQueue() {
  const names = new Set();
  const items = [];
  for (const group of filteredGroups()) {
    if (collapsedGroups.has(group.name) && !filterText.trim()) continue;
    for (const node of group.nodes || []) {
      const key = delayKey(node.name, node.provider);
      if (names.has(key)) continue;
      names.add(key);
      items.push(node.provider
        ? { scope: 'provider-proxy', name: node.name, provider: node.provider }
        : { scope: 'proxy', name: node.name });
    }
  }
  return items;
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
    const target = event.target?.closest?.('[data-mihomo-groups-refresh], [data-mihomo-groups-collapse], [data-mihomo-group-toggle], [data-mihomo-group-select], [data-mihomo-node-delay], [data-mihomo-group-delay], [data-mihomo-delay-visible], [data-mihomo-delay-cancel]');
    if (!target) return;
    if (target.hasAttribute('data-mihomo-groups-refresh')) void refreshMihomoClashGroups();
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
    if (target.hasAttribute('data-mihomo-node-delay')) {
      const provider = String(target.dataset.provider || '');
      void runDelayQueue([provider
        ? { scope: 'provider-proxy', name: target.dataset.node, provider }
        : { scope: 'proxy', name: target.dataset.node }]);
    }
    if (target.hasAttribute('data-mihomo-group-delay')) void runDelayQueue([{ scope: 'group', name: target.dataset.group }]);
    if (target.hasAttribute('data-mihomo-delay-visible')) void runDelayQueue(visibleNodeQueue());
    if (target.hasAttribute('data-mihomo-delay-cancel')) cancelDelayQueue();
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

export function activateMihomoClashGroups() {
  if (!initMihomoClashGroups()) return false;
  active = true;
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

export const mihomoClashGroupsApi = Object.freeze({
  init: initMihomoClashGroups,
  activate: activateMihomoClashGroups,
  deactivate: deactivateMihomoClashGroups,
  refresh: refreshMihomoClashGroups,
});
