import { iconHtml } from '../ui/operator_icons.js';

const $ = (id) => document.getElementById(id);

function responsiveLabel(control, full, compact) {
  control.setAttribute('aria-label', full);
  for (const [className, label] of [['xk-provider-check-label-full', full], ['xk-provider-check-label-compact', compact]]) {
    const span = document.createElement('span');
    span.className = className;
    span.textContent = label;
    control.append(span);
  }
}

async function api(url, payload, signal) {
  const response = await fetch(url, {
    method: payload == null ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: payload == null ? {} : {
      'Content-Type': 'application/json',
      'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]')?.content || '',
    },
    body: payload == null ? undefined : JSON.stringify(payload),
    signal,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

const LABELS = {
  reachable: 'TCP доступен', tls_error: 'TCP доступен · TLS ошибка', timeout: 'Таймаут',
  refused: 'Отказ соединения', unreachable: 'Нет соединения', dns_error: 'Ошибка DNS',
  udp_unknown: 'UDP не подтверждён', busy: 'Занято', probe_error: 'Проверка не выполнена',
};

function appendFact(list, label, value) {
  const term = document.createElement('dt');
  term.textContent = label;
  const description = document.createElement('dd');
  description.textContent = value;
  list.append(term, description);
}

function paintPublicLists(output, result) {
  output.replaceChildren();
  if (result.status !== 'ok') {
    output.textContent = result.message || 'Проверка по спискам не выполнена.';
    return;
  }
  const verdict = document.createElement('strong');
  verdict.className = result.listed ? 'is-listed' : 'is-clear';
  verdict.textContent = result.listed ? 'Есть совпадение в списках' : 'Совпадений в списках не найдено';
  const facts = document.createElement('dl');
  appendFact(facts, 'Реестр', [result.registry_domain, ...(result.blocked_subnets || [])].filter(Boolean).join(', ') || 'Совпадений не найдено');
  appendFact(facts, 'CDN', (result.cdn_providers || []).map((provider) => `${provider.name}${provider.networks?.length ? ` · ${provider.networks.join(', ')}` : ''}`).join('; ') || 'Совпадений не найдено');
  if (result.ips?.length) appendFact(facts, 'IP', result.ips.join(', '));
  if (result.organization || result.asn) appendFact(facts, 'Сеть', [result.organization, result.asn, result.location].filter(Boolean).join(' · '));
  output.append(verdict, facts);
}

export function initProviderDiagnostics() {
  const modal = $('provider-check-modal');
  if (!modal || modal.dataset.initialized === '1') return;
  modal.dataset.initialized = '1';
  let core = 'xray';
  let mode = 'current';
  let targets = [];
  let results = new Map();
  let sequence = 0;
  let running = false;
  let abortRun = null;
  let returnFocus = null;

  function status(message, error = false) {
    const element = $('provider-check-status');
    element.textContent = message;
    element.classList.toggle('is-error', error);
  }

  function updateOverview() {
    const overview = $('provider-check-overview');
    overview.hidden = results.size === 0;
    const values = [...results.values()];
    $('provider-check-ok-count').textContent = String(values.filter((item) => item.status === 'reachable').length);
    $('provider-check-issue-count').textContent = String(values.filter((item) => ['timeout', 'refused', 'unreachable', 'dns_error', 'tls_error'].includes(item.status)).length);
    $('provider-check-unknown-count').textContent = String(values.filter((item) => ['udp_unknown', 'busy', 'probe_error'].includes(item.status)).length);
  }

  function paintResult(index) {
    const row = $('provider-check-list').children[index];
    const state = row?.querySelector('.xk-provider-check-row-state');
    if (!state) return;
    const result = results.get(index);
    state.className = `xk-provider-check-row-state${result ? ` is-${result.status}` : ''}`;
    state.textContent = result ? (LABELS[result.status] || 'Ошибка') : 'Не проверен';
    if (result?.message) {
      const detail = document.createElement('small');
      detail.textContent = `${result.message}${result.tcp_ms != null ? ` · ${result.tcp_ms} мс` : ''}`;
      state.appendChild(detail);
    }
    const details = row.querySelector('.xk-provider-check-details');
    details.hidden = !result;
    details.replaceChildren();
    if (!result) return;
    const summary = document.createElement('summary');
    summary.textContent = 'Этапы проверки';
    const facts = document.createElement('dl');
    if (['probe_error', 'busy'].includes(result.status)) {
      appendFact(facts, 'Запрос', result.message || 'Проверка не выполнена.');
    } else {
      appendFact(facts, 'DNS', result.status === 'dns_error' ? 'Имя не разрешено' : `${(result.addresses || []).join(', ') || 'Нет ответа'}${result.dns_ms != null ? ` · ${result.dns_ms} мс` : ''}`);
      appendFact(facts, result.network === 'udp' ? 'UDP' : 'TCP', result.network === 'udp' ? 'Протокольная проверка не выполнялась' : (result.tcp_ms != null ? `Подключено за ${result.tcp_ms} мс` : result.message || 'Подключение не установлено'));
      if (result.tls) appendFact(facts, 'TLS', result.tls_ms != null ? `Рукопожатие за ${result.tls_ms} мс` : result.status === 'tls_error' ? 'Рукопожатие не прошло' : 'Не выполнено');
    }
    details.append(summary, facts);
    const host = targets[index]?.host || '';
    const isPublicName = host.includes('.') && !host.includes(':') && !/^\d+(?:\.\d+){3}$/.test(host) && !/\.(?:local|lan|home|internal|test|invalid|example)$/i.test(host);
    const actions = document.createElement('div');
    actions.className = 'xk-provider-check-detail-actions';
    const retry = document.createElement('button');
    retry.type = 'button';
    responsiveLabel(retry, 'Повторить', 'Повтор');
    retry.addEventListener('click', () => void run(index));
    actions.append(retry);
    if (isPublicName) {
      const compare = document.createElement('button');
      compare.type = 'button';
      responsiveLabel(compare, 'Сравнить DNS', 'DNS');
      const output = document.createElement('p');
      output.className = 'xk-provider-check-dns-compare';
      compare.addEventListener('click', async () => {
        compare.disabled = true;
        output.textContent = 'Запрос к публичному DNS…';
        try {
          const data = await api('/api/provider-diagnostics/dns-compare', { host }, AbortSignal.timeout(7000));
          const comparison = data.result;
          output.textContent = comparison.status === 'ok'
            ? `Роутер: ${comparison.local.join(', ') || 'нет ответа'} · Google DNS (A): ${comparison.public.join(', ') || 'нет ответа'}${comparison.local_error && comparison.public.length ? ' · локальный DNS не ответил, проверьте его настройки и маршрут' : ''}${comparison.different ? ' · адреса различаются, возможен CDN или разный маршрут' : ''}`
            : comparison.message || 'Сравнение не выполнено.';
        } catch (error) {
          output.textContent = error.message || 'Сравнение не выполнено.';
        } finally {
          compare.disabled = false;
        }
      });
      actions.append(compare);
      details.append(output);
    }
    const isExternalTarget = host && !/\.(?:local|lan|home|internal|test|invalid|example)$/i.test(host)
      && !/^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|0\.|255\.|::1$|fe80:|f[cd][0-9a-f]:)/i.test(host);
    if (isExternalTarget) {
      const listCheck = document.createElement('button');
      listCheck.type = 'button';
      responsiveLabel(listCheck, 'Проверить списки', 'Списки');
      const output = document.createElement('div');
      output.className = 'xk-provider-check-public-lists';
      listCheck.addEventListener('click', async () => {
        listCheck.disabled = true;
        output.textContent = 'Запрос к Cheburcheck…';
        try {
          const data = await api('/api/provider-diagnostics/public-lists', { host }, AbortSignal.timeout(9000));
          paintPublicLists(output, data.result);
        } catch (error) {
          output.textContent = error.message || 'Проверка по спискам не выполнена.';
        } finally {
          listCheck.disabled = false;
          if (details.isConnected && details.open) actions.scrollIntoView({ block: 'nearest' });
        }
      });
      actions.append(listCheck);
      details.append(output);
      const external = document.createElement('a');
      external.href = `https://cheburcheck.ru/check?target=${encodeURIComponent(host)}`;
      external.target = '_blank';
      external.rel = 'noopener noreferrer';
      external.setAttribute('aria-label', 'Открыть в Cheburcheck');
      external.title = 'Открыть в Cheburcheck';
      const externalLabel = document.createElement('span');
      externalLabel.className = 'xk-provider-check-label-full';
      externalLabel.textContent = 'Открыть в Cheburcheck';
      const externalIcon = document.createElement('span');
      externalIcon.className = 'xk-provider-check-external-icon';
      externalIcon.innerHTML = iconHtml('forward');
      external.append(externalLabel, externalIcon);
      actions.append(external);
    }
    details.append(actions);
  }

  function render() {
    const list = $('provider-check-list');
    list.replaceChildren();
    $('provider-check-count').textContent = `Серверы · ${targets.length}`;
    targets.forEach((target, index) => {
      const row = document.createElement('div');
      row.className = 'xk-provider-check-row';
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = true;
      check.dataset.providerCheckIndex = String(index);
      check.setAttribute('aria-label', `Выбрать ${target.name || target.host}`);
      const main = document.createElement('div');
      main.className = 'xk-provider-check-row-main';
      const title = document.createElement('strong');
      title.textContent = target.name || target.host;
      const endpoint = document.createElement('span');
      endpoint.textContent = `${target.host.includes(':') ? `[${target.host}]` : target.host}:${target.port} · ${target.network.toUpperCase()}${target.source ? ` · ${target.source}` : ''}`;
      main.append(title, endpoint);
      const state = document.createElement('div');
      state.className = 'xk-provider-check-row-state';
      const details = document.createElement('details');
      details.className = 'xk-provider-check-details';
      details.hidden = true;
      row.append(check, main, state, details);
      list.appendChild(row);
      paintResult(index);
    });
    $('provider-check-select-all').checked = true;
    $('provider-check-run').disabled = running || !targets.length;
  }

  function setTargets(items, warnings = [], truncated = false) {
    targets = (Array.isArray(items) ? items : []).slice(0, 24);
    results = new Map();
    render();
    updateOverview();
    const notice = warnings.filter(Boolean).join(' ') || (targets.length ? `Найдено серверов: ${targets.length}.` : 'Серверы не найдены.');
    status(`${notice}${truncated || items?.length > 24 ? ' Показаны первые 24.' : ''}`);
  }

  async function loadCurrent() {
    const token = ++sequence;
    status('Читаем сохранённую конфигурацию…');
    try {
      const data = await api(`/api/provider-diagnostics/targets?core=${core}`);
      if (token === sequence && mode === 'current') setTargets(data.targets);
    } catch (error) {
      if (token === sequence) status(error.message || 'Не удалось прочитать конфигурацию.', true);
    }
  }

  async function parseManual() {
    const source = $('provider-check-input').value.trim();
    if (!source) return status('Введите адрес, ссылку или подписку.', true);
    const token = ++sequence;
    $('provider-check-parse').disabled = true;
    status('Разбираем источник…');
    try {
      const data = await api('/api/provider-diagnostics/parse', { source }, AbortSignal.timeout(45000));
      if (token === sequence && mode === 'manual') setTargets(data.targets, data.warnings, data.truncated);
    } catch (error) {
      if (token === sequence) status(error.message || 'Не удалось разобрать источник.', true);
    } finally {
      $('provider-check-parse').disabled = false;
    }
  }

  function selectMode(next) {
    mode = next;
    sequence += 1;
    abortRun?.abort();
    running = false;
    targets = [];
    results = new Map();
    for (const value of ['current', 'manual']) {
      const active = value === mode;
      $(`provider-check-mode-${value}`).classList.toggle('is-active', active);
      $(`provider-check-mode-${value}`).setAttribute('aria-selected', String(active));
      $(`provider-check-${value}-panel`).hidden = !active;
    }
    render();
    updateOverview();
    if (mode === 'current') void loadCurrent();
    else status('');
  }

  function open(nextCore, source = '') {
    returnFocus = document.activeElement;
    core = nextCore === 'mihomo' ? 'mihomo' : 'xray';
    $('provider-check-title').textContent = `Диагностика серверов ${core === 'mihomo' ? 'Mihomo' : 'Xray'}`;
    $('provider-check-source-title').textContent = `Сохранённая конфигурация ${core === 'mihomo' ? 'Mihomo' : 'Xray'}`;
    if (source) $('provider-check-input').value = source;
    modal.classList.remove('hidden');
    document.body.classList.add('modal-open');
    selectMode(source ? 'manual' : 'current');
    (source ? $('provider-check-input') : $('provider-check-close')).focus();
  }

  function close() {
    sequence += 1;
    abortRun?.abort();
    modal.classList.add('hidden');
    if (!document.querySelector('.modal:not(.hidden)')) document.body.classList.remove('modal-open');
    returnFocus?.focus?.();
  }

  async function run(onlyIndex = null) {
    if (running) return;
    const selected = onlyIndex == null
      ? [...modal.querySelectorAll('[data-provider-check-index]:checked')].map((input) => Number(input.dataset.providerCheckIndex))
      : [onlyIndex];
    if (!selected.length) return status('Выберите хотя бы один сервер.', true);
    running = true;
    const token = ++sequence;
    abortRun = new AbortController();
    $('provider-check-run').disabled = true;
    let cursor = 0;
    let completed = 0;
    status(`Проверено 0 из ${selected.length}…`);
    const worker = async () => {
      while (cursor < selected.length && token === sequence) {
        const index = selected[cursor++];
        try {
          const data = await api('/api/provider-diagnostics/probe', targets[index], AbortSignal.any([abortRun.signal, AbortSignal.timeout(12000)]));
          if (token === sequence) results.set(index, data.result);
        } catch (error) {
          if (token === sequence) results.set(index, { ...targets[index], status: 'probe_error', message: error.message || 'Запрос диагностики не завершился.' });
        }
        if (token !== sequence) return;
        completed += 1;
        paintResult(index);
        updateOverview();
        status(`Проверено ${completed} из ${selected.length}.`);
      }
    };
    await Promise.all([worker(), worker()]);
    if (token !== sequence) return;
    running = false;
    $('provider-check-run').disabled = false;
    const entries = selected.map((index) => results.get(index));
    status(`Готово: TCP доступен у ${entries.filter((item) => item.status === 'reachable').length}, таймаутов ${entries.filter((item) => item.status === 'timeout').length}, проверено ${completed}.`);
  }

  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-provider-check-core]');
    if (trigger) open(trigger.dataset.providerCheckCore);
  });
  document.addEventListener('xk-provider-check-open', (event) => open(event.detail?.core, event.detail?.source || ''));
  $('provider-check-close').addEventListener('click', close);
  $('provider-check-cancel').addEventListener('click', close);
  $('provider-check-mode-current').addEventListener('click', () => selectMode('current'));
  $('provider-check-mode-manual').addEventListener('click', () => selectMode('manual'));
  $('provider-check-refresh').addEventListener('click', loadCurrent);
  $('provider-check-parse').addEventListener('click', parseManual);
  $('provider-check-run').addEventListener('click', () => void run());
  $('provider-check-select-all').addEventListener('change', (event) => {
    modal.querySelectorAll('[data-provider-check-index]').forEach((input) => { input.checked = event.target.checked; });
  });
  modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modal.classList.contains('hidden')) {
      event.stopPropagation();
      close();
    }
  }, true);
}
