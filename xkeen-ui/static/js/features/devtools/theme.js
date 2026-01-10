(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.features = XK.features || {};

  const SH = (XK.features && XK.features.devtoolsShared) ? XK.features.devtoolsShared : {};
  const toast = SH.toast || function (m) { try { console.log(m); } catch (e) {} };
  const getJSON = SH.getJSON || (async (u) => {
    const r = await fetch(u, { cache: 'no-store' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d && d.error) ? String(d.error) : ('HTTP ' + r.status));
    return d;
  });
  const postJSON = SH.postJSON || (async (u, b) => {
    const r = await fetch(u, { cache: 'no-store', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d && d.error) ? String(d.error) : ('HTTP ' + r.status));
    return d;
  });
  const byId = SH.byId || ((id) => { try { return document.getElementById(id); } catch (e) { return null; } });
  const escapeHtml = SH.escapeHtml || ((s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));

  // --- Theme editor (global custom theme) ---------------------------------
  const _THEME_DEFAULT_CONFIG = {
    font_scale: 1.00,
    mono_scale: 1.00,
    dark: {
      bg: '#0f172a',
      card_bg: '#020617',
      text: '#e5e7eb',
      muted: '#9ca3af',
      accent: '#60a5fa',
      border: '#1f2937',
      // Semantic colors (logs, statuses, validation)
      sem_success: '#22c55e',
      sem_info: '#93c5fd',
      sem_warning: '#fbbf24',
      sem_error: '#f87171',
      sem_debug: '#a1a1aa',
      // Xray logs highlight (token colors)
      log_ts: '#94a3b8',
      log_ip: '#fde68a',
      log_domain: '#6ee7b7',
      log_proto: '#7dd3fc',
      log_port: '#fb923c',
      log_uuid: '#f472b6',
      log_email: '#22d3ee',
      log_inbound: '#818cf8',
      log_outbound: '#f0abfc',
      log_method: '#fbbf24',
      log_path: '#bef264',
      log_sni: '#5eead4',
      log_alpn: '#93c5fd',
      log_route_tproxy_vless: '#22c55e',
      log_route_redirect_vless: '#38bdf8',
      log_route_redirect_direct: '#a855f7',
      log_route_reject: '#f97373',
      // Editor/action buttons (Save/Backup/Restore/etc.)
      editor_btn_bg: '#020617',
      editor_btn_text: '#e5e7eb',
      editor_btn_border: '#1f2937',
      editor_btn_hover_bg: '#020617',
      editor_btn_hover_text: '#e5e7eb',
      editor_btn_hover_border: '#4b5563',
      editor_btn_active_from: '#1d4ed8',
      editor_btn_active_to: '#2563eb',
      header_btn_bg: '#020617',
      header_btn_text: '#e5e7eb',
      header_btn_border: '#374151',
      header_btn_hover_bg: '#020617',
      header_btn_hover_text: '#e5e7eb',
      header_btn_hover_border: '#374151',
      // Modals
      modal_overlay: '#0f172abf',
      modal_bg: '#020617',
      modal_text: '#e5e7eb',
      modal_muted: '#9ca3af',
      modal_body_bg: '#020617',
      modal_body_border: '#1f2937',
      modal_table_head_bg: '#0b1220',
      modal_table_head_text: '#9ca3af',
      modal_table_border: '#1f2937',
      modal_table_row_hover_bg: '#0b1220',
      modal_list_marker: '#9ca3af',
      modal_border: '#334155',
      modal_header_border: '#1f2937',
      modal_close: '#9ca3af',
      modal_close_hover: '#e5e7eb',
      header_tab_bg: '#020617',
      header_tab_text: '#e5e7eb',
      header_tab_border: '#1f2937',
      header_tab_active_bg: '#2563eb',
      header_tab_active_text: '#ffffff',
      // File manager (FM)
      fm_panel_bg: '#020617eb',
      fm_panel_border: '#1f2937',
      fm_panel_bar_bg: '#020617b8',
      fm_panel_bar_border: '#1f293799',
      fm_input_bg: '#020617',
      fm_input_border: '#1f2937',
      fm_row_header_bg: '#0206178c',
      fm_row_header_border: '#1f293799',
      fm_row_hover_bg: '#020617d9',
      fm_row_selected_bg: '#2563eb2e',
      fm_row_focus_outline: '#60a5fa8c',
      fm_props_bg: '#020617d1',
      fm_props_border: '#1f2937',
      fm_menu_bg: '#020617eb',
      fm_menu_border: '#334155',
      fm_menu_item_hover_bg: '#60a5fa1f',
      fm_menu_item_hover_border: '#33415599',
      fm_menu_sep: '#33415599',
      fm_btn_bg: '#020617',
      fm_btn_text: '#e5e7eb',
      fm_btn_border: '#1f2937',
      fm_btn_hover_bg: '#020617',
      fm_btn_hover_text: '#e5e7eb',
      fm_btn_hover_border: '#4b5563',
      fm_btn_active_from: '#1d4ed8',
      fm_btn_active_to: '#2563eb',
      radius: 12,
      shadow: 0.40,
      density: 1.00,
      contrast: 1.00,
    },
    light: {
      bg: '#f5f5f7',
      card_bg: '#ffffff',
      text: '#111827',
      muted: '#4b5563',
      accent: '#0a84ff',
      border: '#d1d5db',
      // Semantic colors (logs, statuses, validation)
      sem_success: '#16a34a',
      sem_info: '#2563eb',
      sem_warning: '#b45309',
      sem_error: '#dc2626',
      sem_debug: '#6b7280',
      // Xray logs highlight (token colors)
      log_ts: '#64748b',
      log_ip: '#a16207',
      log_domain: '#047857',
      log_proto: '#0369a1',
      log_port: '#c2410c',
      log_uuid: '#be185d',
      log_email: '#0e7490',
      log_inbound: '#4338ca',
      log_outbound: '#a21caf',
      log_method: '#92400e',
      log_path: '#3f6212',
      log_sni: '#0f766e',
      log_alpn: '#1d4ed8',
      log_route_tproxy_vless: '#16a34a',
      log_route_redirect_vless: '#0284c7',
      log_route_redirect_direct: '#7c3aed',
      log_route_reject: '#dc2626',
      // Editor/action buttons (Save/Backup/Restore/etc.)
      editor_btn_bg: '#ffffff',
      editor_btn_text: '#111827',
      editor_btn_border: '#d1d5db',
      editor_btn_hover_bg: '#ffffff',
      editor_btn_hover_text: '#111827',
      editor_btn_hover_border: '#4b5563',
      editor_btn_active_from: '#1d4ed8',
      editor_btn_active_to: '#2563eb',
      header_btn_bg: '#ffffff',
      header_btn_text: '#111827',
      header_btn_border: '#d1d5db',
      header_btn_hover_bg: '#ffffff',
      header_btn_hover_text: '#111827',
      header_btn_hover_border: '#d1d5db',
      // Modals
      modal_overlay: '#0f172a59',
      modal_bg: '#ffffff',
      modal_text: '#111827',
      modal_muted: '#6b7280',
      modal_body_bg: '#f9fafb',
      modal_body_border: '#e5e7eb',
      modal_table_head_bg: '#f3f4f6',
      modal_table_head_text: '#6b7280',
      modal_table_border: '#e5e7eb',
      modal_table_row_hover_bg: '#eff6ff',
      modal_list_marker: '#6b7280',
      modal_border: '#d1d5db',
      modal_header_border: '#e5e7eb',
      modal_close: '#6b7280',
      modal_close_hover: '#111827',
      header_tab_bg: '#ffffff',
      header_tab_text: '#111827',
      header_tab_border: '#d1d5db',
      header_tab_active_bg: '#0a84ff',
      header_tab_active_text: '#ffffff',
      // File manager (FM)
      fm_panel_bg: '#ffffffeb',
      fm_panel_border: '#d1d5db',
      fm_panel_bar_bg: '#ffffffb8',
      fm_panel_bar_border: '#d1d5db99',
      fm_input_bg: '#ffffff',
      fm_input_border: '#d1d5db',
      fm_row_header_bg: '#ffffff8c',
      fm_row_header_border: '#d1d5db99',
      fm_row_hover_bg: '#ffffffd9',
      fm_row_selected_bg: '#0a84ff2e',
      fm_row_focus_outline: '#0a84ff8c',
      fm_props_bg: '#ffffffd1',
      fm_props_border: '#d1d5db',
      fm_menu_bg: '#ffffffeb',
      fm_menu_border: '#d1d5db',
      fm_menu_item_hover_bg: '#0a84ff1f',
      fm_menu_item_hover_border: '#d1d5db99',
      fm_menu_sep: '#d1d5db99',
      fm_btn_bg: '#ffffff',
      fm_btn_text: '#111827',
      fm_btn_border: '#d1d5db',
      fm_btn_hover_bg: '#ffffff',
      fm_btn_hover_text: '#111827',
      fm_btn_hover_border: '#4b5563',
      fm_btn_active_from: '#1d4ed8',
      fm_btn_active_to: '#2563eb',
      radius: 12,
      shadow: 0.08,
      density: 1.00,
      contrast: 1.00,
    },
  };

  let _themeCfg = JSON.parse(JSON.stringify(_THEME_DEFAULT_CONFIG));
  let _themeSelected = 'dark';
  let _themeMeta = { exists: false, version: 0 };
  let _themeLoaded = false;
  let _themePreviewEl = null;

  const _THEME_COLOR_FIELDS = [
    { key: 'bg', id: 'bg' },
    { key: 'card_bg', id: 'card-bg' },
    { key: 'text', id: 'text' },
    { key: 'muted', id: 'muted' },
    { key: 'accent', id: 'accent' },
    { key: 'border', id: 'border' },
    { key: 'sem_success', id: 'sem-success' },
    { key: 'sem_info', id: 'sem-info' },
    { key: 'sem_warning', id: 'sem-warning' },
    { key: 'sem_error', id: 'sem-error' },
    { key: 'sem_debug', id: 'sem-debug' },
    { key: 'log_ts', id: 'log-ts' },
    { key: 'log_ip', id: 'log-ip' },
    { key: 'log_domain', id: 'log-domain' },
    { key: 'log_proto', id: 'log-proto' },
    { key: 'log_port', id: 'log-port' },
    { key: 'log_uuid', id: 'log-uuid' },
    { key: 'log_email', id: 'log-email' },
    { key: 'log_inbound', id: 'log-inbound' },
    { key: 'log_outbound', id: 'log-outbound' },
    { key: 'log_method', id: 'log-method' },
    { key: 'log_path', id: 'log-path' },
    { key: 'log_sni', id: 'log-sni' },
    { key: 'log_alpn', id: 'log-alpn' },
    { key: 'log_route_tproxy_vless', id: 'log-route-tproxy-vless' },
    { key: 'log_route_redirect_vless', id: 'log-route-redirect-vless' },
    { key: 'log_route_redirect_direct', id: 'log-route-redirect-direct' },
    { key: 'log_route_reject', id: 'log-route-reject' },
    { key: 'editor_btn_bg', id: 'editor-btn-bg' },
    { key: 'editor_btn_text', id: 'editor-btn-text' },
    { key: 'editor_btn_border', id: 'editor-btn-border' },
    { key: 'editor_btn_hover_bg', id: 'editor-btn-hover-bg' },
    { key: 'editor_btn_hover_text', id: 'editor-btn-hover-text' },
    { key: 'editor_btn_hover_border', id: 'editor-btn-hover-border' },
    { key: 'editor_btn_active_from', id: 'editor-btn-active-from' },
    { key: 'editor_btn_active_to', id: 'editor-btn-active-to' },
    { key: 'header_btn_bg', id: 'header-btn-bg' },
    { key: 'header_btn_text', id: 'header-btn-text' },
    { key: 'header_btn_border', id: 'header-btn-border' },
    { key: 'header_btn_hover_bg', id: 'header-btn-hover-bg' },
    { key: 'header_btn_hover_text', id: 'header-btn-hover-text' },
    { key: 'header_btn_hover_border', id: 'header-btn-hover-border' },
    { key: 'modal_overlay', id: 'modal-overlay' },
    { key: 'modal_bg', id: 'modal-bg' },
    { key: 'modal_text', id: 'modal-text' },
    { key: 'modal_muted', id: 'modal-muted' },
    { key: 'modal_body_bg', id: 'modal-body-bg' },
    { key: 'modal_body_border', id: 'modal-body-border' },
    { key: 'modal_table_head_bg', id: 'modal-table-head-bg' },
    { key: 'modal_table_head_text', id: 'modal-table-head-text' },
    { key: 'modal_table_border', id: 'modal-table-border' },
    { key: 'modal_table_row_hover_bg', id: 'modal-table-row-hover-bg' },
    { key: 'modal_list_marker', id: 'modal-list-marker' },
    { key: 'modal_border', id: 'modal-border' },
    { key: 'modal_header_border', id: 'modal-header-border' },
    { key: 'modal_close', id: 'modal-close' },
    { key: 'modal_close_hover', id: 'modal-close-hover' },
    { key: 'header_tab_bg', id: 'header-tab-bg' },
    { key: 'header_tab_text', id: 'header-tab-text' },
    { key: 'header_tab_border', id: 'header-tab-border' },
    { key: 'header_tab_active_bg', id: 'header-tab-active-bg' },
    { key: 'header_tab_active_text', id: 'header-tab-active-text' },
    // File manager (FM)
    { key: 'fm_panel_bg', id: 'fm-panel-bg' },
    { key: 'fm_panel_border', id: 'fm-panel-border' },
    { key: 'fm_panel_bar_bg', id: 'fm-panel-bar-bg' },
    { key: 'fm_panel_bar_border', id: 'fm-panel-bar-border' },
    { key: 'fm_input_bg', id: 'fm-input-bg' },
    { key: 'fm_input_border', id: 'fm-input-border' },
    { key: 'fm_row_header_bg', id: 'fm-row-header-bg' },
    { key: 'fm_row_header_border', id: 'fm-row-header-border' },
    { key: 'fm_row_hover_bg', id: 'fm-row-hover-bg' },
    { key: 'fm_row_selected_bg', id: 'fm-row-selected-bg' },
    { key: 'fm_row_focus_outline', id: 'fm-row-focus-outline' },
    { key: 'fm_props_bg', id: 'fm-props-bg' },
    { key: 'fm_props_border', id: 'fm-props-border' },
    { key: 'fm_menu_bg', id: 'fm-menu-bg' },
    { key: 'fm_menu_border', id: 'fm-menu-border' },
    { key: 'fm_menu_item_hover_bg', id: 'fm-menu-item-hover-bg' },
    { key: 'fm_menu_item_hover_border', id: 'fm-menu-item-hover-border' },
    { key: 'fm_menu_sep', id: 'fm-menu-sep' },
    { key: 'fm_btn_bg', id: 'fm-btn-bg' },
    { key: 'fm_btn_text', id: 'fm-btn-text' },
    { key: 'fm_btn_border', id: 'fm-btn-border' },
    { key: 'fm_btn_hover_bg', id: 'fm-btn-hover-bg' },
    { key: 'fm_btn_hover_text', id: 'fm-btn-hover-text' },
    { key: 'fm_btn_hover_border', id: 'fm-btn-hover-border' },
    { key: 'fm_btn_active_from', id: 'fm-btn-active-from' },
    { key: 'fm_btn_active_to', id: 'fm-btn-active-to' },
  ];

  // Global theme: variables that are expected to be semi-transparent.
  // We show an opacity slider for them (and also auto-enable it for any field
  // that uses the #RRGGBBAA format).
  const _THEME_ALPHA_KEYS = new Set(['modal_overlay', 'fm_panel_bg', 'fm_panel_bar_bg', 'fm_row_header_bg', 'fm_row_hover_bg', 'fm_row_selected_bg', 'fm_props_bg', 'fm_menu_bg', 'fm_menu_item_hover_bg', 'fm_btn_bg', 'fm_btn_hover_bg']);
  const _themeAlphaUi = Object.create(null);

  // Short tooltips for color editors (no long help text in UI)
  const _THEME_TOOLTIPS = {
    '--bg': 'Фон страницы',
    '--card-bg': 'Фон карточек/панелей',
    '--text': 'Основной текст',
    '--muted': 'Вторичный текст / подсказки',
    '--accent': 'Акцент (ссылки, активные элементы)',
    '--border': 'Цвет границ',
    '--sem-success': 'Семантика: успех / OK',
    '--sem-info': 'Семантика: info',
    '--sem-warning': 'Семантика: предупреждение',
    '--sem-error': 'Семантика: ошибка / danger',
    '--sem-debug': 'Семантика: debug / muted',
    '--log-ts': 'Xray логи: timestamp / время',
    '--log-ip': 'Xray логи: IP адреса',
    '--log-domain': 'Xray логи: домены (хосты)',
    '--log-proto': 'Xray логи: протокол/transport (tcp/udp/ws/grpc/...)',
    '--log-port': 'Xray логи: порты (:443, port=443)',
    '--log-uuid': 'Xray логи: UUID / id',
    '--log-email': 'Xray логи: email (user@domain)',
    '--log-inbound': 'Xray логи: inbound tag',
    '--log-outbound': 'Xray логи: outbound tag',
    '--log-method': 'Xray логи: HTTP method (GET/POST...)',
    '--log-path': 'Xray логи: path/uri/url',
    '--log-sni': 'Xray логи: SNI / serverName',
    '--log-alpn': 'Xray логи: ALPN',
    '--log-route-tproxy-vless': 'Xray логи: [tproxy -> vless-reality]',
    '--log-route-redirect-vless': 'Xray логи: [redirect -> vless-reality]',
    '--log-route-redirect-direct': 'Xray логи: [redirect -> direct]',
    '--log-route-reject': 'Xray логи: reject',
    '--editor-btn-bg': 'Кнопки в редакторах: фон',
    '--editor-btn-text': 'Кнопки в редакторах: текст',
    '--editor-btn-border': 'Кнопки в редакторах: рамка',
    '--editor-btn-hover-bg': 'Кнопки: hover (фон)',
    '--editor-btn-hover-text': 'Кнопки: hover (текст)',
    '--editor-btn-hover-border': 'Кнопки: hover (рамка)',
    '--editor-btn-active-from': 'Кнопки: нажатие (градиент 1)',
    '--editor-btn-active-to': 'Кнопки: нажатие (градиент 2)',
    '--header-btn-bg': 'Шапка: кнопки (фон)',
    '--header-btn-text': 'Шапка: кнопки (текст)',
    '--header-btn-border': 'Шапка: кнопки (рамка)',
    '--header-btn-hover-bg': 'Шапка: кнопки hover (фон)',
    '--header-btn-hover-text': 'Шапка: кнопки hover (текст)',
    '--header-btn-hover-border': 'Шапка: кнопки hover (рамка)',
    '--modal-overlay': 'Модальное окно: фон/затемнение',
    '--modal-bg': 'Модальное окно: фон окна',
    '--modal-text': 'Модальное окно: текст',
    '--modal-muted': 'Модальное окно: вторичный текст',
    '--modal-body-bg': 'Модальное окно: фон body',
    '--modal-body-border': 'Модальное окно: рамка body',
    '--modal-table-head-bg': 'Модалка: таблица (шапка фон)',
    '--modal-table-head-text': 'Модалка: таблица (шапка текст)',
    '--modal-table-border': 'Модалка: таблица (границы)',
    '--modal-table-row-hover-bg': 'Модалка: таблица (hover)',
    '--modal-list-marker': 'Модалка: списки (маркер)',
    '--modal-border': 'Модальное окно: рамка',
    '--modal-header-border': 'Модальное окно: разделитель заголовка',
    '--modal-close': 'Модальное окно: крестик',
    '--modal-close-hover': 'Модальное окно: крестик hover',
    '--header-tab-bg': 'Шапка: вкладки (фон)',
    '--header-tab-text': 'Шапка: вкладки (текст)',
    '--header-tab-border': 'Шапка: вкладки (рамка)',
    '--header-tab-active-bg': 'Шапка: активная вкладка (фон)',
    '--header-tab-active-text': 'Шапка: активная вкладка (текст)',
    '--fm-panel-bg': 'ФМ: фон панели (список/каталог)',
    '--fm-panel-border': 'ФМ: граница панели',
    '--fm-panel-bar-bg': 'ФМ: фон верхней панели (toolbar)',
    '--fm-panel-bar-border': 'ФМ: граница toolbar',
    '--fm-input-bg': 'ФМ: фон полей ввода (путь/фильтр)',
    '--fm-input-border': 'ФМ: граница полей ввода',
    '--fm-row-header-bg': 'ФМ: фон заголовка таблицы',
    '--fm-row-header-border': 'ФМ: граница заголовка таблицы',
    '--fm-row-hover-bg': 'ФМ: строка — hover',
    '--fm-row-selected-bg': 'ФМ: строка — выделение',
    '--fm-row-focus-outline': 'ФМ: строка — фокус (outline)',
    '--fm-props-bg': 'ФМ: фон блока «Свойства»',
    '--fm-props-border': 'ФМ: граница блока «Свойства»',
    '--fm-menu-bg': 'ФМ: контекстное меню — фон',
    '--fm-menu-border': 'ФМ: контекстное меню — граница',
    '--fm-menu-item-hover-bg': 'ФМ: контекстное меню — hover',
    '--fm-menu-item-hover-border': 'ФМ: контекстное меню — рамка hover',
    '--fm-menu-sep': 'ФМ: контекстное меню — разделитель',
    '--fm-btn-bg': 'ФМ: кнопки — фон',
    '--fm-btn-text': 'ФМ: кнопки — текст',
    '--fm-btn-border': 'ФМ: кнопки — граница',
    '--fm-btn-hover-bg': 'ФМ: кнопки — hover фон',
    '--fm-btn-hover-text': 'ФМ: кнопки — hover текст',
    '--fm-btn-hover-border': 'ФМ: кнопки — hover граница',
    '--fm-btn-active-from': 'ФМ: кнопки — active градиент (from)',
    '--fm-btn-active-to': 'ФМ: кнопки — active градиент (to)',

  };

  function _themeWireTooltips() {
    const card = byId('dt-theme-editor-card');
    if (!card) return;
    const fields = card.querySelectorAll('.dt-theme-grid .dt-theme-field');
    fields.forEach((el) => {
      const nameEl = el.querySelector('.dt-theme-name');
      if (!nameEl) return;
      const key = String(nameEl.textContent || '').trim();
      const tip = _THEME_TOOLTIPS[key];
      if (!tip) return;
      try {
        el.classList.add('xk-tooltip');
        el.setAttribute('data-tooltip', tip);
      } catch (e) {}
    });
  }

  function _isHexColor(s) {
    if (!s) return false;
    const v = String(s).trim();
    return /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?([0-9a-fA-F]{2})?$/.test(v);
  }

  function _expandShortHex(v) {
    const s = String(v || '').trim();
    if (/^#[0-9a-fA-F]{3}$/.test(s)) {
      return ('#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]).toLowerCase();
    }
    return s.toLowerCase();
  }

  function _toColorPickerValue(v) {
    // <input type=color> expects #RRGGBB. Drop alpha if present.
    if (!_isHexColor(v)) return '#000000';
    let s = _expandShortHex(v);
    if (s.length === 9) s = s.slice(0, 7);
    if (s.length !== 7) return '#000000';
    return s;
  }

  function _parseHexWithAlpha(v) {
    const s = String(v || '').trim();
    if (/^#[0-9a-fA-F]{3}$/.test(s)) {
      return { hex6: _expandShortHex(s), a: 255, hasAlpha: false };
    }
    if (/^#[0-9a-fA-F]{6}$/.test(s)) {
      return { hex6: s.toLowerCase(), a: 255, hasAlpha: false };
    }
    if (/^#[0-9a-fA-F]{8}$/.test(s)) {
      return { hex6: s.slice(0, 7).toLowerCase(), a: parseInt(s.slice(7, 9), 16), hasAlpha: true };
    }
    return null;
  }

  function _hex8(hex6, a) {
    const to2 = (n) => {
      const x = Math.max(0, Math.min(255, Math.round(Number(n) || 0)));
      const h = x.toString(16);
      return (h.length === 1) ? ('0' + h) : h;
    };
    const base = String(hex6 || '').trim();
    const h6 = (/^#[0-9a-fA-F]{6}$/.test(base) ? base : '#000000').toLowerCase();
    return h6 + to2(a);
  }

  function _themeEnsureAlphaRow(field, c, tx) {
    if (!field) return null;
    const key = field.key;
    if (!key) return null;

    // Reuse if already created.
    if (_themeAlphaUi[key]) {
      try {
        _themeAlphaUi[key].c = c || _themeAlphaUi[key].c;
        _themeAlphaUi[key].tx = tx || _themeAlphaUi[key].tx;
      } catch (e) {}
      return _themeAlphaUi[key];
    }

    const fieldWrap = (tx && tx.closest) ? tx.closest('.dt-theme-field') : ((c && c.closest) ? c.closest('.dt-theme-field') : null);
    if (!fieldWrap) return null;

    const row = document.createElement('div');
    row.className = 'dt-theme-alpha';
    row.style.display = 'none';

    const n = document.createElement('div');
    n.className = 'dt-theme-alpha-name';
    n.textContent = 'Opacity';

    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = '100';
    range.step = '1';

    const val = document.createElement('div');
    val.className = 'dt-theme-alpha-val';

    row.appendChild(n);
    row.appendChild(range);
    row.appendChild(val);
    fieldWrap.appendChild(row);

    const ui = {
      wrap: row,
      range,
      val,
      aByte: 255,
      wantAlpha: false,
      c,
      tx,
      key,
    };

    ui.show = (on) => {
      try { ui.wrap.style.display = on ? 'flex' : 'none'; } catch (e) {}
    };

    ui.sync = () => {
      try {
        const pct = Math.max(0, Math.min(100, Math.round((ui.aByte / 255) * 100)));
        ui.range.value = String(pct);
        ui.val.textContent = String(pct) + '%';
      } catch (e) {}
    };

    range.addEventListener('input', () => {
      ui.wantAlpha = true;
      ui.show(true);

      const pct = Math.max(0, Math.min(100, parseInt(range.value, 10) || 0));
      ui.aByte = Math.round((pct / 100) * 255);
      ui.sync();

      const base = ui.c ? _toColorPickerValue(ui.c.value) : (ui.tx ? _toColorPickerValue(ui.tx.value) : '#000000');
      const h8 = _hex8(base, ui.aByte);

      try { if (ui.tx) ui.tx.value = h8; } catch (e) {}
      _themeUpdateState(ui.key, h8);
      _themeApplyPreview();
    });

    _themeAlphaUi[key] = ui;
    return ui;
  }

  function _themeSyncAlphaRow(field, c, tx, value) {
    const key = field && field.key ? field.key : null;
    if (!key) return;

    const p = _parseHexWithAlpha(value);
    const forced = _THEME_ALPHA_KEYS.has(key);
    const existing = _themeAlphaUi[key];
    const want = !!(forced || (existing && existing.wantAlpha) || (p && p.hasAlpha));

    if (!want) {
      if (existing) {
        existing.wantAlpha = false;
        existing.aByte = 255;
        existing.show(false);
      }
      return;
    }

    const ui = _themeEnsureAlphaRow(field, c, tx);
    if (!ui) return;

    ui.wantAlpha = true;
    ui.aByte = p ? p.a : (ui.aByte || 255);
    ui.show(true);
    ui.sync();
  }

  function _setCustomThemeLinkVersion(version) {
    const link = document.getElementById('xk-custom-theme-link');
    if (!link) return;
    try {
      const u = new URL(link.getAttribute('href') || link.href || '', window.location.href);
      u.searchParams.set('v', String(version || 0));
      link.href = u.toString();
    } catch (e) {
      // ignore
    }
  }

  function _themeStatus(msg, isErr) {
    const el = byId('dt-theme-status');
    if (!el) return;
    try {
      el.textContent = msg || '';
      el.style.color = isErr ? 'var(--sem-error, #fca5a5)' : '';
    } catch (e) {
      el.textContent = msg || '';
    }
  }

  function _themeSetSelected(theme) {
    const t = theme === 'light' ? 'light' : 'dark';
    _themeSelected = t;

    const bDark = byId('dt-theme-target-dark');
    const bLight = byId('dt-theme-target-light');

    if (bDark) {
      bDark.classList.toggle('active', t === 'dark');
      bDark.setAttribute('aria-selected', t === 'dark' ? 'true' : 'false');
    }
    if (bLight) {
      bLight.classList.toggle('active', t === 'light');
      bLight.setAttribute('aria-selected', t === 'light' ? 'true' : 'false');
    }

    _themeSyncUiFromState();
  }

  function _themeSyncUiFromState() {
    const t = _themeSelected;
    const cfg = (_themeCfg && _themeCfg[t]) ? _themeCfg[t] : {};

    for (const f of _THEME_COLOR_FIELDS) {
      const c = byId(`dt-theme-${f.id}-color`);
      const tx = byId(`dt-theme-${f.id}-text`);
      const v = cfg[f.key];
      if (c) {
        try { c.value = _toColorPickerValue(v); } catch (e) {}
      }
      if (tx) {
        try { tx.value = String(v || ''); } catch (e) {}
      }

      // Opacity sliders (only for a few keys or when value uses #RRGGBBAA).
      try { _themeSyncAlphaRow(f, c, tx, v); } catch (e) {}
    }

    const radius = byId('dt-theme-radius');
    const shadow = byId('dt-theme-shadow');
    const density = byId('dt-theme-density');
    const contrast = byId('dt-theme-contrast');

    const fontScale = byId('dt-theme-font-scale');
    const monoScale = byId('dt-theme-mono-scale');

    const rv = byId('dt-theme-radius-val');
    const sv = byId('dt-theme-shadow-val');
    const dv = byId('dt-theme-density-val');
    const cv = byId('dt-theme-contrast-val');

    const fsv = byId('dt-theme-font-scale-val');
    const msv = byId('dt-theme-mono-scale-val');

    if (radius) { try { radius.value = String(cfg.radius ?? 12); } catch (e) {} }
    if (shadow) { try { shadow.value = String(cfg.shadow ?? 0.4); } catch (e) {} }
    if (density) { try { density.value = String(cfg.density ?? 1.0); } catch (e) {} }
    if (contrast) { try { contrast.value = String(cfg.contrast ?? 1.0); } catch (e) {} }

    const gFontScaleRaw = Number((_themeCfg && typeof _themeCfg.font_scale !== 'undefined') ? _themeCfg.font_scale : (_THEME_DEFAULT_CONFIG.font_scale ?? 1.0));
    const gMonoScaleRaw = Number((_themeCfg && typeof _themeCfg.mono_scale !== 'undefined') ? _themeCfg.mono_scale : (_THEME_DEFAULT_CONFIG.mono_scale ?? 1.0));
    const gFontScale = Number.isFinite(gFontScaleRaw) ? gFontScaleRaw : 1.0;
    const gMonoScale = Number.isFinite(gMonoScaleRaw) ? gMonoScaleRaw : 1.0;

    if (fontScale) { try { fontScale.value = String(gFontScale); } catch (e) {} }
    if (monoScale) { try { monoScale.value = String(gMonoScale); } catch (e) {} }

    if (rv) rv.textContent = `${parseInt(cfg.radius ?? 12, 10)}px`;
    if (sv) sv.textContent = `${Number(cfg.shadow ?? 0.4).toFixed(2)}`;
    if (dv) dv.textContent = `${Number(cfg.density ?? 1.0).toFixed(2)}`;
    if (cv) cv.textContent = `${Number(cfg.contrast ?? 1.0).toFixed(2)}`;

    if (fsv) fsv.textContent = `${gFontScale.toFixed(2)}`;
    if (msv) msv.textContent = `${gMonoScale.toFixed(2)}`;
  }

  function _themeUpdateState(key, val) {
    if (!_themeCfg[_themeSelected]) _themeCfg[_themeSelected] = {};
    _themeCfg[_themeSelected][key] = val;
  }

  function _themeRadiusSm(r) {
    const x = Math.round(Number(r || 12) * 0.75);
    return Math.max(4, Math.min(24, x));
  }

  function _themeBuildCss(cfg) {
    const d = cfg && cfg.dark ? cfg.dark : _THEME_DEFAULT_CONFIG.dark;
    const l = cfg && cfg.light ? cfg.light : _THEME_DEFAULT_CONFIG.light;

    const fsRaw = Number((cfg && typeof cfg.font_scale !== 'undefined') ? cfg.font_scale : (_THEME_DEFAULT_CONFIG.font_scale ?? 1.0));
    const msRaw = Number((cfg && typeof cfg.mono_scale !== 'undefined') ? cfg.mono_scale : (_THEME_DEFAULT_CONFIG.mono_scale ?? 1.0));
    const fs = Number.isFinite(fsRaw) ? fsRaw : 1.0;
    const ms = Number.isFinite(msRaw) ? msRaw : 1.0;

    const dRs = _themeRadiusSm(d.radius);
    const lRs = _themeRadiusSm(l.radius);

    const lines = [];
    lines.push('/* Preview layer (not saved) — Xkeen UI DevTools Theme Editor */');
    lines.push(':root {');
    lines.push(`  --xk-font-scale: ${fs};`);
    lines.push(`  --xk-mono-font-scale: ${ms};`);
    lines.push(`  --bg: ${d.bg};`);
    lines.push(`  --card-bg: ${d.card_bg};`);
    lines.push(`  --text: ${d.text};`);
    lines.push(`  --muted: ${d.muted};`);
    lines.push(`  --accent: ${d.accent};`);
    lines.push(`  --border: ${d.border};`);
    // File manager (FM)
    lines.push(`  --fm-panel-bg: ${d.fm_panel_bg};`);
    lines.push(`  --fm-panel-border: ${d.fm_panel_border};`);
    lines.push(`  --fm-panel-bar-bg: ${d.fm_panel_bar_bg};`);
    lines.push(`  --fm-panel-bar-border: ${d.fm_panel_bar_border};`);
    lines.push(`  --fm-input-bg: ${d.fm_input_bg};`);
    lines.push(`  --fm-input-border: ${d.fm_input_border};`);
    lines.push(`  --fm-row-header-bg: ${d.fm_row_header_bg};`);
    lines.push(`  --fm-row-header-border: ${d.fm_row_header_border};`);
    lines.push(`  --fm-row-hover-bg: ${d.fm_row_hover_bg};`);
    lines.push(`  --fm-row-selected-bg: ${d.fm_row_selected_bg};`);
    lines.push(`  --fm-row-focus-outline: ${d.fm_row_focus_outline};`);
    lines.push(`  --fm-props-bg: ${d.fm_props_bg};`);
    lines.push(`  --fm-props-border: ${d.fm_props_border};`);
    lines.push(`  --fm-menu-bg: ${d.fm_menu_bg};`);
    lines.push(`  --fm-menu-border: ${d.fm_menu_border};`);
    lines.push(`  --fm-menu-item-hover-bg: ${d.fm_menu_item_hover_bg};`);
    lines.push(`  --fm-menu-item-hover-border: ${d.fm_menu_item_hover_border};`);
    lines.push(`  --fm-menu-sep: ${d.fm_menu_sep};`);
    lines.push(`  --fm-btn-bg: ${d.fm_btn_bg};`);
    lines.push(`  --fm-btn-text: ${d.fm_btn_text};`);
    lines.push(`  --fm-btn-border: ${d.fm_btn_border};`);
    lines.push(`  --fm-btn-hover-bg: ${d.fm_btn_hover_bg};`);
    lines.push(`  --fm-btn-hover-text: ${d.fm_btn_hover_text};`);
    lines.push(`  --fm-btn-hover-border: ${d.fm_btn_hover_border};`);
    lines.push(`  --fm-btn-active-from: ${d.fm_btn_active_from};`);
    lines.push(`  --fm-btn-active-to: ${d.fm_btn_active_to};`);

    lines.push(`  --sem-success: ${d.sem_success};`);
    lines.push(`  --sem-info: ${d.sem_info};`);
    lines.push(`  --sem-warning: ${d.sem_warning};`);
    lines.push(`  --sem-error: ${d.sem_error};`);
    lines.push(`  --sem-debug: ${d.sem_debug};`);
    lines.push(`  --log-ts: ${d.log_ts};`);
    lines.push(`  --log-ip: ${d.log_ip};`);
    lines.push(`  --log-domain: ${d.log_domain};`);
    lines.push(`  --log-proto: ${d.log_proto};`);
    lines.push(`  --log-port: ${d.log_port};`);
    lines.push(`  --log-uuid: ${d.log_uuid};`);
    lines.push(`  --log-email: ${d.log_email};`);
    lines.push(`  --log-inbound: ${d.log_inbound};`);
    lines.push(`  --log-outbound: ${d.log_outbound};`);
    lines.push(`  --log-method: ${d.log_method};`);
    lines.push(`  --log-path: ${d.log_path};`);
    lines.push(`  --log-sni: ${d.log_sni};`);
    lines.push(`  --log-alpn: ${d.log_alpn};`);
    lines.push(`  --log-route-tproxy-vless: ${d.log_route_tproxy_vless};`);
    lines.push(`  --log-route-redirect-vless: ${d.log_route_redirect_vless};`);
    lines.push(`  --log-route-redirect-direct: ${d.log_route_redirect_direct};`);
    lines.push(`  --log-route-reject: ${d.log_route_reject};`);
    lines.push(`  --editor-btn-bg: ${d.editor_btn_bg};`);
    lines.push(`  --editor-btn-text: ${d.editor_btn_text};`);
    lines.push(`  --editor-btn-border: ${d.editor_btn_border};`);
    lines.push(`  --editor-btn-hover-bg: ${d.editor_btn_hover_bg};`);
    lines.push(`  --editor-btn-hover-text: ${d.editor_btn_hover_text};`);
    lines.push(`  --editor-btn-hover-border: ${d.editor_btn_hover_border};`);
    lines.push(`  --editor-btn-border-hover: ${d.editor_btn_hover_border};`);
    lines.push(`  --editor-btn-active-from: ${d.editor_btn_active_from};`);
    lines.push(`  --editor-btn-active-to: ${d.editor_btn_active_to};`);
    lines.push(`  --header-btn-bg: ${d.header_btn_bg};`);
    lines.push(`  --header-btn-text: ${d.header_btn_text};`);
    lines.push(`  --header-btn-border: ${d.header_btn_border};`);
    lines.push(`  --header-btn-hover-bg: ${d.header_btn_hover_bg};`);
    lines.push(`  --header-btn-hover-text: ${d.header_btn_hover_text};`);
    lines.push(`  --header-btn-hover-border: ${d.header_btn_hover_border};`);
    lines.push(`  --modal-overlay: ${d.modal_overlay};`);
    lines.push(`  --modal-bg: ${d.modal_bg};`);
    lines.push(`  --modal-text: ${d.modal_text};`);
    lines.push(`  --modal-muted: ${d.modal_muted};`);
    lines.push(`  --modal-body-bg: ${d.modal_body_bg};`);
    lines.push(`  --modal-body-border: ${d.modal_body_border};`);
    lines.push(`  --modal-table-head-bg: ${d.modal_table_head_bg};`);
    lines.push(`  --modal-table-head-text: ${d.modal_table_head_text};`);
    lines.push(`  --modal-table-border: ${d.modal_table_border};`);
    lines.push(`  --modal-table-row-hover-bg: ${d.modal_table_row_hover_bg};`);
    lines.push(`  --modal-list-marker: ${d.modal_list_marker};`);
    lines.push(`  --modal-border: ${d.modal_border};`);
    lines.push(`  --modal-header-border: ${d.modal_header_border};`);
    lines.push(`  --modal-close: ${d.modal_close};`);
    lines.push(`  --modal-close-hover: ${d.modal_close_hover};`);
    lines.push(`  --header-tab-bg: ${d.header_tab_bg};`);
    lines.push(`  --header-tab-text: ${d.header_tab_text};`);
    lines.push(`  --header-tab-border: ${d.header_tab_border};`);
    lines.push(`  --header-tab-active-bg: ${d.header_tab_active_bg};`);
    lines.push(`  --header-tab-active-text: ${d.header_tab_active_text};`);
    lines.push(`  --radius: ${parseInt(d.radius ?? 12, 10)}px;`);
    lines.push(`  --radius-sm: ${dRs}px;`);
    lines.push(`  --shadow: ${Number(d.shadow ?? 0.4)};`);
    lines.push('  --shadow-rgb: 0, 0, 0;');
    lines.push(`  --density: ${Number(d.density ?? 1.0)};`);
    lines.push(`  --contrast: ${Number(d.contrast ?? 1.0)};`);
    lines.push('}');

    lines.push('html[data-theme="dark"] {');
    lines.push(`  --bg: ${d.bg};`);
    lines.push(`  --card-bg: ${d.card_bg};`);
    lines.push(`  --text: ${d.text};`);
    lines.push(`  --muted: ${d.muted};`);
    lines.push(`  --accent: ${d.accent};`);
    lines.push(`  --border: ${d.border};`);
    // File manager (FM)
    lines.push(`  --fm-panel-bg: ${d.fm_panel_bg};`);
    lines.push(`  --fm-panel-border: ${d.fm_panel_border};`);
    lines.push(`  --fm-panel-bar-bg: ${d.fm_panel_bar_bg};`);
    lines.push(`  --fm-panel-bar-border: ${d.fm_panel_bar_border};`);
    lines.push(`  --fm-input-bg: ${d.fm_input_bg};`);
    lines.push(`  --fm-input-border: ${d.fm_input_border};`);
    lines.push(`  --fm-row-header-bg: ${d.fm_row_header_bg};`);
    lines.push(`  --fm-row-header-border: ${d.fm_row_header_border};`);
    lines.push(`  --fm-row-hover-bg: ${d.fm_row_hover_bg};`);
    lines.push(`  --fm-row-selected-bg: ${d.fm_row_selected_bg};`);
    lines.push(`  --fm-row-focus-outline: ${d.fm_row_focus_outline};`);
    lines.push(`  --fm-props-bg: ${d.fm_props_bg};`);
    lines.push(`  --fm-props-border: ${d.fm_props_border};`);
    lines.push(`  --fm-menu-bg: ${d.fm_menu_bg};`);
    lines.push(`  --fm-menu-border: ${d.fm_menu_border};`);
    lines.push(`  --fm-menu-item-hover-bg: ${d.fm_menu_item_hover_bg};`);
    lines.push(`  --fm-menu-item-hover-border: ${d.fm_menu_item_hover_border};`);
    lines.push(`  --fm-menu-sep: ${d.fm_menu_sep};`);
    lines.push(`  --fm-btn-bg: ${d.fm_btn_bg};`);
    lines.push(`  --fm-btn-text: ${d.fm_btn_text};`);
    lines.push(`  --fm-btn-border: ${d.fm_btn_border};`);
    lines.push(`  --fm-btn-hover-bg: ${d.fm_btn_hover_bg};`);
    lines.push(`  --fm-btn-hover-text: ${d.fm_btn_hover_text};`);
    lines.push(`  --fm-btn-hover-border: ${d.fm_btn_hover_border};`);
    lines.push(`  --fm-btn-active-from: ${d.fm_btn_active_from};`);
    lines.push(`  --fm-btn-active-to: ${d.fm_btn_active_to};`);

    lines.push(`  --sem-success: ${d.sem_success};`);
    lines.push(`  --sem-info: ${d.sem_info};`);
    lines.push(`  --sem-warning: ${d.sem_warning};`);
    lines.push(`  --sem-error: ${d.sem_error};`);
    lines.push(`  --sem-debug: ${d.sem_debug};`);
    lines.push(`  --log-ts: ${d.log_ts};`);
    lines.push(`  --log-ip: ${d.log_ip};`);
    lines.push(`  --log-domain: ${d.log_domain};`);
    lines.push(`  --log-proto: ${d.log_proto};`);
    lines.push(`  --log-port: ${d.log_port};`);
    lines.push(`  --log-uuid: ${d.log_uuid};`);
    lines.push(`  --log-email: ${d.log_email};`);
    lines.push(`  --log-inbound: ${d.log_inbound};`);
    lines.push(`  --log-outbound: ${d.log_outbound};`);
    lines.push(`  --log-method: ${d.log_method};`);
    lines.push(`  --log-path: ${d.log_path};`);
    lines.push(`  --log-sni: ${d.log_sni};`);
    lines.push(`  --log-alpn: ${d.log_alpn};`);
    lines.push(`  --log-route-tproxy-vless: ${d.log_route_tproxy_vless};`);
    lines.push(`  --log-route-redirect-vless: ${d.log_route_redirect_vless};`);
    lines.push(`  --log-route-redirect-direct: ${d.log_route_redirect_direct};`);
    lines.push(`  --log-route-reject: ${d.log_route_reject};`);
    lines.push(`  --editor-btn-bg: ${d.editor_btn_bg};`);
    lines.push(`  --editor-btn-text: ${d.editor_btn_text};`);
    lines.push(`  --editor-btn-border: ${d.editor_btn_border};`);
    lines.push(`  --editor-btn-hover-bg: ${d.editor_btn_hover_bg};`);
    lines.push(`  --editor-btn-hover-text: ${d.editor_btn_hover_text};`);
    lines.push(`  --editor-btn-hover-border: ${d.editor_btn_hover_border};`);
    lines.push(`  --editor-btn-border-hover: ${d.editor_btn_hover_border};`);
    lines.push(`  --editor-btn-active-from: ${d.editor_btn_active_from};`);
    lines.push(`  --editor-btn-active-to: ${d.editor_btn_active_to};`);
    lines.push(`  --header-btn-bg: ${d.header_btn_bg};`);
    lines.push(`  --header-btn-text: ${d.header_btn_text};`);
    lines.push(`  --header-btn-border: ${d.header_btn_border};`);
    lines.push(`  --header-btn-hover-bg: ${d.header_btn_hover_bg};`);
    lines.push(`  --header-btn-hover-text: ${d.header_btn_hover_text};`);
    lines.push(`  --header-btn-hover-border: ${d.header_btn_hover_border};`);
    lines.push(`  --modal-overlay: ${d.modal_overlay};`);
    lines.push(`  --modal-bg: ${d.modal_bg};`);
    lines.push(`  --modal-text: ${d.modal_text};`);
    lines.push(`  --modal-muted: ${d.modal_muted};`);
    lines.push(`  --modal-body-bg: ${d.modal_body_bg};`);
    lines.push(`  --modal-body-border: ${d.modal_body_border};`);
    lines.push(`  --modal-table-head-bg: ${d.modal_table_head_bg};`);
    lines.push(`  --modal-table-head-text: ${d.modal_table_head_text};`);
    lines.push(`  --modal-table-border: ${d.modal_table_border};`);
    lines.push(`  --modal-table-row-hover-bg: ${d.modal_table_row_hover_bg};`);
    lines.push(`  --modal-list-marker: ${d.modal_list_marker};`);
    lines.push(`  --modal-border: ${d.modal_border};`);
    lines.push(`  --modal-header-border: ${d.modal_header_border};`);
    lines.push(`  --modal-close: ${d.modal_close};`);
    lines.push(`  --modal-close-hover: ${d.modal_close_hover};`);
    lines.push(`  --header-tab-bg: ${d.header_tab_bg};`);
    lines.push(`  --header-tab-text: ${d.header_tab_text};`);
    lines.push(`  --header-tab-border: ${d.header_tab_border};`);
    lines.push(`  --header-tab-active-bg: ${d.header_tab_active_bg};`);
    lines.push(`  --header-tab-active-text: ${d.header_tab_active_text};`);
    lines.push(`  --radius: ${parseInt(d.radius ?? 12, 10)}px;`);
    lines.push(`  --radius-sm: ${dRs}px;`);
    lines.push(`  --shadow: ${Number(d.shadow ?? 0.4)};`);
    lines.push('  --shadow-rgb: 0, 0, 0;');
    lines.push(`  --density: ${Number(d.density ?? 1.0)};`);
    lines.push(`  --contrast: ${Number(d.contrast ?? 1.0)};`);
    lines.push('}');

    lines.push('html[data-theme="light"] {');
    lines.push(`  --bg: ${l.bg};`);
    lines.push(`  --card-bg: ${l.card_bg};`);
    lines.push(`  --text: ${l.text};`);
    lines.push(`  --muted: ${l.muted};`);
    lines.push(`  --accent: ${l.accent};`);
    lines.push(`  --border: ${l.border};`);
    // File manager (FM)
    lines.push(`  --fm-panel-bg: ${l.fm_panel_bg};`);
    lines.push(`  --fm-panel-border: ${l.fm_panel_border};`);
    lines.push(`  --fm-panel-bar-bg: ${l.fm_panel_bar_bg};`);
    lines.push(`  --fm-panel-bar-border: ${l.fm_panel_bar_border};`);
    lines.push(`  --fm-input-bg: ${l.fm_input_bg};`);
    lines.push(`  --fm-input-border: ${l.fm_input_border};`);
    lines.push(`  --fm-row-header-bg: ${l.fm_row_header_bg};`);
    lines.push(`  --fm-row-header-border: ${l.fm_row_header_border};`);
    lines.push(`  --fm-row-hover-bg: ${l.fm_row_hover_bg};`);
    lines.push(`  --fm-row-selected-bg: ${l.fm_row_selected_bg};`);
    lines.push(`  --fm-row-focus-outline: ${l.fm_row_focus_outline};`);
    lines.push(`  --fm-props-bg: ${l.fm_props_bg};`);
    lines.push(`  --fm-props-border: ${l.fm_props_border};`);
    lines.push(`  --fm-menu-bg: ${l.fm_menu_bg};`);
    lines.push(`  --fm-menu-border: ${l.fm_menu_border};`);
    lines.push(`  --fm-menu-item-hover-bg: ${l.fm_menu_item_hover_bg};`);
    lines.push(`  --fm-menu-item-hover-border: ${l.fm_menu_item_hover_border};`);
    lines.push(`  --fm-menu-sep: ${l.fm_menu_sep};`);
    lines.push(`  --fm-btn-bg: ${l.fm_btn_bg};`);
    lines.push(`  --fm-btn-text: ${l.fm_btn_text};`);
    lines.push(`  --fm-btn-border: ${l.fm_btn_border};`);
    lines.push(`  --fm-btn-hover-bg: ${l.fm_btn_hover_bg};`);
    lines.push(`  --fm-btn-hover-text: ${l.fm_btn_hover_text};`);
    lines.push(`  --fm-btn-hover-border: ${l.fm_btn_hover_border};`);
    lines.push(`  --fm-btn-active-from: ${l.fm_btn_active_from};`);
    lines.push(`  --fm-btn-active-to: ${l.fm_btn_active_to};`);

    lines.push(`  --sem-success: ${l.sem_success};`);
    lines.push(`  --sem-info: ${l.sem_info};`);
    lines.push(`  --sem-warning: ${l.sem_warning};`);
    lines.push(`  --sem-error: ${l.sem_error};`);
    lines.push(`  --sem-debug: ${l.sem_debug};`);
    lines.push(`  --log-ts: ${l.log_ts};`);
    lines.push(`  --log-ip: ${l.log_ip};`);
    lines.push(`  --log-domain: ${l.log_domain};`);
    lines.push(`  --log-proto: ${l.log_proto};`);
    lines.push(`  --log-port: ${l.log_port};`);
    lines.push(`  --log-uuid: ${l.log_uuid};`);
    lines.push(`  --log-email: ${l.log_email};`);
    lines.push(`  --log-inbound: ${l.log_inbound};`);
    lines.push(`  --log-outbound: ${l.log_outbound};`);
    lines.push(`  --log-method: ${l.log_method};`);
    lines.push(`  --log-path: ${l.log_path};`);
    lines.push(`  --log-sni: ${l.log_sni};`);
    lines.push(`  --log-alpn: ${l.log_alpn};`);
    lines.push(`  --log-route-tproxy-vless: ${l.log_route_tproxy_vless};`);
    lines.push(`  --log-route-redirect-vless: ${l.log_route_redirect_vless};`);
    lines.push(`  --log-route-redirect-direct: ${l.log_route_redirect_direct};`);
    lines.push(`  --log-route-reject: ${l.log_route_reject};`);
    lines.push(`  --editor-btn-bg: ${l.editor_btn_bg};`);
    lines.push(`  --editor-btn-text: ${l.editor_btn_text};`);
    lines.push(`  --editor-btn-border: ${l.editor_btn_border};`);
    lines.push(`  --editor-btn-hover-bg: ${l.editor_btn_hover_bg};`);
    lines.push(`  --editor-btn-hover-text: ${l.editor_btn_hover_text};`);
    lines.push(`  --editor-btn-hover-border: ${l.editor_btn_hover_border};`);
    lines.push(`  --editor-btn-border-hover: ${l.editor_btn_hover_border};`);
    lines.push(`  --editor-btn-active-from: ${l.editor_btn_active_from};`);
    lines.push(`  --editor-btn-active-to: ${l.editor_btn_active_to};`);
    lines.push(`  --header-btn-bg: ${l.header_btn_bg};`);
    lines.push(`  --header-btn-text: ${l.header_btn_text};`);
    lines.push(`  --header-btn-border: ${l.header_btn_border};`);
    lines.push(`  --header-btn-hover-bg: ${l.header_btn_hover_bg};`);
    lines.push(`  --header-btn-hover-text: ${l.header_btn_hover_text};`);
    lines.push(`  --header-btn-hover-border: ${l.header_btn_hover_border};`);
    lines.push(`  --modal-overlay: ${l.modal_overlay};`);
    lines.push(`  --modal-bg: ${l.modal_bg};`);
    lines.push(`  --modal-text: ${l.modal_text};`);
    lines.push(`  --modal-muted: ${l.modal_muted};`);
    lines.push(`  --modal-body-bg: ${l.modal_body_bg};`);
    lines.push(`  --modal-body-border: ${l.modal_body_border};`);
    lines.push(`  --modal-table-head-bg: ${l.modal_table_head_bg};`);
    lines.push(`  --modal-table-head-text: ${l.modal_table_head_text};`);
    lines.push(`  --modal-table-border: ${l.modal_table_border};`);
    lines.push(`  --modal-table-row-hover-bg: ${l.modal_table_row_hover_bg};`);
    lines.push(`  --modal-list-marker: ${l.modal_list_marker};`);
    lines.push(`  --modal-border: ${l.modal_border};`);
    lines.push(`  --modal-header-border: ${l.modal_header_border};`);
    lines.push(`  --modal-close: ${l.modal_close};`);
    lines.push(`  --modal-close-hover: ${l.modal_close_hover};`);
    lines.push(`  --header-tab-bg: ${l.header_tab_bg};`);
    lines.push(`  --header-tab-text: ${l.header_tab_text};`);
    lines.push(`  --header-tab-border: ${l.header_tab_border};`);
    lines.push(`  --header-tab-active-bg: ${l.header_tab_active_bg};`);
    lines.push(`  --header-tab-active-text: ${l.header_tab_active_text};`);
    lines.push(`  --radius: ${parseInt(l.radius ?? 12, 10)}px;`);
    lines.push(`  --radius-sm: ${lRs}px;`);
    lines.push(`  --shadow: ${Number(l.shadow ?? 0.08)};`);
    lines.push('  --shadow-rgb: 15, 23, 42;');
    lines.push(`  --density: ${Number(l.density ?? 1.0)};`);
    lines.push(`  --contrast: ${Number(l.contrast ?? 1.0)};`);
    lines.push('}');

    // IMPORTANT: do not apply `filter` on <body>. In Chromium/WebKit,
    // a filtered ancestor creates a containing block for position:fixed descendants,
    // which breaks fixed overlays (terminal/help drawers) and can cause page overflow.
    lines.push('body { background: var(--bg) !important; color: var(--text) !important; }');

    // Safety override: neutralize any legacy `filter: contrast()` rules from older theme versions.
    // NOTE: A filter on an ancestor affects all descendants and cannot be "canceled" from inside,
    // so we must explicitly reset it on top-level containers.
    lines.push('html, body, .container { filter: none !important; }');
    lines.push('.container > :not(.modal):not(.terminal-overlay):not(.xkeen-cm-help-overlay):not(.xkeen-cm-help-drawer) { filter: none !important; }');
    lines.push('.modal-content, .terminal-window, .xkeen-cm-help-drawer, .global-spinner-box { filter: none !important; }');

// Contrast (safe):
    // Do NOT use CSS `filter: contrast()` on containers. It breaks transparency and alters embedded widgets (CodeMirror, file manager).
    // Instead, gently adjust a couple of core tokens (border + muted) via color-mix when available.
    lines.push(':root { --xk-border: var(--border); --xk-muted: var(--muted); }');
    lines.push('@supports (color: color-mix(in srgb, black 50%, white)) {');
    lines.push('  :root {');
    lines.push('    --xk-contrast-hi: clamp(0, calc(var(--contrast) - 1), 1);');
    lines.push('    --xk-contrast-lo: clamp(0, calc(1 - var(--contrast)), 1);');
    lines.push('    --xk-contrast-hi-p: calc(var(--xk-contrast-hi) * 55%);');
    lines.push('    --xk-contrast-lo-p: calc(var(--xk-contrast-lo) * 55%);');
    lines.push('    --xk-border: color-mix(in srgb, color-mix(in srgb, var(--border) calc(100% - var(--xk-contrast-hi-p)), var(--text) var(--xk-contrast-hi-p)) calc(100% - var(--xk-contrast-lo-p)), var(--bg) var(--xk-contrast-lo-p));');
    lines.push('    --xk-muted: color-mix(in srgb, color-mix(in srgb, var(--muted) calc(100% - var(--xk-contrast-hi-p)), var(--text) var(--xk-contrast-hi-p)) calc(100% - var(--xk-contrast-lo-p)), var(--bg) var(--xk-contrast-lo-p));');
    lines.push('  }');
    lines.push('}');
    lines.push('a { color: var(--accent) !important; }');
    lines.push('header p, .card p, .hint, .modal-hint, .small { color: var(--xk-muted, var(--muted)) !important; }');
    lines.push('.container { padding: calc(24px * var(--density)) !important; }');
    lines.push('.card { background: var(--card-bg) !important; border-color: var(--xk-border, var(--border)) !important; border-radius: var(--radius) !important; padding: calc(16px * var(--density)) calc(16px * var(--density)) calc(20px * var(--density)) !important; box-shadow: 0 10px 30px rgba(var(--shadow-rgb), var(--shadow)) !important; }');
    lines.push('.modal { background: var(--modal-overlay) !important; }');
    lines.push('.modal-content { background: var(--modal-bg) !important; color: var(--modal-text) !important; border-color: var(--modal-border) !important; border-radius: var(--radius) !important; box-shadow: 0 10px 30px rgba(var(--shadow-rgb), var(--shadow)) !important; }');
    lines.push('.modal-header { border-bottom-color: var(--modal-header-border) !important; }');
    lines.push('.modal-close { color: var(--modal-close) !important; }');
    lines.push('.modal-close:hover { color: var(--modal-close-hover) !important; }');
    lines.push('.modal-content .modal-hint, .modal-content .hint, .modal-content .small { color: var(--modal-muted) !important; }');
    lines.push('.modal-body { background: var(--modal-body-bg) !important; }');
    lines.push('.modal-body-logs { background: var(--modal-body-bg) !important; border: 1px solid var(--modal-body-border) !important; border-radius: var(--radius-sm) !important; padding: calc(8px * var(--density)) !important; }');
    lines.push('.modal-content table { background: transparent !important; color: var(--modal-text) !important; }');
    lines.push('.modal-content thead { background: var(--modal-table-head-bg) !important; }');
    lines.push('.modal-content th { color: var(--modal-table-head-text) !important; border-bottom-color: var(--modal-table-border) !important; }');
    lines.push('.modal-content td { border-bottom-color: var(--modal-table-border) !important; }');
    lines.push('.modal-content tbody tr:hover { background: var(--modal-table-row-hover-bg) !important; }');
    lines.push('.modal-content ul li::marker, .modal-content ol li::marker { color: var(--modal-list-marker) !important; }');
    lines.push('input, select, textarea, .xkeen-textarea, .CodeMirror { border-color: var(--xk-border, var(--border)) !important; border-radius: var(--radius-sm) !important; background: var(--card-bg) !important; color: var(--text) !important; }');
    lines.push('button { border-radius: var(--radius-sm) !important; }');
    lines.push('');
    lines.push('/* Header buttons / tabs */');
    lines.push('header .service-core-text, header .theme-toggle-btn.theme-toggle-header, header .header-actions .btn-link { background: var(--header-btn-bg) !important; border-color: var(--header-btn-border) !important; color: var(--header-btn-text) !important; }');
    lines.push('header .service-core-text:hover, header .theme-toggle-btn.theme-toggle-header:hover, header .header-actions .btn-link:hover { background: var(--header-btn-hover-bg) !important; border-color: var(--header-btn-hover-border) !important; color: var(--header-btn-hover-text) !important; }');
    lines.push('header .top-tabs.header-tabs .top-tab-btn { background: var(--header-tab-bg) !important; border-color: var(--header-tab-border) !important; color: var(--header-tab-text) !important; }');
    lines.push('header .top-tabs.header-tabs .top-tab-btn:hover, header .top-tabs.header-tabs .top-tab-btn.active { background: var(--header-tab-active-bg) !important; border-color: var(--header-tab-active-bg) !important; color: var(--header-tab-active-text) !important; }');

    return lines.join('\n') + '\n';
  }

  function _themeEnsurePreviewStyle() {
    if (_themePreviewEl && document.head.contains(_themePreviewEl)) return _themePreviewEl;
    let el = document.getElementById('xk-theme-preview-style');
    if (!el) {
      el = document.createElement('style');
      el.id = 'xk-theme-preview-style';
      document.head.appendChild(el);
    }
    _themePreviewEl = el;
    return el;
  }

  function _themeRemovePreviewStyle() {
    const el = document.getElementById('xk-theme-preview-style');
    if (el && el.parentNode) {
      try { el.parentNode.removeChild(el); } catch (e) {}
    }
    _themePreviewEl = null;
  }

  function _themeApplyPreview() {
    const live = byId('dt-theme-live-preview');
    const isLive = !!(live && live.checked);
    if (!isLive) return;

    const el = _themeEnsurePreviewStyle();
    try { el.textContent = _themeBuildCss(_themeCfg); } catch (e) { el.textContent = ''; }

    _themeStatus('Preview: применено (не сохранено).', false);
  }

  async function _themeLoadFromServer() {
    const card = byId('dt-theme-editor-card');
    if (!card) return;

    _themeLoaded = false;
    try {
      const resp = await getJSON('/api/devtools/theme');
      if (!resp || !resp.ok) throw new Error((resp && resp.error) ? resp.error : 'theme_get_failed');
      if (resp.config) _themeCfg = resp.config;
      _themeMeta.exists = !!resp.exists;
      _themeMeta.version = resp.version || 0;

      _setCustomThemeLinkVersion(_themeMeta.version);
      _themeSyncUiFromState();

      // If live preview is enabled, apply the current config immediately so the first slider move
      // doesn't "suddenly" re-style unrelated parts of the UI.
      try { _themeApplyPreview(); } catch (e) {}

      const saved = _themeMeta.exists ? `Сохранено (v=${_themeMeta.version || 0})` : 'Не сохранено (используется стандартная тема)';
      _themeStatus(saved, false);
    } catch (e) {
      _themeStatus('Не удалось загрузить theme config: ' + (e && e.message ? e.message : String(e)), true);
    } finally {
      _themeLoaded = true;
    }
  }

  async function _themeSaveToServer() {
    const btn = byId('dt-theme-save');
    if (btn) btn.disabled = true;
    try {
      const resp = await postJSON('/api/devtools/theme', { config: _themeCfg });
      if (!resp || !resp.ok) throw new Error((resp && resp.error) ? resp.error : 'theme_save_failed');

      _themeCfg = resp.config || _themeCfg;
      _themeMeta.exists = !!resp.exists;
      _themeMeta.version = resp.version || 0;

      _setCustomThemeLinkVersion(_themeMeta.version);
      _themeRemovePreviewStyle();

      toast('Theme saved globally');
      _themeStatus(`Сохранено (v=${_themeMeta.version || 0}). Обновите другие страницы, чтобы применилось.`, false);
    } catch (e) {
      toast('Theme save failed', true);
      _themeStatus('Save failed: ' + (e && e.message ? e.message : String(e)), true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function _themeResetOnServer() {
    if (!confirm('Удалить global custom theme и вернуться к стандартным стилям?')) return;

    const btn = byId('dt-theme-reset');
    if (btn) btn.disabled = true;
    try {
      const resp = await postJSON('/api/devtools/theme/reset', {});
      if (!resp || !resp.ok) throw new Error((resp && resp.error) ? resp.error : 'theme_reset_failed');

      _themeCfg = resp.config || JSON.parse(JSON.stringify(_THEME_DEFAULT_CONFIG));
      _themeMeta.exists = !!resp.exists;
      _themeMeta.version = resp.version || 0;

      _setCustomThemeLinkVersion(_themeMeta.version);
      _themeRemovePreviewStyle();
      _themeSyncUiFromState();

      toast('Theme reset');
      _themeStatus('Сброшено. Используется стандартная тема.', false);
    } catch (e) {
      toast('Theme reset failed', true);
      _themeStatus('Reset failed: ' + (e && e.message ? e.message : String(e)), true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function _themeResetFileManager() {
    if (!confirm('Сбросить настройки Файлового менеджера (FM) в текущей теме и сохранить глобально?')) return;
    const keys = [
      'fm_panel_bg','fm_panel_border','fm_panel_bar_bg','fm_panel_bar_border','fm_input_bg','fm_input_border',
      'fm_row_header_bg','fm_row_header_border','fm_row_hover_bg','fm_row_selected_bg','fm_row_focus_outline',
      'fm_props_bg','fm_props_border','fm_menu_bg','fm_menu_border','fm_menu_item_hover_bg','fm_menu_item_hover_border','fm_menu_sep',
      'fm_btn_bg','fm_btn_text','fm_btn_border','fm_btn_hover_bg','fm_btn_hover_text','fm_btn_hover_border','fm_btn_active_from','fm_btn_active_to',
    ];
    try {
      for (const k of keys) {
        if (_THEME_DEFAULT_CONFIG.dark && (k in _THEME_DEFAULT_CONFIG.dark)) _themeCfg.dark[k] = _THEME_DEFAULT_CONFIG.dark[k];
        if (_THEME_DEFAULT_CONFIG.light && (k in _THEME_DEFAULT_CONFIG.light)) _themeCfg.light[k] = _THEME_DEFAULT_CONFIG.light[k];
      }
    } catch (e) {}
    try { _themeSyncUiFromState(); } catch (e) {}
    try { _themeApplyPreview(); } catch (e) {}
    await _themeSaveToServer();
  }

  function _wireThemeEditor() {
    const card = byId('dt-theme-editor-card');
    if (!card) return;

    // Replace long help text with concise hover tooltips.
    _themeWireTooltips();

    const bDark = byId('dt-theme-target-dark');
    const bLight = byId('dt-theme-target-light');

    if (bDark) bDark.addEventListener('click', () => _themeSetSelected('dark'));
    if (bLight) bLight.addEventListener('click', () => _themeSetSelected('light'));

    for (const f of _THEME_COLOR_FIELDS) {
      const c = byId(`dt-theme-${f.id}-color`);
      const tx = byId(`dt-theme-${f.id}-text`);

      // Create opacity UI for keys where alpha is expected.
      if (_THEME_ALPHA_KEYS.has(f.key)) {
        try { _themeEnsureAlphaRow(f, c, tx); } catch (e) {}
      }

      if (c) {
        c.addEventListener('input', () => {
          const base = String(c.value || '').trim();
          let out = base;

          const forced = _THEME_ALPHA_KEYS.has(f.key);
          const existing = _themeAlphaUi[f.key];
          if (forced || (existing && existing.wantAlpha)) {
            const ui = _themeEnsureAlphaRow(f, c, tx);
            if (ui) {
              ui.wantAlpha = true;
              out = _hex8(base, ui.aByte);
              try { if (tx) tx.value = out; } catch (e) {}
              ui.show(true);
              ui.sync();
            }
          } else {
            try { if (tx) tx.value = base; } catch (e) {}
          }

          _themeUpdateState(f.key, out);
          _themeApplyPreview();
        });
      }

      if (tx) {
        tx.addEventListener('input', () => {
          const raw = String(tx.value || '').trim();
          if (_isHexColor(raw)) {
            const v = _expandShortHex(raw);
            _themeUpdateState(f.key, v);
            if (c) c.value = _toColorPickerValue(v);

            // Auto-enable opacity control if user entered #RRGGBBAA, or if the key is forced.
            try { _themeSyncAlphaRow(f, c, tx, v); } catch (e) {}
          }
          _themeApplyPreview();
        });
      }
    }

    const radius = byId('dt-theme-radius');
    const shadow = byId('dt-theme-shadow');
    const density = byId('dt-theme-density');
    const contrast = byId('dt-theme-contrast');

    const fontScale = byId('dt-theme-font-scale');
    const monoScale = byId('dt-theme-mono-scale');

    const rv = byId('dt-theme-radius-val');
    const sv = byId('dt-theme-shadow-val');
    const dv = byId('dt-theme-density-val');
    const cv = byId('dt-theme-contrast-val');

    const fsv = byId('dt-theme-font-scale-val');
    const msv = byId('dt-theme-mono-scale-val');

    function _themeEnsureSelectedCfg() {
      if (!_themeCfg[_themeSelected]) _themeCfg[_themeSelected] = {};
      return _themeCfg[_themeSelected];
    }

    function updRadius() {
      const cfg = _themeEnsureSelectedCfg();
      const v = parseInt(radius.value || '12', 10);
      cfg.radius = Number.isFinite(v) ? v : 12;
      if (rv) rv.textContent = `${parseInt(cfg.radius ?? 12, 10)}px`;
      _themeApplyPreview();
    }

    function updShadow() {
      const cfg = _themeEnsureSelectedCfg();
      const v = Number(shadow.value || 0.4);
      cfg.shadow = Number.isFinite(v) ? v : 0.4;
      if (sv) sv.textContent = `${Number(cfg.shadow ?? 0.4).toFixed(2)}`;
      _themeApplyPreview();
    }

    function updDensity() {
      const cfg = _themeEnsureSelectedCfg();
      const v = Number(density.value || 1.0);
      cfg.density = Number.isFinite(v) ? v : 1.0;
      if (dv) dv.textContent = `${Number(cfg.density ?? 1.0).toFixed(2)}`;
      _themeApplyPreview();
    }

    function updContrast() {
      const cfg = _themeEnsureSelectedCfg();
      const v = Number(contrast.value || 1.0);
      cfg.contrast = Number.isFinite(v) ? v : 1.0;
      if (cv) cv.textContent = `${Number(cfg.contrast ?? 1.0).toFixed(2)}`;
      _themeApplyPreview();
    }

    function updFontScale() {
      const fsFallback = (_themeCfg && typeof _themeCfg.font_scale !== 'undefined') ? _themeCfg.font_scale : (_THEME_DEFAULT_CONFIG.font_scale ?? 1.0);
      const fsRaw = Number(fontScale ? fontScale.value : fsFallback);
      const fs = Number.isFinite(fsRaw) ? fsRaw : 1.0;
      _themeCfg.font_scale = fs;
      if (fsv) fsv.textContent = `${fs.toFixed(2)}`;
      _themeApplyPreview();
    }

    function updMonoScale() {
      const msFallback = (_themeCfg && typeof _themeCfg.mono_scale !== 'undefined') ? _themeCfg.mono_scale : (_THEME_DEFAULT_CONFIG.mono_scale ?? 1.0);
      const msRaw = Number(monoScale ? monoScale.value : msFallback);
      const ms = Number.isFinite(msRaw) ? msRaw : 1.0;
      _themeCfg.mono_scale = ms;
      if (msv) msv.textContent = `${ms.toFixed(2)}`;
      _themeApplyPreview();
    }

    if (radius) radius.addEventListener('input', updRadius);
    if (shadow) shadow.addEventListener('input', updShadow);
    if (density) density.addEventListener('input', updDensity);
    if (contrast) contrast.addEventListener('input', updContrast);
    if (fontScale) fontScale.addEventListener('input', updFontScale);
    if (monoScale) monoScale.addEventListener('input', updMonoScale);

    const live = byId('dt-theme-live-preview');
    if (live) {
      live.addEventListener('change', () => {
        if (!live.checked) {
          _themeRemovePreviewStyle();
          _themeStatus(_themeMeta.exists ? `Сохранено (v=${_themeMeta.version || 0}). Preview выключен.` : 'Preview выключен.', false);
        } else {
          _themeApplyPreview();
        }
      });
    }

    const save = byId('dt-theme-save');
    if (save) save.addEventListener('click', () => _themeSaveToServer());

    const reset = byId('dt-theme-reset');
    const resetFm = byId('dt-theme-reset-fm');
    if (reset) reset.addEventListener('click', () => _themeResetOnServer());

    // Initial load
    _themeLoadFromServer();
  }


  


  function init() {
    try { _wireThemeEditor(); } catch (e) {}
  }

  XK.features.devtoolsTheme = { init };
})();
