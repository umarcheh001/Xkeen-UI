import { iconHtml } from '../ui/operator_icons.js';

const $ = (id) => document.getElementById(id);

function responsiveLabel(control, full, compact, tooltip) {
  control.setAttribute('aria-label', full);
  control.dataset.tooltip = tooltip;
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
  reachable: 'TCP доступен', tls_error: 'TCP доступен · TLS ошибка', tls_cert_error: 'TLS: ошибка сертификата', timeout: 'Таймаут',
  refused: 'Отказ соединения', unreachable: 'Нет соединения', dns_error: 'Ошибка DNS',
  udp_unknown: 'UDP не подтверждён', busy: 'Занято', probe_error: 'Проверка не выполнена',
};

const COMPARISON_LABELS = {
  registry_confirmed: ['Запись в реестре подтверждена', 'high'],
  tls_sni_filtering: ['Признаки фильтрации TLS/SNI', 'medium'],
  dns_failure: ['Сбой DNS', 'medium'],
  server_unresponsive: ['Сервер не отвечает', 'medium'],
  undetermined: ['Причина не установлена', 'low'],
};
const ATTEMPT_LABELS = {
  tls_ok: 'TLS прошёл', tls_error: 'TLS прерван', timeout: 'таймаут', refused: 'отказ TCP', unreachable: 'нет маршрута',
};

function setButtonBusy(button, busy, label = '') {
  if (!button) return;
  button.classList.toggle('is-loading', busy);
  button.setAttribute('aria-busy', String(busy));
  button.disabled = busy;
  if (label) button.dataset.loadingLabel = label;
}

function appendFact(list, label, value) {
  const term = document.createElement('dt');
  term.textContent = label;
  const description = document.createElement('dd');
  description.textContent = value;
  list.append(term, description);
}

function paintPublicLists(output, result) {
  output.replaceChildren();
  const row = output.closest('.xk-provider-check-row');
  if (row) {
    row.classList.remove('is-registry-blocked');
    row.querySelector('.xk-provider-check-registry-badge')?.remove();
  }
  if (result.status !== 'ok') {
    output.textContent = result.message || 'Проверка по спискам не выполнена.';
    return;
  }
  const registryMatches = [result.registry_domain, ...(result.blocked_subnets || [])].filter(Boolean);
  const registryBlocked = result.listed === true && registryMatches.length > 0;
  if (row) row.classList.toggle('is-registry-blocked', registryBlocked);
  if (registryBlocked && row) {
    const badge = document.createElement('span');
    badge.className = 'xk-provider-check-registry-badge';
    badge.textContent = 'В реестре блокировок';
    row.querySelector('.xk-provider-check-meta')?.append(badge);
  }
  const verdict = document.createElement('strong');
  verdict.className = registryBlocked ? 'is-registry-blocked' : result.listed ? 'is-listed' : 'is-clear';
  verdict.textContent = registryBlocked ? 'В реестре заблокированных ресурсов' : result.listed ? 'Есть совпадение в списках' : 'Совпадений в списках не найдено';
  if (registryBlocked) {
    const notice = document.createElement('p');
    notice.className = 'xk-provider-check-registry-notice';
    notice.textContent = 'Cheburcheck нашёл домен или IP-сеть в реестре. Доступность TCP не отменяет эту запись.';
    output.append(verdict, notice);
  } else {
    output.append(verdict);
  }
  const facts = document.createElement('dl');
  if (registryBlocked) {
    const term = document.createElement('dt');
    term.textContent = 'Реестр';
    const description = document.createElement('dd');
    description.className = 'xk-provider-check-registry-match';
    description.textContent = registryMatches.join(', ');
    facts.append(term, description);
  } else {
    appendFact(facts, 'Реестр', 'Совпадений не найдено');
  }
  appendFact(facts, 'CDN', (result.cdn_providers || []).map((provider) => `${provider.name}${provider.networks?.length ? ` · ${provider.networks.join(', ')}` : ''}`).join('; ') || 'Совпадений не найдено');
  if (result.ips?.length) appendFact(facts, 'IP', result.ips.join(', '));
  if (result.organization || result.asn) appendFact(facts, 'Сеть', [result.organization, result.asn, result.location].filter(Boolean).join(' · '));
  output.append(facts);
}

function paintTlsComparison(output, result) {
  output.replaceChildren();
  output.className = 'xk-provider-check-comparison';
  if (!result || result.status !== 'ok') {
    output.textContent = result?.message || 'Сравнительная проверка не выполнена.';
    return;
  }
  const [label, fallbackConfidence] = COMPARISON_LABELS[result.verdict] || COMPARISON_LABELS.undetermined;
  const confidence = result.confidence || fallbackConfidence;
  const heading = document.createElement('strong');
  heading.className = `is-verdict-${result.verdict}`;
  heading.textContent = label;
  const confidenceText = { high: 'высокая', medium: 'средняя', low: 'низкая' }[confidence] || confidence;
  const confidenceLine = document.createElement('span');
  confidenceLine.className = 'xk-provider-check-comparison-confidence';
  confidenceLine.textContent = `Уверенность: ${confidenceText}`;
  output.append(heading, confidenceLine);
  const facts = document.createElement('dl');
  appendFact(facts, 'IP', result.target_ip || 'Не разрешён');
  appendFact(facts, 'SNI', result.sni || 'Не настроен');
  appendFact(facts, 'С SNI', (result.trials?.with_sni || []).map((item) => ATTEMPT_LABELS[item] || item).join(' · ') || 'Не выполнено');
  appendFact(facts, 'Без SNI', (result.trials?.without_sni || []).map((item) => ATTEMPT_LABELS[item] || item).join(' · ') || 'Не выполнено');
  appendFact(facts, 'Контроль', `${result.control?.ip || '1.1.1.1'} · ${ATTEMPT_LABELS[result.control?.result] || 'не выполнено'}`);
  if (result.dns_comparison?.public?.length) appendFact(facts, 'Публичный DNS', result.dns_comparison.public.join(', '));
  if (result.registry?.status === 'ok') appendFact(facts, 'Реестр', result.registry.domain || result.registry.subnets?.join(', ') || 'Совпадений нет');
  else if (result.registry?.status && result.registry.status !== 'skipped') appendFact(facts, 'Реестр', 'Ответ не получен');
  output.append(facts);
}

export function initProviderDiagnostics() {
  const modal = $('provider-check-modal');
  if (!modal || modal.dataset.initialized === '1') return;
  modal.dataset.initialized = '1';
  let core = 'xray';
  let mode = 'current';
  let targets = [];
  let hasMoreTargets = false;
  let loadingMoreTargets = false;
  let results = new Map();
  let proxyResults = new Map();
  let sequence = 0;
  let running = false;
  let abortRun = null;
  let activeTrigger = null;
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
    $('provider-check-issue-count').textContent = String(values.filter((item) => ['timeout', 'refused', 'unreachable', 'dns_error', 'tls_error', 'tls_cert_error'].includes(item.status)).length);
    $('provider-check-unknown-count').textContent = String(values.filter((item) => ['udp_unknown', 'busy', 'probe_error'].includes(item.status)).length);
  }

  function paintResult(index) {
    const row = $('provider-check-list').children[index];
    const state = row?.querySelector('.xk-provider-check-row-state');
    if (!state) return;
    const result = results.get(index);
    const proxyResult = proxyResults.get(index);
    row.classList.remove('is-registry-blocked');
    row.querySelector('.xk-provider-check-registry-badge')?.remove();
    row.dataset.result = result?.status || 'pending';
    state.className = `xk-provider-check-row-state${result ? ` is-${result.status}` : ''}`;
    state.textContent = result ? (LABELS[result.status] || 'Ошибка') : 'Не проверен';
    if (result?.tcp_ms != null) {
      const latency = document.createElement('span');
      latency.className = 'xk-provider-check-latency';
      latency.textContent = `${result.tcp_ms} мс`;
      state.appendChild(latency);
    }
    if (result?.message) {
      const detail = document.createElement('small');
      detail.textContent = proxyResult
        ? result.message.replace('REALITY и работа прокси не проверялись.', 'REALITY не проверялась.').replace(' Работа прокси не проверялась.', '')
        : result.message;
      state.appendChild(detail);
    }
    if (proxyResult) {
      const proxyStatus = document.createElement('small');
      proxyStatus.className = `xk-provider-check-proxy-status is-${proxyResult.status}`;
      proxyStatus.textContent = `${proxyResult.status === 'ok' ? `Прокси работает · ${proxyResult.delay_ms} мс` : proxyResult.status === 'failed' ? 'Прокси не подтвердился' : 'Прокси не проверен'}: ${proxyResult.message}`;
      state.appendChild(proxyStatus);
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
      if (result.connected_ip) appendFact(facts, 'Сокет', `${result.source_ip || 'Адрес панели не определён'} → ${result.connected_ip}`);
      appendFact(facts, result.network === 'udp' ? 'UDP' : 'TCP', result.network === 'udp' ? 'Протокольная проверка не выполнялась' : (result.tcp_ms != null ? `Подключено за ${result.tcp_ms} мс` : result.message || 'Подключение не установлено'));
      if (result.tls) appendFact(facts, 'TLS', `${result.tls_ms != null ? `Рукопожатие за ${result.tls_ms} мс` : result.status === 'tls_cert_error' ? 'Сертификат не прошёл проверку' : result.status === 'tls_error' ? 'Рукопожатие не прошло' : 'Не выполнено'} · ${result.sni_sent === false ? 'SNI не отправлен (IP-адрес)' : `SNI: ${result.sni || result.host}`}${result.verify_tls === false ? ' · сертификат не проверялся' : ''}`);
      else if (result.tls_mode === 'reality') appendFact(facts, 'REALITY', `SNI: ${result.sni || result.host} · протокольная проверка не выполнялась`);
    }
    details.append(summary, facts);
    const host = targets[index]?.host || '';
    const isPublicName = host.includes('.') && !host.includes(':') && !/^\d+(?:\.\d+){3}$/.test(host) && !/\.(?:local|lan|home|internal|test|invalid|example)$/i.test(host);
    const actions = document.createElement('div');
    actions.className = 'xk-provider-check-detail-actions';
    const retry = document.createElement('button');
    retry.type = 'button';
    responsiveLabel(retry, 'Повторить', 'Повтор', 'Повторить DNS, TCP и, где настроен, стандартный TLS для этого сервера');
    retry.addEventListener('click', () => void run(index, retry));
    actions.append(retry);
    const compareName = result.sni || result.host;
    if (result.tls && result.network === 'tcp' && (result.tls_mode === 'standard' || !result.tls_mode) && !compareName.includes(':') && !/^\d+(?:\.\d+){3}$/.test(compareName)) {
      const compareTls = document.createElement('button');
      compareTls.type = 'button';
      responsiveLabel(compareTls, 'Сравнить TLS/SNI', 'TLS/SNI', 'Сравнить два TLS-рукопожатия к одному IP с настроенным SNI и без него, плюс контрольный адрес');
      const comparison = document.createElement('div');
      comparison.className = 'xk-provider-check-comparison';
      compareTls.addEventListener('click', async () => {
        setButtonBusy(compareTls, true, 'Сравниваем TLS/SNI…');
        comparison.textContent = 'Сравниваем TLS/SNI…';
        try {
          const data = await api('/api/provider-diagnostics/compare-tls', result, AbortSignal.timeout(25000));
          paintTlsComparison(comparison, data.result);
        } catch (error) {
          comparison.textContent = error.message || 'Сравнительная проверка не выполнена.';
        } finally {
          setButtonBusy(compareTls, false);
        }
      });
      actions.append(compareTls);
      details.append(comparison);
    }
    if (isPublicName) {
      const compare = document.createElement('button');
      compare.type = 'button';
      responsiveLabel(compare, 'Сравнить DNS', 'DNS', 'Сравнить ответ DNS роутера с публичным Google DNS; имя сервера будет передано внешнему сервису');
      const output = document.createElement('p');
      output.className = 'xk-provider-check-dns-compare';
      compare.addEventListener('click', async () => {
        setButtonBusy(compare, true, 'Запрос к публичному DNS…');
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
          setButtonBusy(compare, false);
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
      responsiveLabel(listCheck, 'Проверить списки', 'Списки', 'Проверить реестр блокировок и CDN через Cheburcheck; имя или IP сервера будет передано внешнему сервису');
      const output = document.createElement('div');
      output.className = 'xk-provider-check-public-lists';
      listCheck.addEventListener('click', async () => {
        setButtonBusy(listCheck, true, 'Запрос к Cheburcheck…');
        output.textContent = 'Запрос к Cheburcheck…';
        try {
          const data = await api('/api/provider-diagnostics/public-lists', { host }, AbortSignal.timeout(9000));
          paintPublicLists(output, data.result);
        } catch (error) {
          output.textContent = error.message || 'Проверка по спискам не выполнена.';
        } finally {
          setButtonBusy(listCheck, false);
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
      external.dataset.tooltip = 'Открыть подробную проверку сервера на сайте Cheburcheck в новой вкладке';
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

  function render(start = 0) {
    const list = $('provider-check-list');
    if (start === 0) list.replaceChildren();
    $('provider-check-count').textContent = String(targets.length);
    const selectAll = $('provider-check-select-all');
    const newChecked = start === 0 || selectAll.checked;
    targets.slice(start).forEach((target, offset) => {
      const index = start + offset;
      const row = document.createElement('article');
      row.className = 'xk-provider-check-row';
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = newChecked;
      check.dataset.providerCheckIndex = String(index);
      check.setAttribute('aria-label', `Выбрать ${target.name || target.host}`);
      check.dataset.tooltip = `Включить или исключить ${target.name || target.host} из общей проверки`;
      const main = document.createElement('div');
      main.className = 'xk-provider-check-row-main';
      const identity = document.createElement('div');
      identity.className = 'xk-provider-check-identity';
      const title = document.createElement('strong');
      title.textContent = target.name || target.host;
      const endpoint = document.createElement('span');
      endpoint.className = 'xk-provider-check-endpoint';
      endpoint.textContent = `${target.host.includes(':') ? `[${target.host}]` : target.host}:${target.port}`;
      const meta = document.createElement('div');
      meta.className = 'xk-provider-check-meta';
      const network = document.createElement('span');
      network.textContent = target.network.toUpperCase();
      meta.append(network);
      if (target.protocol) {
        const protocol = document.createElement('span');
        protocol.textContent = target.protocol.toUpperCase();
        meta.append(protocol);
      }
      if (target.tls_mode && target.tls_mode !== 'none') {
        const security = document.createElement('span');
        security.textContent = target.tls_mode === 'reality' ? 'REALITY' : 'TLS';
        meta.append(security);
      }
      if (target.source) {
        const source = document.createElement('span');
        source.textContent = target.source;
        meta.append(source);
      }
      if (target.proxy_ref && Number.isInteger(target.proxy_index)) {
        const proxyButton = document.createElement('button');
        proxyButton.type = 'button';
        proxyButton.className = 'xk-provider-check-proxy-button';
        proxyButton.innerHTML = iconHtml('ping');
        responsiveLabel(proxyButton, 'Проверить прокси', 'Прокси', `Запустить временный ${target.proxy_engine === 'mihomo' ? 'Mihomo' : 'Xray'} и проверить HTTPS-запрос через этот прокси с маршрута панели`);
        proxyButton.addEventListener('click', async () => {
          setButtonBusy(proxyButton, true, 'Проверяем прокси…');
          try {
            const data = await api('/api/provider-diagnostics/proxy-probe', { ref: target.proxy_ref, index: target.proxy_index }, AbortSignal.timeout(30000));
            proxyResults.set(index, data.result);
          } catch (error) {
            proxyResults.set(index, { status: 'unavailable', message: error.name === 'TimeoutError' ? 'Время ожидания ответа истекло.' : error.message || 'Проверка не выполнена.' });
          } finally {
            setButtonBusy(proxyButton, false);
            paintResult(index);
          }
        });
        meta.append(proxyButton);
      }
      identity.append(title, endpoint);
      main.append(identity, meta);
      const state = document.createElement('div');
      state.className = 'xk-provider-check-row-state';
      const details = document.createElement('details');
      details.className = 'xk-provider-check-details';
      details.hidden = true;
      row.append(check, main, state, details);
      list.appendChild(row);
      paintResult(index);
    });
    const inputs = [...list.querySelectorAll('[data-provider-check-index]')];
    const selected = inputs.filter((input) => input.checked).length;
    selectAll.checked = selected === inputs.length;
    selectAll.indeterminate = selected > 0 && selected < inputs.length;
    $('provider-check-run').disabled = running || selected === 0;
    $('provider-check-more-wrap').hidden = mode !== 'current' || core !== 'xray' || !hasMoreTargets;
    $('provider-check-more').disabled = running || loadingMoreTargets;
  }

  function setTargets(items, warnings = [], truncated = false, hasMore = false) {
    const savedXray = mode === 'current' && core === 'xray';
    const sourceItems = Array.isArray(items) ? items : [];
    targets = savedXray ? sourceItems : sourceItems.slice(0, 200);
    hasMoreTargets = hasMore;
    results = new Map();
    proxyResults = new Map();
    render();
    updateOverview();
    const limited = !savedXray && (truncated || sourceItems.length > 200);
    const count = targets.length ? `${hasMore || limited ? 'Показано' : 'Найдено'} серверов: ${targets.length}.` : 'Серверы не найдены.';
    const notice = warnings.filter(Boolean).join(' ');
    status(`${count}${notice ? ` ${notice}` : ''}${limited ? ' Лимит ручного ввода: 200; остальные серверы не загружены.' : ''}${hasMore ? ' Есть ещё серверы.' : ''}`, targets.length === 0 && warnings.length > 0);
  }

  async function loadCurrent() {
    const token = ++sequence;
    status('Читаем сохранённую конфигурацию…');
    try {
      const data = await api(`/api/provider-diagnostics/targets?core=${core}`);
      if (token === sequence && mode === 'current') setTargets(data.targets, [], false, data.has_more === true);
    } catch (error) {
      if (token === sequence) status(error.message || 'Не удалось прочитать конфигурацию.', true);
    }
  }

  async function loadMoreCurrent() {
    if (loadingMoreTargets || running || !hasMoreTargets || mode !== 'current' || core !== 'xray') return;
    const token = sequence;
    const offset = targets.length;
    loadingMoreTargets = true;
    setButtonBusy($('provider-check-more'), true);
    try {
      const data = await api(`/api/provider-diagnostics/targets?core=xray&offset=${offset}`, null, AbortSignal.timeout(15000));
      if (token !== sequence || mode !== 'current') return;
      const next = Array.isArray(data.targets) ? data.targets : [];
      hasMoreTargets = data.has_more === true && next.length > 0;
      targets.push(...next);
      render(offset);
      status(`${hasMoreTargets ? 'Показано' : 'Найдено'} серверов: ${targets.length}.${hasMoreTargets ? ' Есть ещё серверы.' : ''}`);
    } catch (error) {
      if (token === sequence) status(error.message || 'Не удалось загрузить следующую часть серверов.', true);
    } finally {
      loadingMoreTargets = false;
      setButtonBusy($('provider-check-more'), false);
      $('provider-check-more').disabled = running;
    }
  }

  async function parseManual() {
    const source = $('provider-check-input').value.trim();
    if (!source) return status('Введите адрес, ссылку или подписку.', true);
    const token = ++sequence;
    $('provider-check-parse').disabled = true;
    status('Разбираем источник…');
    try {
      const data = await api('/api/provider-diagnostics/parse', { source, core }, AbortSignal.timeout(45000));
      if (token === sequence && mode === 'manual') setTargets(data.targets, data.warnings, data.truncated);
    } catch (error) {
      if (token === sequence) status(error.name === 'TimeoutError' || error.name === 'AbortError'
        ? 'Не удалось дождаться ответа подписки. Проверьте доступ к ней с устройства панели и повторите запрос.'
        : error.message || 'Не удалось разобрать источник.', true);
    } finally {
      $('provider-check-parse').disabled = false;
    }
  }

  function selectMode(next) {
    mode = next;
    sequence += 1;
    abortRun?.abort();
    running = false;
    setButtonBusy(activeTrigger, false);
    activeTrigger = null;
    setButtonBusy($('provider-check-run'), false);
    targets = [];
    hasMoreTargets = false;
    results = new Map();
    proxyResults = new Map();
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
    running = false;
    setButtonBusy(activeTrigger, false);
    activeTrigger = null;
    setButtonBusy($('provider-check-run'), false);
    modal.classList.add('hidden');
    if (!document.querySelector('.modal:not(.hidden)')) document.body.classList.remove('modal-open');
    returnFocus?.focus?.();
  }

  async function run(onlyIndex = null, trigger = null) {
    if (running) return;
    const selected = onlyIndex == null
      ? [...modal.querySelectorAll('[data-provider-check-index]:checked')].map((input) => Number(input.dataset.providerCheckIndex))
      : [onlyIndex];
    if (!selected.length) return status('Выберите хотя бы один сервер.', true);
    running = true;
    const token = ++sequence;
    abortRun = new AbortController();
    activeTrigger = trigger;
    setButtonBusy($('provider-check-run'), true, 'Проверяем выбранные…');
    setButtonBusy(trigger, true, 'Повторяем…');
    $('provider-check-more').disabled = true;
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
    setButtonBusy(trigger, false);
    activeTrigger = null;
    setButtonBusy($('provider-check-run'), false);
    $('provider-check-run').disabled = !modal.querySelector('[data-provider-check-index]:checked');
    $('provider-check-more').disabled = loadingMoreTargets;
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
  $('provider-check-refresh').addEventListener('click', async () => {
    setButtonBusy($('provider-check-refresh'), true, 'Читаем…');
    try { await loadCurrent(); } finally { setButtonBusy($('provider-check-refresh'), false); }
  });
  $('provider-check-parse').addEventListener('click', async () => {
    setButtonBusy($('provider-check-parse'), true, 'Разбираем…');
    try { await parseManual(); } finally { setButtonBusy($('provider-check-parse'), false); }
  });
  $('provider-check-run').addEventListener('click', () => void run());
  $('provider-check-more').addEventListener('click', () => void loadMoreCurrent());
  $('provider-check-select-all').addEventListener('change', (event) => {
    modal.querySelectorAll('[data-provider-check-index]').forEach((input) => { input.checked = event.target.checked; });
    $('provider-check-run').disabled = running || !event.target.checked;
  });
  $('provider-check-list').addEventListener('change', (event) => {
    if (!event.target.matches('[data-provider-check-index]')) return;
    const inputs = [...modal.querySelectorAll('[data-provider-check-index]')];
    const selected = inputs.filter((input) => input.checked).length;
    $('provider-check-select-all').checked = selected === inputs.length;
    $('provider-check-select-all').indeterminate = selected > 0 && selected < inputs.length;
    $('provider-check-run').disabled = running || selected === 0;
  });
  modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modal.classList.contains('hidden')) {
      event.stopPropagation();
      close();
    }
  }, true);
}
