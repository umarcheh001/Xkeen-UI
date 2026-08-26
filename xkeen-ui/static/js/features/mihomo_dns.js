import { confirmMihomoAction } from './mihomo_runtime.js';
import { getXkeenCoreHttpApi, toastXkeen } from './xkeen_runtime.js';
import { getMihomoPanelApi } from './mihomo_panel.js';

/* Guarded, one-click protected DNS assistant for Mihomo. */
(() => {
  'use strict';

  const IDS = Object.freeze({
    button: 'mihomo-dns-btn',
    dot: 'mihomo-dns-dot',
    modal: 'mihomo-dns-modal',
    close: 'mihomo-dns-close',
    cancel: 'mihomo-dns-cancel',
    apply: 'mihomo-dns-apply',
    badge: 'mihomo-dns-badge',
    status: 'mihomo-dns-status',
    details: 'mihomo-dns-details',
  });

  const $ = (id) => document.getElementById(id);
  let current = null;
  let busy = false;

  function showModal(open) {
    const modal = $(IDS.modal);
    if (!modal) return;
    modal.classList.toggle('hidden', !open);
    document.body.classList.toggle('modal-open', !!open);
    if (open) setTimeout(() => { try { $(IDS.cancel)?.focus(); } catch (error) {} }, 0);
  }

  async function requestStatus() {
    const client = getXkeenCoreHttpApi();
    if (client && typeof client.fetchJSON === 'function') {
      return client.fetchJSON('/api/mihomo/dns', { cache: 'no-store', timeoutMs: 15000 });
    }
    const response = await fetch('/api/mihomo/dns', { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { data });
    return data;
  }

  async function postAction(action) {
    const payload = { action, confirmed: true };
    const client = getXkeenCoreHttpApi();
    if (client && typeof client.postJSON === 'function') {
      return client.postJSON('/api/mihomo/dns', payload, { timeoutMs: 120000, retry: 0 });
    }
    const token = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
    const response = await fetch('/api/mihomo/dns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { data });
    return data;
  }

  function addDetail(text, kind) {
    const list = $(IDS.details);
    if (!list || !text) return;
    const item = document.createElement('li');
    item.textContent = String(text);
    if (kind) item.className = `is-${kind}`;
    list.appendChild(item);
  }

  function render(data) {
    current = data || null;
    const badge = $(IDS.badge);
    const status = $(IDS.status);
    const list = $(IDS.details);
    const apply = $(IDS.apply);
    const dot = $(IDS.dot);
    const routerNote = document.querySelector('#mihomo-dns-modal .routing-dns-over-vless-links');
    if (list) list.textContent = '';

    const enabled = !!data?.enabled;
    const canDisable = !!data?.can_disable;
    const canRecover = !!data?.can_recover;
    const blocked = !enabled && !canDisable && !canRecover && !data?.can_enable;
    const altered = !!data?.tampered;
    const state = enabled ? 'enabled' : ((canDisable || canRecover || blocked || altered) ? 'blocked' : 'ready');
    if (badge) {
      badge.dataset.state = state;
      badge.textContent = enabled ? 'Включено' : (canRecover ? 'DNS-блок удалён' : (altered ? 'Изменено вручную' : (canDisable ? 'Готово к восстановлению' : (blocked ? 'Требует внимания' : 'Готово'))));
    }
    if (dot) dot.dataset.state = enabled ? 'enabled' : ((blocked || altered || canRecover) ? 'blocked' : 'off');
    if (status) {
      if (enabled) status.textContent = 'Защищённый DNS активен: Mihomo отвечает на порту 53, а DNS override Keenetic включён.';
      else if (canRecover) status.textContent = 'DNS-блок уже удалён вручную, а Keenetic DNS override выключен. Можно сохранить текущий config.yaml и завершить отключение без возврата старого снимка.';
      else if (altered) status.textContent = 'После включения config.yaml был изменён. Панель не станет автоматически перезаписывать эти правки.';
      else if (canDisable) status.textContent = 'DNS-конфигурация подготовлена. Можно безопасно вернуть полный исходный снимок.';
      else if (blocked) status.textContent = 'Автоматическая настройка остановлена, чтобы не затронуть существующий DNS или маршрутизацию.';
      else status.textContent = 'После подтверждения панель проверит YAML, сохранит снимок, запустит Mihomo и протестирует DNS.';
    }
    if (routerNote) {
      routerNote.textContent = enabled
        ? 'Устройства по‑прежнему используют DNS роутера — Keenetic автоматически направляет запросы в Mihomo.'
        : (canRecover
          ? 'DNS override Keenetic уже выключен — устройства используют системный DNS роутера.'
          : 'Пока защищённый DNS не активен, устройства используют системный DNS Keenetic.');
    }

    if (data) {
      addDetail(`Активное ядро: ${data.active_core || 'не определено'}`, data.active_core === 'mihomo' ? 'ok' : 'warn');
      if (data.proxy_group) addDetail(`Защищённый маршрут: ${data.proxy_group}`, 'ok');
      const listenerActive = !!(data.enabled || data.prepared || data.can_disable);
      addDetail(
        listenerActive
          ? `DNS-слушатель: ${data.listen || '0.0.0.0:53'} · ${data.mode || 'redir-host'}`
          : 'DNS-слушатель Mihomo: не активен (раздел dns отсутствует)',
        listenerActive ? 'ok' : 'warn',
      );
      addDetail(`Keenetic DNS override: ${data.dns_override === true ? 'включён' : (data.dns_override === false ? 'выключен' : 'не определён')}`, data.dns_override == null ? 'warn' : 'ok');
      (data.blockers || []).forEach((message) => addDetail(message, 'warn'));
    }

    if (apply) {
      apply.disabled = busy || (altered && !canRecover) || (!enabled && !canDisable && !canRecover && blocked);
      apply.textContent = busy ? 'Выполняется…' : (canRecover ? 'Сохранить текущий конфиг' : ((enabled || canDisable) ? 'Отключить и восстановить' : 'Включить защищённый DNS'));
      apply.classList.toggle('btn-danger', enabled || canDisable);
      apply.classList.toggle('btn-primary', !enabled && !canDisable);
    }
  }

  function renderError(error) {
    current = null;
    const badge = $(IDS.badge);
    const status = $(IDS.status);
    const apply = $(IDS.apply);
    if (badge) {
      badge.dataset.state = 'blocked';
      badge.textContent = 'Ошибка проверки';
    }
    if (status) status.textContent = String(error?.message || error || 'Не удалось проверить конфигурацию.');
    if (apply) {
      apply.disabled = true;
      apply.textContent = 'Недоступно';
    }
  }

  async function refresh() {
    try {
      const data = await requestStatus();
      render(data);
      return data;
    } catch (error) {
      renderError(error);
      return null;
    }
  }

  async function open() {
    showModal(true);
    if ($(IDS.status)) $(IDS.status).textContent = 'Проверяем текущую конфигурацию…';
    if ($(IDS.badge)) $(IDS.badge).textContent = 'Проверка…';
    if ($(IDS.apply)) $(IDS.apply).disabled = true;
    await refresh();
  }

  async function apply() {
    if (busy || !current) return;
    const recovery = !!current.can_recover;
    const action = (current.enabled || current.can_disable || recovery) ? 'disable' : 'enable';
    const message = recovery
      ? 'DNS-блок уже отсутствует в config.yaml, а DNS override Keenetic выключен. Панель проверит текущий YAML и очистит только устаревшее состояние мастера; ваши ручные правки не будут заменены старым снимком.'
      : action === 'enable'
      ? 'Панель добавит отдельный DNS-блок, направит DoH через выбранную proxy-группу, включит DNS override Keenetic, перезапустит Mihomo и проверит реальный DNS-ответ. При ошибке всё будет восстановлено.'
      : 'Панель вернёт точный снимок config.yaml и исходное состояние DNS Keenetic. Изменяются только объекты однокнопочной настройки.';
    const confirmed = await confirmMihomoAction({
      title: action === 'enable' ? 'Включить защищённый DNS?' : 'Отключить защищённый DNS?',
      message,
      okText: action === 'enable' ? 'Включить' : (recovery ? 'Сохранить текущий конфиг' : 'Восстановить'),
      cancelText: 'Отмена',
      danger: action === 'disable',
    }, message);
    if (!confirmed) return;

    busy = true;
    render(current);
    try {
      const result = await postAction(action);
      toastXkeen(action === 'enable'
        ? `Защищённый DNS включён${result?.probe?.latency_ms != null ? ` · ${result.probe.latency_ms} мс` : ''}`
        : (result?.recovered
          ? 'Старое состояние DNS очищено, текущий config.yaml сохранён.'
          : 'DNS Mihomo отключён, исходная конфигурация восстановлена.'), 'success');
      const panel = getMihomoPanelApi();
      if (panel && typeof panel.reloadFromDiskIfClean === 'function') {
        await panel.reloadFromDiskIfClean();
      }
      await refresh();
    } catch (error) {
      const data = error?.data || null;
      const messageText = String(data?.error || error?.message || 'Операция не выполнена.');
      toastXkeen(`${messageText}${data?.rolled_back ? ' Предыдущая конфигурация восстановлена.' : ''}`, 'error');
      await refresh();
    } finally {
      busy = false;
      render(current || {});
    }
  }

  function init() {
    const button = $(IDS.button);
    if (!button || button.dataset.wired === '1') return;
    button.dataset.wired = '1';
    button.addEventListener('click', (event) => { event.preventDefault(); void open(); });
    [IDS.close, IDS.cancel].forEach((id) => $(id)?.addEventListener('click', (event) => {
      event.preventDefault();
      if (!busy) showModal(false);
    }));
    $(IDS.apply)?.addEventListener('click', (event) => { event.preventDefault(); void apply(); });
    $(IDS.modal)?.addEventListener('click', (event) => {
      if (event.target === $(IDS.modal) && !busy) showModal(false);
    });
    void refresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
