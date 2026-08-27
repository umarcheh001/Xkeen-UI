import { getXkeenCoreHttpApi } from '../../xkeen_runtime.js';
import { getRoutingCardsNamespace } from '../../routing_cards_namespace.js';

/* Guarded, one-click DNS-over-VLESS assistant. */
(function () {
  'use strict';

  const RC = getRoutingCardsNamespace();
  const C = RC.common || {};
  const IDS = RC.IDS || {};
  const $ = (typeof C.$ === 'function') ? C.$ : (id) => document.getElementById(id);
  const toast = (typeof C.toast === 'function') ? C.toast : (message) => console.log(message);

  const DOM = {
    modal: 'routing-dns-over-vless-modal',
    close: 'routing-dns-over-vless-close',
    cancel: 'routing-dns-over-vless-cancel',
    apply: 'routing-dns-over-vless-apply',
    badge: 'routing-dns-over-vless-badge',
    status: 'routing-dns-over-vless-status',
    details: 'routing-dns-over-vless-details',
    dot: 'routing-dns-over-vless-dot',
    route: 'routing-dns-over-vless-route',
    target: 'routing-dns-over-vless-target',
    fallback: 'routing-dns-over-vless-route-fallback',
    multi: 'routing-dns-over-vless-multi',
    multiRow: 'routing-dns-over-vless-multi-row',
    upstreams: 'routing-dns-over-vless-upstreams',
    local: 'routing-dns-over-vless-local',
    zones: 'routing-dns-over-vless-zones',
    zonesRow: 'routing-dns-over-vless-zones-row',
  };

  let status = null;
  let busy = false;
  let chosenTargets = [];
  let multiTouched = false;

  function showModal(open) {
    const modal = $(DOM.modal);
    if (!modal) return;
    modal.classList.toggle('hidden', !open);
    document.body.classList.toggle('modal-open', !!open);
    if (open) setTimeout(() => { try { $(DOM.cancel).focus(); } catch (e) {} }, 0);
  }

  function http() {
    return getXkeenCoreHttpApi();
  }

  async function getStatus() {
    const client = http();
    if (client && typeof client.fetchJSON === 'function') {
      return client.fetchJSON('/api/routing/dns-over-vless', { cache: 'no-store', timeoutMs: 15000 });
    }
    const response = await fetch('/api/routing/dns-over-vless', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  function dnsSettings() {
    const upstreams = $(DOM.upstreams);
    const local = $(DOM.local);
    const settings = {};
    if (upstreams) settings.upstreams = String(upstreams.value || '').trim();
    // An empty string is meaningful here: it switches the local exception off.
    if (local) settings.local_resolver = String(local.value || '').trim();
    const zones = $(DOM.zones);
    if (zones && settings.local_resolver) settings.local_domains = String(zones.value || '').trim();
    return settings;
  }

  async function postAction(action, targets) {
    const list = Array.isArray(targets) ? targets.filter(Boolean) : [];
    const payload = list.length ? { action, targets: list } : { action };
    if (action === 'enable') Object.assign(payload, dnsSettings());
    const client = http();
    if (client && typeof client.postJSON === 'function') {
      return client.postJSON('/api/routing/dns-over-vless', payload, { timeoutMs: 90000, retry: 0 });
    }
    const token = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
    const response = await fetch('/api/routing/dns-over-vless', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || `HTTP ${response.status}`);
      error.data = data;
      throw error;
    }
    return data;
  }

  function addDetail(text, kind) {
    const list = $(DOM.details);
    if (!list) return;
    const li = document.createElement('li');
    li.className = kind ? `is-${kind}` : '';
    li.textContent = String(text || '');
    list.appendChild(li);
  }

  function candidateText(item) {
    const bits = [];
    if (item.strategy_type) bits.push(item.strategy_type);
    if (item.kind === 'balancer') bits.push(`узлов: ${item.selector_count}`);
    let text = item.label || item.tag;
    if (bits.length) text += ` · ${bits.join(' · ')}`;
    if (!item.usable && item.reason) text += ` — ${item.reason}`;
    return text;
  }

  function multiEnabled() {
    const box = $(DOM.multi);
    return !!(box && box.checked);
  }

  function renderRoute(data) {
    const wrap = $(DOM.route);
    const select = $(DOM.target);
    if (!wrap || !select) return;
    const candidates = (data && Array.isArray(data.candidates)) ? data.candidates : [];
    const usable = candidates.filter((item) => item && item.usable);
    // The route is only chosen while enabling; disabling touches nothing.
    const show = !!(data && !data.enabled && !data.can_disable && candidates.length);
    wrap.classList.toggle('hidden', !show);
    if (!show) {
      select.textContent = '';
      return;
    }

    // Xray routes a rule to one outbound or one balancer, so combining is only
    // possible across plain proxies — a balancer can never join them.
    const proxies = usable.filter((item) => item.kind === 'outbound');
    const multiRow = $(DOM.multiRow);
    const multiBox = $(DOM.multi);
    const canCombine = proxies.length > 1;
    if (multiRow) multiRow.classList.toggle('hidden', !canCombine);
    if (multiBox && !canCombine) multiBox.checked = false;
    // Reopen in combined mode when that is what was saved last time.
    const savedCombined = !!(data && (data.selected_targets || []).length > 1);
    if (multiBox && canCombine && savedCombined && !multiTouched) multiBox.checked = true;
    const multi = multiEnabled() && canCombine;

    const pool = multi ? candidates.filter((item) => item.kind === 'outbound') : candidates;
    const poolUsable = pool.filter((item) => item.usable);

    let wanted = chosenTargets.length
      ? chosenTargets
      : (data && (data.selected_targets || []).length ? data.selected_targets : [data && data.default_target].filter(Boolean));
    wanted = wanted.filter((tag) => poolUsable.some((item) => item.tag === tag));
    if (!wanted.length && poolUsable.length) wanted = [poolUsable[0].tag];
    if (!multi) wanted = wanted.slice(0, 1);

    select.multiple = multi;
    select.size = multi ? Math.min(6, Math.max(3, pool.length)) : 0;
    select.textContent = '';
    pool.forEach((item) => {
      const option = document.createElement('option');
      option.value = item.tag;
      option.textContent = candidateText(item);
      option.disabled = !item.usable;
      option.selected = wanted.indexOf(item.tag) !== -1;
      select.appendChild(option);
    });
    select.disabled = busy || (!multi && poolUsable.length < 2);
    renderDnsFields(data);
    chosenTargets = wanted;
    renderFallback(multi ? null : pool.find((item) => item.tag === wanted[0]), multi, wanted);
  }

  function renderDnsFields(data) {
    const upstreams = $(DOM.upstreams);
    const local = $(DOM.local);
    if (upstreams && !upstreams.dataset.touched) {
      upstreams.value = ((data && data.upstreams) || []).join(', ');
    }
    if (local && !local.dataset.touched) {
      local.value = ((data && data.local_resolvers) || []).join(', ');
    }
    if (upstreams) upstreams.disabled = busy;
    if (local) local.disabled = busy;

    const zones = $(DOM.zones);
    const zonesRow = $(DOM.zonesRow);
    // The zone list only means something once a local resolver answers them.
    const hasLocal = !!(local && String(local.value || '').trim());
    if (zonesRow) zonesRow.classList.toggle('hidden', !hasLocal);
    if (zones) {
      if (!zones.dataset.touched) {
        const list = (data && data.local_domains) || (data && data.default_local_domains) || [];
        zones.value = list.join(', ');
      }
      zones.disabled = busy;
    }
  }

  function renderFallback(candidate, multi, wanted) {
    const line = $(DOM.fallback);
    if (!line) return;
    if (multi) {
      line.classList.remove('hidden');
      const list = (wanted || []);
      if (list.length > 1) {
        line.dataset.state = 'kept';
        line.textContent = `Выбрано ${list.length}: ${list.join(', ')}. Панель создаст из них свой балансировщик; резервного маршрута у него нет.`;
      } else if (list.length === 1) {
        // One proxy is not a balancer: be honest instead of promising one.
        line.dataset.state = 'dropped';
        line.textContent = `Выбран один прокси (${list[0]}) — балансировки не будет. Отметьте ещё хотя бы один.`;
      } else {
        line.dataset.state = 'dropped';
        line.textContent = 'Отметьте хотя бы два прокси, между которыми балансировать DNS.';
      }
      return;
    }
    const plan = candidate && candidate.fallback;
    const show = !!(plan && plan.tag);
    line.classList.toggle('hidden', !show);
    if (!show) {
      line.textContent = '';
      return;
    }
    line.dataset.state = plan.kept ? 'kept' : 'dropped';
    line.textContent = plan.kept
      ? `Резервирование сохранено: ${plan.reason}.`
      : `Резервирование не переносится: ${plan.reason}.`;
  }

  function render(data) {
    status = data || null;
    const badge = $(DOM.badge);
    const text = $(DOM.status);
    const list = $(DOM.details);
    const apply = $(DOM.apply);
    const dot = $(DOM.dot);
    if (list) list.textContent = '';

    const enabled = !!(data && data.enabled);
    const canDisable = !!(data && data.can_disable);
    const blocked = !enabled && !canDisable && !(data && data.can_enable);
    // An automatic release is not a neutral "ready" state: the protection was
    // switched off by itself and the user has to know.
    const released = !enabled && !!(data && data.watchdog && data.watchdog.reason);
    if (badge) {
      badge.textContent = enabled
        ? 'Включено'
        : (released ? 'Отключено сторожем' : (canDisable ? 'Нужно восстановить' : (blocked ? 'Требует внимания' : 'Готово')));
      badge.dataset.state = enabled ? 'enabled' : ((released || canDisable || blocked) ? 'blocked' : 'ready');
    }
    if (dot) {
      dot.dataset.state = enabled ? 'enabled' : ((released || canDisable || blocked) ? 'blocked' : 'off');
    }
    if (text) {
      if (enabled) text.textContent = 'DNS-over-VLESS активен: Xray-конфигурация и DNS override Keenetic согласованы.';
      else if (data && data.partial) text.textContent = 'Обнаружена неполная настройка DNS-over-VLESS. Панель может удалить только свои объекты и восстановить DNS override.';
      else if (data && data.prepared) text.textContent = 'Xray-конфигурация подготовлена, но DNS override Keenetic ещё не активен.';
      else if (data && data.watchdog && data.watchdog.reason) text.textContent = 'DNS-over-VLESS был отключён автоматически: ядро не отвечало, и DNS вернулся к прошивке Keenetic.';
      else if (blocked) text.textContent = 'Однокнопочная настройка остановлена, чтобы не затронуть существующую маршрутизацию.';
      else text.textContent = 'Конфигурация совместима. После подтверждения панель проверит, сохранит и протестирует DNS автоматически.';
    }

    if (data) {
      addDetail(`Активное ядро: ${data.active_core || 'не определено'}`, data.active_core === 'xray' ? 'ok' : 'warn');
      if (data.target && data.target.label) addDetail(`Маршрут DNS: ${data.target.label}`, 'ok');
      addDetail(`Keenetic DNS override: ${data.dns_override === true ? 'включён' : (data.dns_override === false ? 'выключен' : 'не определён')}`, data.dns_override == null ? 'warn' : 'ok');
      if (data.watchdog && data.watchdog.reason) {
        addDetail(`Сторож отключил защиту: ${data.watchdog.reason} Порт 53 снова обслуживает Keenetic.`, 'warn');
      }
      if (data.route_drift) {
        const drift = data.route_drift;
        const was = (drift.managed || []).join(', ') || '—';
        const now = (drift.current || []).join(', ') || '—';
        const parts = [];
        if (was !== now) parts.push(`узлы: было «${was}», стало «${now}»`);
        if ((drift.managed_fallback || '') !== (drift.current_fallback || '')) {
          parts.push(`резерв: было «${drift.managed_fallback || '—'}», стало «${drift.current_fallback || '—'}»`);
        }
        addDetail(`Балансировщик ${drift.source} изменился после включения (${parts.join('; ')}). Переключите DNS-over-VLESS, чтобы обновить маршрут.`, 'warn');
      }
      (data.blockers || []).forEach((item) => addDetail(item, 'warn'));
    }

    renderRoute(data);

    if (apply) {
      apply.disabled = busy || (!enabled && !canDisable && blocked);
      apply.textContent = busy ? 'Выполняется…' : ((enabled || canDisable) ? 'Отключить и восстановить' : 'Включить безопасно');
      apply.classList.toggle('btn-danger', enabled || canDisable);
      apply.classList.toggle('btn-primary', !enabled && !canDisable);
    }
  }

  function renderError(error) {
    status = null;
    const badge = $(DOM.badge);
    const text = $(DOM.status);
    const apply = $(DOM.apply);
    if (badge) {
      badge.textContent = 'Ошибка проверки';
      badge.dataset.state = 'blocked';
    }
    if (text) text.textContent = String(error && error.message ? error.message : error || 'Не удалось проверить конфигурацию.');
    if (apply) {
      apply.disabled = true;
      apply.textContent = 'Недоступно';
    }
  }

  async function refresh() {
    try {
      const data = await getStatus();
      render(data);
      return data;
    } catch (error) {
      renderError(error);
      return null;
    }
  }

  async function open() {
    showModal(true);
    chosenTargets = [];
    multiTouched = false;
    [DOM.upstreams, DOM.local, DOM.zones].forEach((id) => {
      const field = $(id);
      if (field) delete field.dataset.touched;
    });
    const text = $(DOM.status);
    const badge = $(DOM.badge);
    const apply = $(DOM.apply);
    if (text) text.textContent = 'Проверяем текущую конфигурацию…';
    if (badge) badge.textContent = 'Проверка…';
    if (apply) apply.disabled = true;
    await refresh();
  }

  async function apply() {
    if (busy || !status) return;
    const action = (status.enabled || status.can_disable) ? 'disable' : 'enable';
    const labels = (status.candidates || [])
      .filter((item) => item && chosenTargets.indexOf(item.tag) !== -1)
      .map((item) => item.label);
    const routeNote = (action === 'enable' && labels.length)
      ? (labels.length > 1
        ? `DNS будет балансироваться между: ${labels.join(', ')}. `
        : `DNS пойдёт через ${labels[0]}. `)
      : '';
    const question = action === 'enable'
      ? routeNote + 'Панель создаст отдельный DNS-фрагмент, добавит два служебных правила в начало routing, выполнит xray -test, включит DNS override Keenetic, перезапустит Xray и проверит DNS. При любой ошибке всё будет восстановлено.'
      : 'Панель удалит только созданный ей DNS-фрагмент и служебные правила, восстановит исходное состояние DNS override Keenetic и перезапустит Xray.';
    let confirmed = true;
    if (C && typeof C.confirmModal === 'function') {
      confirmed = await C.confirmModal({
        title: action === 'enable' ? 'Включить DNS-over-VLESS?' : 'Отключить DNS-over-VLESS?',
        message: question,
        okText: action === 'enable' ? 'Включить' : 'Отключить',
        cancelText: 'Отмена',
        danger: action === 'disable',
      });
    }
    if (!confirmed) return;

    busy = true;
    render(status);
    try {
      const result = await postAction(action, action === 'enable' ? chosenTargets : []);
      toast(action === 'enable'
        ? `DNS-over-VLESS включён${result.probe && result.probe.latency_ms != null ? ` · DNS ${result.probe.latency_ms} мс` : ''}`
        : 'DNS-over-VLESS отключён, исходная настройка восстановлена.');
      await refresh();
      try { document.dispatchEvent(new CustomEvent('xkeen-routing-fragment-saved', { detail: { reason: 'dns-over-vless' } })); } catch (e) {}
    } catch (error) {
      const data = error && error.data ? error.data : null;
      const message = String((data && data.error) || error.message || 'Операция не выполнена.');
      toast(`${message}${data && data.rolled_back ? ' Предыдущая конфигурация восстановлена.' : ''}`, true);
      await refresh();
    } finally {
      busy = false;
      render(status || {});
    }
  }

  function init() {
    const button = $(IDS.dnsOverVless || 'routing-dns-over-vless-btn');
    if (!button || button.dataset.wired === '1') return;
    button.dataset.wired = '1';
    button.addEventListener('click', (event) => { event.preventDefault(); open(); });
    [DOM.close, DOM.cancel].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener('click', (event) => { event.preventDefault(); showModal(false); });
    });
    const applyButton = $(DOM.apply);
    if (applyButton) applyButton.addEventListener('click', (event) => { event.preventDefault(); apply(); });
    const targetSelect = $(DOM.target);
    if (targetSelect) {
      targetSelect.addEventListener('change', () => {
        chosenTargets = Array.from(targetSelect.selectedOptions || [])
          .map((option) => option.value)
          .filter(Boolean);
        if (status) renderRoute(status);
      });
    }
    [DOM.upstreams, DOM.local, DOM.zones].forEach((id) => {
      const field = $(id);
      if (!field) return;
      field.addEventListener('input', () => {
        field.dataset.touched = '1';
        // Typing a local resolver reveals the zone list straight away.
        if (id === DOM.local && status) renderDnsFields(status);
      });
    });
    const multiBox = $(DOM.multi);
    if (multiBox) {
      multiBox.addEventListener('change', () => {
        // Switching modes drops a selection the other mode cannot express.
        multiTouched = true;
        chosenTargets = [];
        if (status) renderRoute(status);
      });
    }
    const modal = $(DOM.modal);
    if (modal) modal.addEventListener('click', (event) => { if (event.target === modal && !busy) showModal(false); });
    refresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
