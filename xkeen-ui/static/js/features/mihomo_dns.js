import { confirmMihomoAction } from './mihomo_runtime.js';
import { getXkeenCoreHttpApi, toastXkeen } from './xkeen_runtime.js';
import { getMihomoPanelApi } from './mihomo_panel.js';
import { GUARD_RELEASED_BADGE, guardNotice, guardRelease, guardReleaseText } from './dns_guard_text.js';

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
    mode: 'mihomo-dns-mode',
    modeHint: 'mihomo-dns-mode-hint',
    fakeOptions: 'mihomo-dns-fake-options',
    geodataHint: 'mihomo-dns-geodata-hint',
    geodataEnable: 'mihomo-dns-geodata-enable',
    ruleProviders: 'mihomo-dns-rule-providers',
    ruleProvidersHint: 'mihomo-dns-rule-providers-hint',
    providerCategoryRu: 'mihomo-dns-provider-category-ru',
    providerPrivate: 'mihomo-dns-provider-private',
    providerCategoryAi: 'mihomo-dns-provider-category-ai',
    fakeRange: 'mihomo-dns-fake-range',
    fakeFilterMode: 'mihomo-dns-fake-filter-mode',
    fakeFilters: 'mihomo-dns-fake-filters',
    proxyGroup: 'mihomo-dns-proxy-group',
  });

  const $ = (id) => document.getElementById(id);
  let current = null;
  let busy = false;
  let providerSelectionTouched = false;
  const LOCAL_FAKE_IP_FILTERS = ['*.lan', '*.local'];
  const DEFAULT_FAKE_IP_FILTERS = [
    'rule-set:category_ru@domain',
    'rule-set:geosite_private@domain',
    'rule-set:category-ai@domain',
    '+.tsarea.tv',
  ];
  const GEO_FAKE_IP_FILTERS = ['geosite:private', 'geosite:category-ru'];
  const DOMAIN_RULE_PROVIDER_FILTERS = [
    ['category_ru@domain', 'rule-set:category_ru@domain', IDS.providerCategoryRu],
    ['geosite_private@domain', 'rule-set:geosite_private@domain', IDS.providerPrivate],
    ['category-ai@domain', 'rule-set:category-ai@domain', IDS.providerCategoryAi],
  ];
  const RULE_PROVIDER_LABELS = Object.freeze({
    'category_ru@domain': 'RU',
    'geosite_private@domain': 'Private',
    'category-ai@domain': 'AI',
  });

  function selectedRuleProviders() {
    return DOMAIN_RULE_PROVIDER_FILTERS
      .filter(([, , id]) => $(id)?.getAttribute('aria-pressed') === 'true')
      .map(([name]) => name);
  }

  function buildFakeIpFilters(filters, useGeodata, ruleProviders = selectedRuleProviders()) {
    const clean = [];
    const seen = new Set();
    const providerFilters = DOMAIN_RULE_PROVIDER_FILTERS.map(([, filter]) => filter.toLowerCase());
    const remove = new Set(
      [...LOCAL_FAKE_IP_FILTERS, ...DEFAULT_FAKE_IP_FILTERS, ...GEO_FAKE_IP_FILTERS, ...providerFilters].map((item) => item.toLowerCase()),
    );
    const selected = new Set((ruleProviders || []).map((item) => String(item || '').toLowerCase()));
    const preferred = useGeodata
      ? GEO_FAKE_IP_FILTERS
      : DOMAIN_RULE_PROVIDER_FILTERS.filter(([name]) => selected.has(name.toLowerCase())).map(([, filter]) => filter);
    const privateProviderSelected = selected.has('geosite_private@domain');
    const defaults = preferred.length
      ? [...preferred, ...(!useGeodata && !privateProviderSelected ? LOCAL_FAKE_IP_FILTERS : []), '+.tsarea.tv']
      : LOCAL_FAKE_IP_FILTERS;
    for (const item of filters) {
      const text = String(item || '').trim();
      if (!text) continue;
      const lower = text.toLowerCase();
      if (remove.has(lower)) continue;
      if (seen.has(lower)) continue;
      seen.add(lower);
      clean.push(text);
    }
    for (const item of defaults) {
      const lower = item.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      clean.push(item);
    }
    return clean;
  }

  function syncFakeIpFilters(useGeodata) {
    const textarea = $(IDS.fakeFilters);
    if (!textarea) return;
    const current = String(textarea.value || '')
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
    const next = buildFakeIpFilters(current, useGeodata, selectedRuleProviders());
    const nextText = next.join('\n');
    if (textarea.value !== nextText) textarea.value = nextText;
  }

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

  function selectedOptions() {
    const mode = $(IDS.mode)?.value || 'redir-host';
    const payload = { mode, proxy_group: $(IDS.proxyGroup)?.value || undefined };
    if (mode === 'fake-ip') {
      const useGeodata = !!$(IDS.geodataEnable)?.checked;
      const filters = String($(IDS.fakeFilters)?.value || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
      payload.fake_ip = {
        range: $(IDS.fakeRange)?.value || '198.18.0.1/16',
        filter_mode: $(IDS.fakeFilterMode)?.value || 'blacklist',
        filters: buildFakeIpFilters(filters, useGeodata, selectedRuleProviders()),
      };
      payload.geodata = useGeodata;
      payload.rule_providers = useGeodata ? [] : selectedRuleProviders();
    }
    return payload;
  }

  async function postAction(action) {
    const payload = { action, confirmed: true, ...selectedOptions() };
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

  function setRuleProviderButton(id, selected, disabled) {
    const button = $(id);
    if (!button) return;
    button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    button.disabled = !!disabled;
  }

  function syncRuleProviderHighlights() {
    const textarea = $(IDS.fakeFilters);
    if (!textarea) return;
    const filters = new Set(String(textarea.value || '')
      .split(/\r?\n/)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean));
    DOMAIN_RULE_PROVIDER_FILTERS.forEach(([, filter, id]) => {
      setRuleProviderButton(id, filters.has(filter.toLowerCase()), $(id)?.disabled);
    });
  }

  function syncRuleProviderUi(data) {
    const container = $(IDS.ruleProviders);
    const geodataEnabled = !!$(IDS.geodataEnable)?.checked;
    const enabled = !!data?.enabled || !!data?.can_disable || !!data?.tampered;
    if (container) container.classList.toggle('hidden', geodataEnabled);

    if (!providerSelectionTouched && !busy && data) {
      const configured = data?.geodata?.domain_providers || data?.geodata?.rule_providers || {};
      const selected = new Set();
      if (enabled) {
        DOMAIN_RULE_PROVIDER_FILTERS
          .filter(([name]) => configured?.[name]?.configured)
          .forEach(([name]) => selected.add(name));
      } else {
        DOMAIN_RULE_PROVIDER_FILTERS.forEach(([name]) => selected.add(name));
      }
      DOMAIN_RULE_PROVIDER_FILTERS.forEach(([name, , id]) => setRuleProviderButton(id, selected.has(name), false));
    }
    if (!geodataEnabled) syncRuleProviderHighlights();
    DOMAIN_RULE_PROVIDER_FILTERS.forEach(([, , id]) => setRuleProviderButton(
      id,
      $(id)?.getAttribute('aria-pressed') === 'true',
      enabled || geodataEnabled,
    ));

    const selected = selectedRuleProviders();
    const hint = $(IDS.ruleProvidersHint);
    if (hint) {
      if (geodataEnabled) {
        hint.textContent = 'MRS отключены.';
      } else if (selected.length) {
        hint.textContent = `Выбрано: ${selected.map((name) => RULE_PROVIDER_LABELS[name] || name).join(', ')}.`;
      } else {
        hint.textContent = 'Списки не выбраны.';
      }
    }
  }

  function render(data) {
    current = data || null;
    const badge = $(IDS.badge);
    const status = $(IDS.status);
    const list = $(IDS.details);
    const apply = $(IDS.apply);
    const dot = $(IDS.dot);
    const routerNote = document.querySelector('#mihomo-dns-modal .routing-dns-over-vless-links');
    const mode = $(IDS.mode);
    const fakeOptions = $(IDS.fakeOptions);
    const modeHint = $(IDS.modeHint);
    const proxyGroup = $(IDS.proxyGroup);
    const geodata = data?.geodata || null;
    const geodataEnable = $(IDS.geodataEnable);
    if (list) list.textContent = '';

    const enabled = !!data?.enabled;
    const canDisable = !!data?.can_disable;
    const canRecover = !!data?.can_recover;
    const blocked = !enabled && !canDisable && !canRecover && !data?.can_enable;
    const altered = !!data?.tampered;
    const released = !enabled && !!guardRelease(data);
    if (mode && data?.mode && !busy) mode.value = data.mode;
    if (proxyGroup && data?.proxy_groups && !busy) {
      const selected = data.proxy_group || '';
      proxyGroup.textContent = '';
      data.proxy_groups.forEach((name) => {
        const option = document.createElement('option'); option.value = name; option.textContent = name; proxyGroup.appendChild(option);
      });
      if (selected && data.proxy_groups.includes(selected)) proxyGroup.value = selected;
    }
    if (fakeOptions) fakeOptions.classList.toggle('hidden', (mode?.value || data?.mode) !== 'fake-ip');
    if (geodataEnable && !busy && geodata) geodataEnable.checked = !!(geodata.enabled || geodata.geosite_configured);
    syncRuleProviderUi(data);
    if ((mode?.value || data?.mode) === 'fake-ip') syncFakeIpFilters(!!geodataEnable?.checked);
    if (modeHint) modeHint.textContent = (mode?.value || data?.mode) === 'fake-ip'
      ? `${data?.fake_ip_available === false ? 'Нужен TUN/TProxy: прозрачный маршрут не обнаружен.' : 'TUN/TProxy обнаружен.'} Проверьте, что диапазон не пересекается с LAN/VPN.`
      : 'Совместимо с TProxy и большинством устройств LAN.';
    const geodataHint = $(IDS.geodataHint);
    if (geodataHint) {
      const useGeodata = !!geodataEnable?.checked;
      geodataHint.textContent = useGeodata ? 'Фильтры: geosite:private и geosite:category-ru.' : '';
      geodataHint.classList.toggle('hidden', !useGeodata);
      geodataHint.classList.remove('is-warning', 'is-ok');
    }
    if (mode) mode.disabled = enabled || canDisable || altered;
    if (geodataEnable) geodataEnable.disabled = enabled || canDisable || altered;
    if (proxyGroup) proxyGroup.disabled = enabled || canDisable || altered;
    const state = enabled ? 'enabled' : ((canDisable || canRecover || blocked || altered || released) ? 'blocked' : 'ready');
    if (badge) {
      badge.dataset.state = state;
      badge.textContent = enabled
        ? (altered ? 'Включено · изменено вручную' : 'Включено')
        : (released ? GUARD_RELEASED_BADGE : (canRecover ? 'DNS-блок удалён' : (altered ? 'Изменено вручную' : (canDisable ? 'Готово к восстановлению' : (blocked ? 'Требует внимания' : 'Готово')))));
    }
    if (dot) dot.dataset.state = enabled ? 'enabled' : ((blocked || altered || canRecover || released) ? 'blocked' : 'off');
    if (status) {
      if (enabled && altered) status.textContent = 'Защищённый DNS активен, но config.yaml был изменён вручную. Панель видит сохранённый DNS-блок и не станет автоматически откатывать ваши правки.';
      else if (enabled) status.textContent = 'Защищённый DNS активен: Mihomo отвечает на порту 53, а DNS override Keenetic включён.';
      else if (released) status.textContent = guardReleaseText(data);
      else if (canRecover) status.textContent = 'DNS-блок уже удалён вручную, а Keenetic DNS override выключен. Можно сохранить текущий config.yaml и завершить отключение без возврата старого снимка.';
      else if (altered) status.textContent = 'После включения config.yaml был изменён. Панель не станет автоматически перезаписывать эти правки.';
      else if (canDisable) status.textContent = 'DNS-конфигурация подготовлена. Можно безопасно вернуть полный исходный снимок.';
      else if (blocked) status.textContent = 'Автоматическая настройка остановлена, чтобы не затронуть существующий DNS или маршрутизацию.';
      else status.textContent = `После подтверждения панель применит режим ${(mode?.value || 'redir-host')}, проверит YAML, сохранит снимок, запустит Mihomo и протестирует DNS.`;
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
      const listenerConfigured = !!(data.dns_listener_configured || data.enabled || data.prepared || data.can_disable);
      const dnsPresent = !!(data.dns_present || listenerConfigured);
      addDetail(
        listenerConfigured
          ? `DNS-слушатель: ${data.listen || '0.0.0.0:53'} · ${data.mode || 'redir-host'}${altered ? ' · блок сохранён после ручной правки' : ''}`
          : (dnsPresent
            ? 'Раздел dns присутствует, но слушатель на порту 53 в нём не включён'
            : 'DNS-слушатель Mihomo: не активен (раздел dns отсутствует)'),
        listenerConfigured ? 'ok' : 'warn',
      );
      addDetail(`Keenetic DNS override: ${data.dns_override === true ? 'включён' : (data.dns_override === false ? 'выключен' : 'не определён')}`, data.dns_override == null ? 'warn' : 'ok');
      const guard = guardNotice(data, enabled);
      addDetail(guard.text, guard.kind);
      if ((mode?.value || data?.mode) === 'fake-ip' && geodataEnable?.checked && geodata?.notice) {
        addDetail(`GeoSite: ${geodata.notice}`, geodata.private_available ? 'ok' : 'warn');
      }
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
    providerSelectionTouched = false;
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
    $(IDS.mode)?.addEventListener('change', () => {
      const fakeOptions = $(IDS.fakeOptions);
      const fake = $(IDS.mode)?.value === 'fake-ip';
      fakeOptions?.classList.toggle('hidden', !fake);
      if (fake) syncFakeIpFilters(!!$(IDS.geodataEnable)?.checked);
      const hint = $(IDS.modeHint);
      if (hint) hint.textContent = fake
        ? `${current?.fake_ip_available === false ? 'Нужен TUN/TProxy: прозрачный маршрут не обнаружен.' : 'Проверьте наличие TUN/TProxy.'} Диапазон не должен пересекаться с LAN/VPN.`
        : 'Совместимо с TProxy и большинством устройств LAN.';
    });
    $(IDS.geodataEnable)?.addEventListener('change', () => {
      if ($(IDS.mode)?.value === 'fake-ip') syncFakeIpFilters(!!$(IDS.geodataEnable)?.checked);
      syncRuleProviderUi(current || {});
      const hint = $(IDS.geodataHint);
      const enabled = !!$(IDS.geodataEnable)?.checked;
      if (hint) {
        hint.textContent = enabled ? 'Фильтры: geosite:private и geosite:category-ru.' : '';
        hint.classList.toggle('hidden', !enabled);
      }
    });
    DOMAIN_RULE_PROVIDER_FILTERS.forEach(([, , id]) => $(id)?.addEventListener('click', (event) => {
      event.preventDefault();
      if (busy || $(id)?.disabled || $(IDS.geodataEnable)?.checked) return;
      const button = $(id);
      const next = button?.getAttribute('aria-pressed') !== 'true';
      button?.setAttribute('aria-pressed', next ? 'true' : 'false');
      providerSelectionTouched = true;
      if ($(IDS.mode)?.value === 'fake-ip') syncFakeIpFilters(false);
      syncRuleProviderUi(current || {});
    }));
    $(IDS.fakeFilters)?.addEventListener('input', () => {
      providerSelectionTouched = true;
      syncRuleProviderHighlights();
      syncRuleProviderUi(current || {});
    });
    $(IDS.modal)?.addEventListener('click', (event) => {
      if (event.target === $(IDS.modal) && !busy) showModal(false);
    });
    void refresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
