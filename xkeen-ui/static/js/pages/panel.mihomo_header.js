// Presentation only: move existing controls without cloning IDs or handlers.
import { iconHtml, setIcon } from '../ui/operator_icons.js';
let initialized = false;

function releaseHeaderPaintGuard() {
  document.body?.classList.remove('xk-operator-header-pending');
}

export function initPanelOperatorHeader() {
  if (initialized) {
    releaseHeaderPaintGuard();
    return;
  }
  const header = document.querySelector('.panel-header-shell');
  const compactViews = new Set(['routing', 'mihomo', 'xkeen', 'xray-logs', 'commands', 'files']);
  const mihomoView = document.getElementById('view-mihomo');
  if (!header || ![...compactViews].some((name) => document.getElementById(`view-${name}`))) {
    releaseHeaderPaintGuard();
    return;
  }
  initialized = true;
  const byId = (id) => document.getElementById(id);
  const create = (tag, className, text) => {
    const el = document.createElement(tag);
    el.className = className;
    if (text) el.textContent = text;
    return el;
  };
  const menus = [];
  function closeMenus(focus = false) {
    for (const menu of menus) {
      if (focus && !menu.content.hidden) menu.trigger.focus();
      menu.content.hidden = true;
      menu.trigger.setAttribute('aria-expanded', 'false');
    }
  }
  function disclosure(label, id, className = '') {
    const container = create('div', `xk-header-disclosure ${className}`);
    const trigger = create('button', 'btn-secondary xk-header-disclosure-trigger', label);
    trigger.type = 'button';
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', id);
    const content = create('div', 'xk-header-popover');
    content.id = id;
    content.hidden = true;
    container.append(trigger, content);
    const menu = { container, trigger, content };
    menus.push(menu);
    trigger.addEventListener('click', () => {
      const opening = content.hidden;
      closeMenus();
      content.hidden = !opening;
      trigger.setAttribute('aria-expanded', String(opening));
      if (opening) {
        content.style.translate = '';
        const rect = content.getBoundingClientRect();
        const shift = Math.max(12 - rect.left, Math.min(0, document.documentElement.clientWidth - 12 - rect.right));
        content.style.translate = `${shift}px 0`;
      }
    });
    content.addEventListener('click', (event) => {
      if (event.target.closest('a, button:not([aria-expanded])')) closeMenus();
    });
    return menu;
  }
  document.addEventListener('click', (event) => {
    if (!menus.some((menu) => menu.container.contains(event.target))) closeMenus();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menus.some((menu) => !menu.content.hidden)) {
      event.preventDefault();
      closeMenus(true);
    }
  });
  window.addEventListener('resize', () => closeMenus());

  const sections = disclosure('Разделы', 'xk-mihomo-sections-menu', 'xk-operator-shell-only xk-mihomo-shell-only');
  const panel = disclosure('Панель', 'xk-mihomo-panel-menu', 'xk-operator-shell-only xk-mihomo-shell-only');
  setIcon(sections.trigger, 'list-details', { label: 'Разделы' });
  sections.trigger.classList.add('xk-header-sections-trigger');
  setIcon(panel.trigger, 'settings');
  panel.trigger.classList.add('xk-header-panel-trigger');
  panel.trigger.setAttribute('aria-label', 'Настройки панели');
  const service = disclosure('', 'xk-mihomo-service-menu', 'xk-operator-service-menu xk-mihomo-service-menu');
  service.trigger.className = 'xk-brand-service-trigger';
  service.trigger.setAttribute('aria-describedby', 'xkeen-service-text');
  const branding = header.querySelector('.panel-shell-branding');
  branding.append(service.container);
  header.querySelector('.header-main').prepend(sections.container);
  header.querySelector('.header-right').append(panel.container);

  // Compact shell is shared by the panel workspaces without cloning controls.
  // Anchors remain as a safe fallback for integrations that add a legacy view.
  const moves = [];
  function shellMove(node, target) {
    if (!node) return;
    const anchor = document.createComment('operator header: original location');
    node.before(anchor);
    moves.push({ node, target, anchor });
  }
  shellMove(header.querySelector('.header-tabs'), sections.content);
  shellMove(header.querySelector('.header-actions'), panel.content);
  shellMove(header.querySelector('.xkeen-ctrl-group-main'), service.content);
  shellMove(header.querySelector('.global-toggle-right'), service.content);
  shellMove(header.querySelector('.header-center'), service.content);
  shellMove(byId('last-load'), panel.content);
  byId('last-load')?.append(create('span', 'xk-last-activity-menu-label', 'Последняя операция'));

  if (mihomoView) {
    const titleActions = create('div', 'xk-mihomo-operator-actions');
    for (const id of ['mihomo-clash-egress-toggle', 'mihomo-clash-dns-toggle']) {
      if (byId(id)) titleActions.append(byId(id));
    }
    const config = byId('mihomo-clash-tab-config');
    const tabs = mihomoView.querySelector('.xk-mihomo-workspace-tabs');
    tabs?.after(titleActions);
    // Config remains a workspace tab, now owned across the shared toolbar.
    if (tabs && config) tabs.setAttribute('aria-owns', config.id);
    const toolbar = mihomoView.querySelector('.xk-mihomo-groups-toolbar');
    const runtime = byId('mihomo-clash-runtime');
    const controlContent = byId('mihomo-clash-control-content');
    const mode = byId('mihomo-clash-mode-switch');
    const strip = byId('mihomo-clash-status-strip');
    const params = disclosure('Параметры', 'xk-mihomo-parameters-menu');
    params.container.classList.add('xk-mihomo-parameters');
    setIcon(params.trigger, 'settings', { label: 'Параметры' });
    params.trigger.insertAdjacentHTML('beforeend', iconHtml('chevron-down', 'xk-disclosure-chevron'));
    const summary = byId('mihomo-clash-connections-summary');
    const summaryToggle = create('button', 'btn-secondary');
    summaryToggle.id = 'mihomo-clash-connections-summary-toggle';
    summaryToggle.type = 'button';
    summaryToggle.hidden = true;
    summaryToggle.setAttribute('aria-controls', 'mihomo-clash-connections-summary');
    setIcon(summaryToggle, 'statistics', { label: 'Сводка' });
    const summaryStorageKey = 'xkeen:mihomo-clash-connections-summary-visible';
    let summaryVisible = true;
    try { summaryVisible = localStorage.getItem(summaryStorageKey) !== '0'; } catch (_) {}
    function syncSummary() {
      if (summary) summary.hidden = !summaryVisible;
      summaryToggle.setAttribute('aria-expanded', String(summaryVisible));
      summaryToggle.setAttribute('aria-pressed', String(summaryVisible));
      summaryToggle.setAttribute('data-tooltip', summaryVisible ? 'Скрыть сводку соединений' : 'Показать сводку соединений');
    }
    summaryToggle.addEventListener('click', () => {
      summaryVisible = !summaryVisible;
      syncSummary();
      try { localStorage.setItem(summaryStorageKey, summaryVisible ? '1' : '0'); } catch (_) {}
    });
    syncSummary();
    function wrapSelect(select) {
      if (!select) return;
      const field = create('div', 'xk-mihomo-select-field');
      select.before(field);
      field.append(select);
      field.insertAdjacentHTML('beforeend', iconHtml('chevron-down', 'xk-disclosure-chevron'));
    }
    if (toolbar) {
      // Keep configuration reachable when the runtime/control panel is hidden.
      runtime?.before(toolbar);
      const sort = byId('mihomo-clash-groups-sort');
      const configOrder = sort?.querySelector('option[value="config"]');
      if (configOrder) configOrder.textContent = 'Из конфигурации';
      const order = create('label', 'xk-mihomo-toolbar-field');
      order.append(create('span', '', 'Порядок'));
      if (sort) order.append(sort);
      const modeField = create('div', 'xk-mihomo-toolbar-field xk-mihomo-mode-field');
      modeField.append(create('span', '', 'Режим'));
      if (mode) modeField.append(mode);
      toolbar.prepend(modeField, order);
      wrapSelect(sort);
      const latencyPreset = byId('mihomo-clash-latency-preset');
      for (const node of [latencyPreset, toolbar.querySelector('.xk-mihomo-groups-hidden-toggle'), toolbar.querySelector('.xk-mihomo-groups-disconnect-toggle')]) {
        if (node) params.content.append(node);
      }
      wrapSelect(latencyPreset);
      if (strip) params.content.append(strip);
      const search = toolbar.querySelector('.xk-mihomo-groups-search');
      const searchInput = byId('mihomo-clash-groups-filter');
      if (searchInput) searchInput.placeholder = 'Группа, узел или IP';
      if (search) search.after(params.container);
      if (config) params.container.after(config);
      params.container.after(summaryToggle);
      const count = byId('mihomo-clash-groups-count');
      if (count) mihomoView.querySelector('.xk-mihomo-workspace-head').append(count);
      function syncSubview() {
        closeMenus();
        const control = byId('mihomo-clash-tab-control')?.getAttribute('aria-selected') === 'true';
        const configuration = config?.getAttribute('aria-selected') === 'true';
        summaryToggle.hidden = !summary || byId('mihomo-clash-tab-connections')?.getAttribute('aria-selected') !== 'true';
        titleActions.hidden = configuration;
        toolbar.hidden = configuration;
        toolbar.dataset.controlReady = String(control && !controlContent?.hidden);
        if (count) count.hidden = !control;
        if (configuration) {
          // Keep a visible entry point in the tablist while its selected tab is hidden.
          byId('mihomo-clash-tab-control').tabIndex = 0;
          if (toolbar.contains(document.activeElement) || runtime?.contains(document.activeElement)) {
            mihomoView.querySelector('[data-xk-toggle="mihomo-card"]')?.focus({ preventScroll: true });
          }
        }
      }
      if (tabs) new MutationObserver(syncSubview).observe(tabs, { attributes: true, attributeFilter: ['aria-selected'], subtree: true });
      if (config) new MutationObserver(syncSubview).observe(config, { attributes: true, attributeFilter: ['aria-selected'] });
      if (controlContent) new MutationObserver(syncSubview).observe(controlContent, { attributes: true, attributeFilter: ['hidden'] });
      syncSubview();
    }
  }
  function syncService() {
    const state = byId('xkeen-service-lamp')?.dataset.state || 'pending';
    const text = byId('xkeen-service-text')?.textContent.trim() || 'Проверка статуса';
    branding.dataset.serviceState = state;
    service.trigger.setAttribute('aria-label', `Xkeen UI: ${text}. Управление сервисом`);
    service.trigger.setAttribute('data-tooltip', `${text}. Управление сервисом`);
  }
  const lamp = byId('xkeen-service-lamp');
  if (lamp) new MutationObserver(syncService).observe(lamp, { attributes: true });
  const status = byId('xkeen-service-text');
  if (status) new MutationObserver(syncService).observe(status, { childList: true, characterData: true, subtree: true });
  syncService();
  function syncView(name) {
    const focused = (document.activeElement && document.activeElement !== document.body
      && document.activeElement !== document.documentElement) ? document.activeElement : null;
    const active = compactViews.has(name);
    const focusedMove = focused && active
      ? moves.find(({ node }) => node === focused || node.contains(focused))
      : null;
    const focusedMenu = focusedMove
      ? menus.find((menu) => menu.content === focusedMove.target)
      : null;
    closeMenus();
    // A focused legacy control may be moved into a compact-header popover
    // during startup. Keep its destination visible so the browser can retain
    // and restore focus instead of silently falling back to <body>.
    if (focusedMenu) {
      focusedMenu.content.hidden = false;
      focusedMenu.trigger.setAttribute('aria-expanded', 'true');
    }
    document.body.classList.toggle('xk-operator-header-active', active);
    document.body.classList.toggle('xk-routing-header-active', name === 'routing');
    document.body.classList.toggle('xk-mihomo-header-active', name === 'mihomo');
    document.body.classList.toggle('xk-xray-logs-header-active', name === 'xray-logs');
    for (const { node, target, anchor } of moves) {
      if (active && node.parentNode !== target) target.append(node);
      else if (!active && anchor.nextSibling !== node) anchor.after(node);
    }
    if (focused && focused.isConnected && document.activeElement !== focused
      && typeof focused.focus === 'function') {
      try { focused.focus({ preventScroll: true }); } catch (_) {}
    }
    service.trigger.tabIndex = active ? 0 : -1;
  }
  document.addEventListener('xkeen:panel-view-changed', (event) => syncView(event.detail?.view));
  syncView(document.querySelector('.top-tab-btn.active[data-view]')?.dataset.view);
  releaseHeaderPaintGuard();
}

// Kept for integrations that imported the first, Mihomo-specific name.
export const initMihomoOperatorHeader = initPanelOperatorHeader;
