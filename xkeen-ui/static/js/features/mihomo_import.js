import { getMihomoPanelApi } from './mihomo_panel.js';
import { getMihomoYamlPatchApi } from './mihomo_yaml_patch.js';
import {
  confirmMihomoAction,
  getMihomoCoreHttpApi,
  getMihomoEditorEngineApi,
  refreshSharedMihomoEditor,
  syncMihomoModalBodyScrollLock,
} from './mihomo_runtime.js';
import { getXkeenFilePath } from './xkeen_runtime.js';

let mihomoImportModuleApi = null;

(() => {
  'use strict';

  // Mihomo Import (Parser) UI
  // - Paste vless/trojan/vmess/ss/hysteria2/hy2, https-subscription, WireGuard, OpenVPN, or Tailscale
  // - Convert to Mihomo YAML and insert into config.yaml editor
  // Legacy globals are published by features/compat/mihomo_import.js.

  const MI = mihomoImportModuleApi || {};
  mihomoImportModuleApi = MI;

  const IDS = {
    btnOpen: 'mihomo-import-node-btn',

    modal: 'mihomo-import-modal',
    btnClose: 'mihomo-import-close-btn',
    btnCancel: 'mihomo-import-cancel-btn',

    input: 'mihomo-import-input',
    modeSelect: 'mihomo-import-mode',
    preview: 'mihomo-import-preview',


    engineSelect: 'mihomo-import-engine-select',
    monacoHost: 'mihomo-import-preview-monaco',
    status: 'mihomo-import-status',
    hint: 'mihomo-import-target-hint',

    groupsBox: 'mihomo-import-groups',
    groupsAllBtn: 'mihomo-import-groups-all-btn',
    groupsNoneBtn: 'mihomo-import-groups-none-btn',
    groupsRemember: 'mihomo-import-groups-remember',
    xrayRefreshBlock: 'mihomo-import-xray-refresh-block',
    xrayInterval: 'mihomo-import-xray-interval',
    xrayRefreshNote: 'mihomo-import-xray-refresh-note',
    xrayManagedList: 'mihomo-import-xray-managed',

    btnParse: 'mihomo-import-parse-btn',
    btnParseStatic: 'mihomo-import-parse-static-btn',
    btnInsert: 'mihomo-import-insert-btn',
  };

  let _inited = false;
  let _lastResult = null; // { outputs: [{type, content, uri}] }
  let _previewCm = null;
  let _previewCmFacade = null;

  let _previewKind = 'codemirror';
  let _previewMonaco = null;
  let _previewMonacoFacade = null;
  let _previewLastText = '';
  let _engineUnsub = null;
  let _engineSyncing = false;
  let _previewLayoutRaf = 0;
  let _previewResizeObserver = null;
  let _managedXraySubscriptions = [];

  // Groups selection (proxy-groups)
  const GROUPS_PREF_KEY = 'xkeen.mihomo.import.groups.v1';
  const GROUPS_REMEMBER_KEY = 'xkeen.mihomo.import.groups.remember_v1';
  const XRAY_INTERVAL_PREF_KEY = 'xkeen.mihomo.import.xray_interval_hours.v1';
  const XRAY_DEFAULT_INTERVAL_HOURS = 24;
  const XRAY_MIN_INTERVAL_HOURS = 1;
  const XRAY_MAX_INTERVAL_HOURS = 168;


  // Import mode (Auto / Proxy / Subscription / WireGuard / OpenVPN / Tailscale)
  const MODE_PREF_KEY = 'xkeen.mihomo.import.mode.v1';

  function getImportMode() {
    const sel = $(IDS.modeSelect);
    const v = sel ? String(sel.value || 'auto') : 'auto';
    return v || 'auto';
  }

  function setImportMode(mode) {
    const sel = $(IDS.modeSelect);
    if (!sel) return;
    try { sel.value = String(mode || 'auto'); } catch (e) {}
  }

  function loadImportModePref() {
    try {
      if (window.localStorage) {
        const v = localStorage.getItem(MODE_PREF_KEY);
        if (v) return String(v);
      }
    } catch (e) {}
    return 'auto';
  }

  function saveImportModePref(mode) {
    try { if (window.localStorage) localStorage.setItem(MODE_PREF_KEY, String(mode || 'auto')); } catch (e) {}
  }

  function updateModeUi() {
    const inp = $(IDS.input);
    if (!inp) return;
    const mode = getImportMode();
    if (mode === 'wireguard') {
      inp.placeholder = '[Interface]\nPrivateKey = ...\nAddress = ...\n\n[Peer]\nPublicKey = ...\nEndpoint = host:port\nAllowedIPs = 0.0.0.0/0';
    } else if (mode === 'openvpn') {
      inp.placeholder = 'client\nremote vpn.example.com 1194\nproto udp\n<ca>\n...\n</ca>\n<tls-crypt>\n...\n</tls-crypt>';
    } else if (mode === 'tailscale') {
      inp.placeholder = 'hostname: xkeen\n# auth-key: tskey-auth-...\nstate-dir: ./tailscale\nudp: true\naccept-routes: true';
    } else if (mode === 'subscription') {
      inp.placeholder = 'https://...';
    } else if (mode === 'proxy') {
      inp.placeholder = 'vless://...\nили\ntrojan://...';
    } else {
      inp.placeholder = 'vless://...\nили\nhttps://...';
    }
  }


  function $(id) {
    return document.getElementById(id);
  }

  function boolOpt(value) {
    return value === true || value === 1 || String(value || '').trim().toLowerCase() === 'true';
  }

  function toastMsg(msg, kind) {
    const level = typeof kind === 'string' ? kind : (kind ? 'error' : 'success');
    try {
      if (window.toast) window.toast(String(msg || ''), level);
      else if (window.showToast) window.showToast(String(msg || ''), level === 'error');
    } catch (e) {}
  }

  function shortenStatusUrl(value, maxLen = 88) {
    const text = String(value || '').trim();
    if (!text || text.length <= maxLen) return text;
    const head = Math.max(24, Math.min(54, Math.floor((maxLen - 1) * 0.68)));
    const tail = Math.max(12, maxLen - head - 1);
    return `${text.slice(0, head)}…${text.slice(-tail)}`;
  }

  function compactStatusLinks(value) {
    return String(value || '').replace(/((?:https?:\/\/|happ:\/\/)[^\s]+)/gi, (match) => shortenStatusUrl(match));
  }

  function setStatusContent(el, msg, opts) {
    if (!el) return;
    const text = compactStatusLinks(msg);
    const hasMsg = !!String(text || '').trim();
    const busy = !!(opts && opts.busy);
    el.innerHTML = '';
    if (!hasMsg) return;
    if (busy) {
      const wrap = document.createElement('span');
      wrap.className = 'xk-status-inline is-busy';
      const spinner = document.createElement('span');
      spinner.className = 'xk-inline-spinner';
      spinner.setAttribute('aria-hidden', 'true');
      const content = document.createElement('span');
      content.className = 'xk-status-message';
      content.textContent = text;
      wrap.appendChild(spinner);
      wrap.appendChild(content);
      el.appendChild(wrap);
      return;
    }
    el.textContent = text;
  }

  function setStatus(msg, isErr, kind, opts) {
    const el = $(IDS.status);
    if (!el) return;
    const value = String(msg || '');
    const hasMsg = !!value.trim();
    const state = kind || (isErr ? 'error' : 'success');
    setStatusContent(el, value, opts);
    el.classList.toggle('error', hasMsg && state === 'error');
    el.classList.toggle('warning', hasMsg && state === 'warning');
    el.classList.toggle('success', hasMsg && state === 'success');
    el.classList.toggle('is-busy', hasMsg && !!(opts && opts.busy));
    if (hasMsg && opts && opts.busy) el.setAttribute('aria-busy', 'true');
    else el.removeAttribute('aria-busy');
    el.classList.toggle('hidden', !hasMsg);
  }

  function setHint(msg) {
    const el = $(IDS.hint);
    if (!el) return;
    const value = String(msg || '');
    el.textContent = value;
    el.classList.toggle('hidden', !value.trim());
  }

  function isTruthyHeader(value) {
    const s = String(value == null ? '' : value).trim().toLowerCase();
    return !!s && !['0', 'false', 'no', 'off', 'none', 'null'].includes(s);
  }

  function intFromHeader(value) {
    const text = String(value == null ? '' : value).trim();
    if (!text || /^(true|false|yes|no|on|off)$/i.test(text)) return null;
    const match = text.match(/(^|[^\d])(\d{1,9})(?!\d)/);
    if (!match) return null;
    const n = Number.parseInt(match[2], 10);
    return Number.isFinite(n) ? n : null;
  }

  function parseLimitPair(value) {
    const text = String(value == null ? '' : value).trim();
    if (!text) return {};
    const pair = text.match(/(^|[^\d])(\d{1,9})\s*\/\s*(\d{1,9})(?!\d)/);
    if (pair) {
      return {
        used: Number.parseInt(pair[2], 10),
        limit: Number.parseInt(pair[3], 10),
      };
    }
    const parts = {};
    text.split(/[;,&]\s*/).forEach((chunk) => {
      const idx = chunk.indexOf('=');
      if (idx <= 0) return;
      const key = chunk.slice(0, idx).trim().toLowerCase().replace(/-/g, '_');
      parts[key] = chunk.slice(idx + 1).trim();
    });
    const out = {};
    ['used', 'current', 'devices_used', 'device_used', 'count'].some((key) => {
      const valueNum = intFromHeader(parts[key]);
      if (valueNum == null) return false;
      out.used = valueNum;
      return true;
    });
    ['limit', 'max', 'total', 'devices_limit', 'device_limit'].some((key) => {
      const valueNum = intFromHeader(parts[key]);
      if (valueNum == null) return false;
      out.limit = valueNum;
      return true;
    });
    return out;
  }

  function lowerHeaderMap(headers) {
    const out = {};
    if (!headers || typeof headers !== 'object') return out;
    Object.entries(headers).forEach(([key, value]) => {
      const cleanKey = String(key || '').trim().toLowerCase();
      const cleanValue = String(value == null ? '' : value).trim();
      if (cleanKey && cleanValue) out[cleanKey] = cleanValue;
    });
    return out;
  }

  function mergeLimitInfo(...items) {
    const out = {};
    items.forEach((item) => {
      if (!item || typeof item !== 'object') return;
      ['used', 'limit', 'remaining'].forEach((key) => {
        if (out[key] != null || item[key] == null) return;
        const n = Number.parseInt(String(item[key]), 10);
        if (Number.isFinite(n)) out[key] = n;
      });
      if (item.reached === true) out.reached = true;
      if (!out.summary && item.summary) out.summary = String(item.summary);
    });
    if (out.used == null && out.remaining != null && out.limit != null) {
      out.used = Math.max(0, out.limit - out.remaining);
    }
    if (out.used != null && out.limit != null) {
      out.summary = `${out.used}/${out.limit}`;
      if (out.used >= out.limit) out.reached = true;
    }
    if (out.remaining === 0) out.reached = true;
    return out;
  }

  function limitInfoFromHeaders(headers, explicitInfo) {
    const h = lowerHeaderMap(headers);
    const info = {};
    const firstInt = (keys) => {
      for (const key of keys) {
        const n = intFromHeader(h[key]);
        if (n != null) return n;
      }
      return null;
    };
    const used = firstInt([
      'x-hwid-devices-used',
      'x-hwid-device-used',
      'x-hwid-used',
      'x-hwid-current-devices',
      'x-hwid-device-count',
      'x-hwid-devices-count',
    ]);
    const limit = firstInt([
      'x-hwid-devices-limit',
      'x-hwid-device-limit',
      'x-hwid-max-devices',
      'x-hwid-limit-count',
      'x-hwid-limit-max',
      'x-hwid-limit-total',
      'x-hwid-total-devices',
    ]);
    const remaining = firstInt([
      'x-hwid-devices-remaining',
      'x-hwid-device-remaining',
      'x-hwid-remaining',
      'x-hwid-limit-remaining',
    ]);
    if (used != null) info.used = used;
    if (limit != null) info.limit = limit;
    if (remaining != null) info.remaining = remaining;
    ['x-hwid-devices', 'x-hwid-device-limit', 'x-hwid-limit-info', 'x-hwid-limit-detail', 'x-hwid-limit'].forEach((key) => {
      const pair = parseLimitPair(h[key]);
      if (info.used == null && pair.used != null) info.used = pair.used;
      if (info.limit == null && pair.limit != null) info.limit = pair.limit;
    });
    if (
      isTruthyHeader(h['x-hwid-max-devices-reached']) ||
      isTruthyHeader(h['x-hwid-limit']) ||
      info.remaining === 0
    ) {
      info.reached = true;
    }
    return mergeLimitInfo(explicitInfo, info);
  }

  function uniqueStrings(items) {
    const seen = new Set();
    const out = [];
    (Array.isArray(items) ? items : []).forEach((item) => {
      const text = String(item || '').trim();
      if (!text || seen.has(text)) return;
      seen.add(text);
      out.push(text);
    });
    return out;
  }

  function formatLimitWarning(info) {
    const data = info || {};
    if (data.used != null && data.limit != null) {
      return `Провайдер сообщил: HWID-лимит устройств исчерпан, использовано ${data.used} из ${data.limit}.`;
    }
    if (data.limit != null) {
      return `Провайдер сообщил: HWID-лимит устройств исчерпан, лимит ${data.limit}.`;
    }
    return 'Провайдер сообщил: HWID-лимит устройств исчерпан.';
  }

  function providerHeaderWarnings(headers, explicitLimitInfo, opts) {
    const h = lowerHeaderMap(headers);
    const options = opts || {};
    const tips = [];
    const limitInfo = limitInfoFromHeaders(h, explicitLimitInfo);
    if (limitInfo.reached || isTruthyHeader(h['x-hwid-max-devices-reached']) || isTruthyHeader(h['x-hwid-limit'])) {
      tips.push(formatLimitWarning(limitInfo));
    }
    if (!options.suppressNotSupported && isTruthyHeader(h['x-hwid-not-supported'])) {
      tips.push('Провайдер сообщил: HWID не поддержан или не принят этим запросом.');
    }
    return tips;
  }

  function providerProbeWarningMessages(probe) {
    if (!probe || typeof probe !== 'object') return [];
    const messages = [];
    const payload = probe.provider_payload || null;
    const headerSources = [
      probe.hwid_response_headers,
      payload && typeof payload === 'object' ? payload.hwid_response_headers : null,
    ];
    const mergedHeaders = {};
    ['x-hwid-max-devices-reached', 'x-hwid-limit', 'x-hwid-not-supported'].forEach((key) => {
      const hit = headerSources.find((headers) => headers && isTruthyHeader(headers[key]));
      if (hit) mergedHeaders[key] = hit[key];
    });
    headerSources.forEach((headers) => {
      Object.entries(headers || {}).forEach(([key, value]) => {
        const cleanKey = String(key || '').trim().toLowerCase();
        if (cleanKey.startsWith('x-hwid-') && mergedHeaders[cleanKey] == null) {
          mergedHeaders[cleanKey] = value;
        }
      });
    });
    const limitInfo = mergeLimitInfo(
      probe.hwid_limit_info,
      payload && typeof payload === 'object' ? payload.hwid_limit_info : null,
      limitInfoFromHeaders(mergedHeaders),
    );
    const suppressNotSupported = (
      String(probe.provider_mode || '') === 'hwid_adapter' &&
      (limitInfo.reached || isTruthyHeader(mergedHeaders['x-hwid-max-devices-reached']) || isTruthyHeader(mergedHeaders['x-hwid-limit']))
    );
    if (suppressNotSupported) {
      delete mergedHeaders['x-hwid-not-supported'];
    }
    messages.push(...providerHeaderWarnings(mergedHeaders, limitInfo, { suppressNotSupported }));
    if (payload && payload.hwid_placeholder_provider && String(payload.hwid_placeholder_reason || '') === 'device_limit') {
      messages.push(formatLimitWarning(payload.hwid_limit_info || { reached: true }));
    }
    (Array.isArray(probe.warnings) ? probe.warnings : []).forEach((warning) => {
      if (!warning || typeof warning !== 'object') return;
      const code = String(warning.code || '').trim();
      if ((code === 'HWID_MAX_DEVICES_REACHED' || code === 'HWID_LIMIT_REACHED') && limitInfo.reached) return;
      if (code === 'HWID_PROVIDER_EMPTY' && payload && payload.hwid_placeholder_provider) return;
      if (code === 'HWID_NOT_SUPPORTED' && (suppressNotSupported || isTruthyHeader(mergedHeaders['x-hwid-not-supported']))) return;
      messages.push(warning.hint || warning.message || warning.code || '');
    });
    return uniqueStrings(messages);
  }

  function providerOutputWarnings(output) {
    if (!output || typeof output !== 'object') return [];
    if (Array.isArray(output.provider_warnings)) {
      return uniqueStrings(output.provider_warnings);
    }
    const payload = output.provider_payload || null;
    const payloadPlaceholderWarnings = [];
    if (payload && payload.hwid_placeholder_provider && String(payload.hwid_placeholder_reason || '') === 'device_limit') {
      payloadPlaceholderWarnings.push(formatLimitWarning(payload.hwid_limit_info || { reached: true }));
    }
    return uniqueStrings([
      ...payloadPlaceholderWarnings,
      ...providerHeaderWarnings(output.hwid_response_headers, output.hwid_limit_info),
      ...providerHeaderWarnings(
        payload && payload.hwid_response_headers,
        payload && payload.hwid_limit_info,
      ),
    ]);
  }

  function clampXrayIntervalHours(value) {
    let hours = Number.parseInt(String(value || '').trim(), 10);
    if (!Number.isFinite(hours)) hours = XRAY_DEFAULT_INTERVAL_HOURS;
    return Math.max(XRAY_MIN_INTERVAL_HOURS, Math.min(XRAY_MAX_INTERVAL_HOURS, hours));
  }

  function pluralRu(count, forms) {
    const n = Math.abs(Number(count) || 0);
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return forms[0];
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
    return forms[2];
  }

  function loadXrayIntervalPref() {
    try {
      if (window.localStorage) {
        const value = localStorage.getItem(XRAY_INTERVAL_PREF_KEY);
        if (value) return clampXrayIntervalHours(value);
      }
    } catch (e) {}
    return XRAY_DEFAULT_INTERVAL_HOURS;
  }

  function saveXrayIntervalPref(value) {
    try {
      if (window.localStorage) localStorage.setItem(XRAY_INTERVAL_PREF_KEY, String(clampXrayIntervalHours(value)));
    } catch (e) {}
  }

  function readXrayIntervalHours() {
    const input = $(IDS.xrayInterval);
    const hours = clampXrayIntervalHours(input ? input.value : loadXrayIntervalPref());
    if (input) {
      try { input.value = String(hours); } catch (e) {}
    }
    return hours;
  }

  function xrayBulkOutputs(outputs) {
    return (Array.isArray(outputs) ? outputs : []).filter((item) => item && item.xrayBulk && item.type === 'proxy');
  }

  function providerStaticBulkOutputs(outputs) {
    return (Array.isArray(outputs) ? outputs : []).filter((item) => item && item.providerStaticBulk && item.type === 'proxy');
  }

  function groupXrayOutputsByUri(outputs) {
    const map = new Map();
    xrayBulkOutputs(outputs).forEach((item) => {
      const uri = String(item && item.uri || '').trim();
      if (!uri) return;
      if (!map.has(uri)) map.set(uri, []);
      map.get(uri).push(item);
    });
    return Array.from(map.entries()).map(([uri, items]) => ({ uri, items }));
  }

  function groupProviderStaticOutputsByUri(outputs) {
    const map = new Map();
    providerStaticBulkOutputs(outputs).forEach((item) => {
      const uri = String(item && item.uri || '').trim();
      if (!uri) return;
      if (!map.has(uri)) map.set(uri, []);
      map.get(uri).push(item);
    });
    return Array.from(map.entries()).map(([uri, items]) => ({ uri, items }));
  }

  function isConfigManagedXraySubscription(sub) {
    if (!sub || typeof sub !== 'object') return false;
    const source = String(sub.source || '').trim().toLowerCase();
    if (source === 'config') return true;
    return Array.isArray(sub.proxy_names) || Array.isArray(sub.proxyNames) || !!sub.managed_yaml;
  }

  function managedConfigXraySubscriptions() {
    return (Array.isArray(_managedXraySubscriptions) ? _managedXraySubscriptions : [])
      .filter(isConfigManagedXraySubscription);
  }

  function formatXraySubTime(ts) {
    const value = Number(ts || 0);
    if (!Number.isFinite(value) || value <= 0) return 'не запланировано';
    try {
      return new Date(value * 1000).toLocaleString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch (e) {}
    return 'запланировано';
  }

  function markMihomoEditorModified() {
    try {
      if (typeof window.updateLastActivity === 'function') {
        const fp = getXkeenFilePath('mihomo', '/opt/etc/mihomo/config.yaml');
        window.updateLastActivity('modified', 'mihomo', fp);
      }
    } catch (e) {}
  }

  function makeManagedIconButton(icon, label, onClick, extraClass) {
    const safeLabel = String(label || '');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-secondary xk-mi-managed-btn' + (extraClass ? ' ' + extraClass : '');
    btn.textContent = String(icon || '');
    btn.setAttribute('aria-label', safeLabel);
    btn.setAttribute('title', safeLabel);
    btn.setAttribute('data-tooltip', safeLabel);
    btn.onclick = onClick;
    return btn;
  }

  function renderManagedXraySubscriptions() {
    const list = $(IDS.xrayManagedList);
    if (!list) return;
    list.textContent = '';

    const subs = managedConfigXraySubscriptions();
    if (!subs.length) return;

    subs.forEach((sub) => {
      const item = document.createElement('div');
      item.className = 'mihomo-managed-sub-item xk-mi-managed-row';

      const copy = document.createElement('div');
      copy.className = 'xk-mi-managed-copy';

      const title = document.createElement('div');
      title.className = 'mihomo-managed-sub-title';
      title.textContent = String((sub && (sub.tag || sub.id || sub.url)) || 'Xray-JSON');

      const count = Number(
        sub && sub.last_count
          ? sub.last_count
          : (Array.isArray(sub && sub.proxy_names) ? sub.proxy_names.length : 0),
      );
      const intervalHours = clampXrayIntervalHours(sub && sub.interval_hours);
      const enabled = !(sub && sub.enabled === false);
      const nodeText = count ? `${count} ${pluralRu(count, ['узел', 'узла', 'узлов'])}` : 'узлы из config.yaml';
      const stateText = enabled ? 'активна' : 'на паузе';

      const meta = document.createElement('div');
      meta.className = 'mihomo-managed-sub-meta';
      meta.textContent =
        `${stateText} · ${nodeText} · каждые ${intervalHours} ч · след.: ` +
        (enabled ? formatXraySubTime(sub && sub.next_update_ts) : 'не запланировано');

      copy.appendChild(title);
      copy.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'mihomo-managed-sub-actions xk-mi-managed-actions';

      const intervalInput = document.createElement('input');
      intervalInput.type = 'number';
      intervalInput.min = '1';
      intervalInput.max = '168';
      intervalInput.step = '1';
      intervalInput.value = String(intervalHours);
      intervalInput.className = 'xray-log-select mihomo-managed-sub-interval xk-mi-managed-interval';
      intervalInput.title = 'Интервал обновления: от 1 до 168 часов';

      const intervalLabel = document.createElement('span');
      intervalLabel.className = 'mihomo-managed-sub-interval-label';
      intervalLabel.textContent = 'ч';

      const saveBtn = makeManagedIconButton('💾', 'Сохранить интервал обновления', () => saveManagedXraySubscription(String(sub.id || ''), {
        interval_hours: intervalInput.value,
      }));

      const toggleBtn = makeManagedIconButton(
        enabled ? '⏸' : '▶',
        enabled ? 'Поставить автообновление на паузу' : 'Включить автообновление',
        () => saveManagedXraySubscription(String(sub.id || ''), {
          enabled: !enabled,
          interval_hours: intervalInput.value,
        }),
      );

      const refreshBtn = makeManagedIconButton(
        '↻',
        'Обновить подписку сейчас',
        () => refreshManagedXraySubscription(String(sub.id || '')),
      );

      const detachBtn = makeManagedIconButton(
        '⛓',
        'Убрать из автообновления, прокси оставить',
        () => deleteManagedXraySubscription(String(sub.id || ''), false),
      );

      const removeBtn = makeManagedIconButton(
        '🗑',
        'Удалить автообновление и proxy-блоки',
        () => deleteManagedXraySubscription(String(sub.id || ''), true),
        'xk-mi-managed-btn--danger',
      );

      actions.appendChild(intervalInput);
      actions.appendChild(intervalLabel);
      actions.appendChild(saveBtn);
      actions.appendChild(toggleBtn);
      actions.appendChild(refreshBtn);
      actions.appendChild(detachBtn);
      actions.appendChild(removeBtn);

      item.appendChild(copy);
      item.appendChild(actions);
      list.appendChild(item);
    });
  }

  function updateXrayRefreshUi(outputs) {
    const block = $(IDS.xrayRefreshBlock);
    const note = $(IDS.xrayRefreshNote);
    const input = $(IDS.xrayInterval);
    const xrayGroups = groupXrayOutputsByUri(outputs);
    const providerGroups = groupProviderStaticOutputsByUri(outputs);
    const groups = xrayGroups.concat(providerGroups);
    if (!block) return;
    const hasManagedImport = groups.length > 0;
    const managed = managedConfigXraySubscriptions();
    block.classList.toggle('hidden', !hasManagedImport && !managed.length);
    try {
      const field = input && input.closest ? input.closest('.xk-mi-refresh-field') : null;
      if (field) field.style.display = hasManagedImport ? '' : 'none';
    } catch (e) {}
    if (input && !String(input.value || '').trim()) {
      input.value = String(loadXrayIntervalPref());
    }
    renderManagedXraySubscriptions();
    if (note) {
      const count = groups.reduce((sum, group) => sum + group.items.length, 0);
      const subWord = pluralRu(groups.length, ['подписка', 'подписки', 'подписок']);
      const nodeWord = pluralRu(count, ['узел', 'узла', 'узлов']);
      if (hasManagedImport) {
        note.textContent = `Будет создана запись автообновления: ${groups.length} ${subWord}, ${count} ${nodeWord}. Интервал применится при «Вставить в конфиг».`;
      } else if (managed.length) {
        const managedWord = pluralRu(managed.length, ['подписка уже управляется', 'подписки уже управляются', 'подписок уже управляется']);
        note.textContent = `${managed.length} ${managedWord}. Для существующей записи интервал меняется кнопкой сохранения.`;
      } else {
        note.textContent = 'От 1 часа до 7 дней. Отдельная кнопка сохранения не нужна: интервал применяется при вставке в конфиг.';
      }
    }
  }

  async function requestSubscriptionJson(url, options) {
    const opts = options || {};
    const init = {
      method: opts.method || 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body || {});
    const res = await fetch(url, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || (data && data.ok === false)) {
      const err = new Error((data && data.error) || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  async function loadManagedXraySubscriptions(silent) {
    try {
      const data = await requestSubscriptionJson('/api/mihomo/subscriptions');
      _managedXraySubscriptions = Array.isArray(data.subscriptions) ? data.subscriptions : [];
      updateXrayRefreshUi((_lastResult && _lastResult.outputs) || []);
      return _managedXraySubscriptions;
    } catch (e) {
      _managedXraySubscriptions = [];
      updateXrayRefreshUi((_lastResult && _lastResult.outputs) || []);
      if (!silent) {
        toastMsg('Не удалось прочитать автообновление Mihomo: ' + (e && e.message ? e.message : String(e || 'ошибка')), true);
      }
      return [];
    }
  }

  async function saveManagedXraySubscription(subId, payload) {
    const id = String(subId || '').trim();
    if (!id) return;
    try {
      const body = {
        ...(payload || {}),
        interval_hours: clampXrayIntervalHours(payload && payload.interval_hours),
      };
      await requestSubscriptionJson('/api/mihomo/subscriptions/' + encodeURIComponent(id), {
        method: 'POST',
        body,
      });
      await loadManagedXraySubscriptions(true);
      toastMsg('Настройки автообновления сохранены.', false);
    } catch (e) {
      toastMsg('Не удалось сохранить автообновление: ' + (e && e.message ? e.message : String(e || 'ошибка')), true);
      await loadManagedXraySubscriptions(true);
    }
  }

  async function refreshManagedXraySubscription(subId) {
    const id = String(subId || '').trim();
    if (!id) return;
    try {
      const data = await requestSubscriptionJson('/api/mihomo/subscriptions/' + encodeURIComponent(id) + '/refresh', {
        method: 'POST',
      });
      await loadManagedXraySubscriptions(true);
      const count = Number(data && data.count ? data.count : 0);
      toastMsg(
        data && data.changed
          ? `Подписка обновлена: ${count} ${pluralRu(count, ['узел', 'узла', 'узлов'])}.`
          : 'Подписка проверена: изменений нет.',
        false,
      );
    } catch (e) {
      const code = String((e && e.data && (e.data.error || e.data.code)) || '');
      const msg = code === 'active_config_changed'
        ? 'Активный config.yaml менялся после последней синхронизации. Обновление остановлено, чтобы не перетереть правки.'
        : 'Не удалось обновить подписку: ' + (e && e.message ? e.message : String(e || 'ошибка'));
      toastMsg(msg, true);
      await loadManagedXraySubscriptions(true);
    }
  }

  async function deleteManagedXraySubscription(subId, removeBlocks) {
    const id = String(subId || '').trim();
    if (!id) return;

    const ok = await confirmMihomoAction({
      title: removeBlocks ? 'Удалить Xray-JSON прокси из config.yaml?' : 'Убрать Xray-JSON из автообновления?',
      message: removeBlocks
        ? 'Запись автообновления будет удалена, а связанные proxy-блоки будут вырезаны из текущего редактора config.yaml.'
        : 'Прокси останутся в config.yaml, но панель больше не будет обновлять и перезаписывать этот блок.',
      details: removeBlocks
        ? ['После удаления сохрани config.yaml, чтобы применить правку на роутере.']
        : ['Эту подписку можно будет импортировать заново позже.'],
      okText: removeBlocks ? 'Удалить прокси' : 'Убрать авто',
      cancelText: 'Отмена',
      danger: !!removeBlocks,
    }, removeBlocks
      ? 'Удалить запись автообновления и proxy-блоки из config.yaml?'
      : 'Убрать подписку из автообновления?');
    if (!ok) return;

    try {
      const body = { remove_blocks: !!removeBlocks };
      if (removeBlocks) body.content = getEditorText() || '';
      const data = await requestSubscriptionJson('/api/mihomo/subscriptions/' + encodeURIComponent(id), {
        method: 'DELETE',
        body,
      });
      if (removeBlocks && data && typeof data.content === 'string') {
        setEditorText(data.content);
        refreshEditor();
        markMihomoEditorModified();
      }
      await loadManagedXraySubscriptions(true);
      toastMsg(
        removeBlocks
          ? 'Автообновление удалено, proxy-блок вырезан из текущего config.yaml.'
          : 'Подписка убрана из автообновления. Proxy-блок остался в config.yaml.',
        false,
      );
    } catch (e) {
      toastMsg('Не удалось удалить подписку: ' + (e && e.message ? e.message : String(e || 'ошибка')), true);
      await loadManagedXraySubscriptions(true);
    }
  }

  function cmThemeFromPage() {
    const t = document.documentElement.getAttribute('data-theme');
    return t === 'light' ? 'default' : 'material-darker';
  }

  // ---------------------------------------------------------------------------
  // Proxy-groups UI helpers
  // ---------------------------------------------------------------------------

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function _stripQuotes(s) {
    const v = String(s || '').trim();
    if (!v) return '';
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      return v.slice(1, -1);
    }
    return v;
  }

  function parseProxyGroupNamesFromYaml(yamlText) {
    const lines = String(yamlText || '').replace(/\r\n?/g, '\n').split('\n');
    let inGroups = false;
    let baseIndent = 0;
    const out = [];

    for (let i = 0; i < lines.length; i++) {
      const ln = String(lines[i] || '');
      const mStart = ln.match(/^(\s*)proxy-groups\s*:\s*(#.*)?$/);
      if (mStart) {
        inGroups = true;
        baseIndent = (mStart[1] || '').length;
        continue;
      }
      if (!inGroups) continue;

      if (!ln.trim()) continue;

      const indent = (ln.match(/^(\s*)/) || ['', ''])[1].length;
      const ts = ln.replace(/^\s+/, '');

      // End of proxy-groups block when a new top-level key starts
      if (indent <= baseIndent && !ts.startsWith('#') && !ts.startsWith('-') && /^[A-Za-z0-9_\-]+\s*:/.test(ts)) {
        inGroups = false;
        continue;
      }

      const mName = ln.match(/^\s*-\s*name\s*:\s*(.+?)\s*(#.*)?$/);
      if (mName) {
        let raw = String(mName[1] || '').trim();
        // Remove trailing inline comment (best-effort)
        raw = raw.replace(/\s+#.*$/, '').trim();
        const name = _stripQuotes(raw);
        if (name && out.indexOf(name) === -1) out.push(name);
      }
    }
    return out;
  }

  function loadGroupPrefs() {
    let remember = false;
    let selected = [];
    try {
      if (window.localStorage) {
        remember = localStorage.getItem(GROUPS_REMEMBER_KEY) === '1';
        const raw = localStorage.getItem(GROUPS_PREF_KEY);
        if (raw) {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) selected = arr.map((x) => String(x || '').trim()).filter(Boolean);
        }
      }
    } catch (e) {}
    return { remember, selected };
  }

  function saveGroupPrefs(selected, remember) {
    try {
      if (!window.localStorage) return;
      localStorage.setItem(GROUPS_REMEMBER_KEY, remember ? '1' : '0');
      if (remember) localStorage.setItem(GROUPS_PREF_KEY, JSON.stringify(selected || []));
    } catch (e) {}
  }

  function renderGroupCheckboxes(names, selectedSet) {
    const box = $(IDS.groupsBox);
    if (!box) return;

    const sel = selectedSet || new Set();

    if (!names || !names.length) {
      box.innerHTML = '<div class="xk-card-desc" style="opacity:0.75;">Группы <code>proxy-groups</code> не найдены в текущем <code>config.yaml</code>.</div>';
      return;
    }

    const parts = [];
    for (const name of names) {
      const checked = sel.has(name) ? ' checked' : '';
      parts.push(
        '<label class="global-autorestart-toggle" style="display:flex; gap:10px; align-items:center; margin:4px 0;">' +
          '<input type="checkbox" class="mihomo-import-group-cb" data-group="' + escapeHtml(name) + '"' + checked + '>' +
          '<span>' + escapeHtml(name) + '</span>' +
        '</label>'
      );
    }
    box.innerHTML = parts.join('');
  }

  function readSelectedGroupsFromUi() {
    const box = $(IDS.groupsBox);
    if (!box) return [];
    const cbs = Array.from(box.querySelectorAll('input.mihomo-import-group-cb'));
    return cbs
      .filter((cb) => cb && cb.checked)
      .map((cb) => String(cb.dataset && cb.dataset.group ? cb.dataset.group : '').trim())
      .filter(Boolean);
  }

  function setAllGroupsChecked(checked) {
    const box = $(IDS.groupsBox);
    if (!box) return;
    const cbs = Array.from(box.querySelectorAll('input.mihomo-import-group-cb'));
    cbs.forEach((cb) => { try { cb.checked = !!checked; } catch (e) {} });
  }

  function refreshGroupsUiFromConfig() {
    const cfg = getEditorText() || '';
    const names = parseProxyGroupNamesFromYaml(cfg);

    const prefs = loadGroupPrefs();
    const rememberCb = $(IDS.groupsRemember);
    const remember = rememberCb ? !!rememberCb.checked : prefs.remember;

    // If remember checkbox exists, sync it from stored prefs when opening modal
    if (rememberCb) {
      try { rememberCb.checked = !!prefs.remember; } catch (e) {}
    }

    const selected = (prefs.remember && Array.isArray(prefs.selected)) ? new Set(prefs.selected) : new Set();
    renderGroupCheckboxes(names, selected);
  }

  function maybePersistGroupsSelection() {
    const rememberCb = $(IDS.groupsRemember);
    const remember = !!(rememberCb && rememberCb.checked);
    const selected = readSelectedGroupsFromUi();
    saveGroupPrefs(selected, remember);
  }


  function normalizeEngine(v) {
    const s = String(v || '').toLowerCase();
    return (s === 'monaco' || s === 'codemirror') ? s : 'codemirror';
  }

  function getEngineHelper() {
    return getMihomoEditorEngineApi();
  }

  const CM6_SCOPE = 'mihomo-import';

  function withCm6Scope(opts) {
    return Object.assign({ cm6Scope: CM6_SCOPE, scope: CM6_SCOPE }, opts || {});
  }

  function getEditorRuntime(engine, opts) {
    const helper = getEngineHelper();
    if (!helper || typeof helper.getRuntime !== 'function') return null;
    try { return helper.getRuntime(engine, withCm6Scope(opts)); } catch (e) {}
    return null;
  }

  async function ensureEditorRuntime(engine, opts) {
    const helper = getEngineHelper();
    if (!helper) return null;
    try {
      if (typeof helper.ensureRuntime === 'function') return await helper.ensureRuntime(engine, withCm6Scope(opts));
      if (typeof helper.getRuntime === 'function') return helper.getRuntime(engine, withCm6Scope(opts));
    } catch (e) {}
    return null;
  }

  function isCm6Runtime(runtime) {
    try { return !!(runtime && runtime.backend === 'cm6'); } catch (e) {}
    return false;
  }

  function isCm6Editor(editor) {
    try {
      if (!editor) return false;
      if (editor.__xkeenCm6Bridge || editor.backend === 'cm6') return true;
      const wrap = (typeof editor.getWrapperElement === 'function') ? editor.getWrapperElement() : null;
      return !!(wrap && wrap.classList && wrap.classList.contains('xkeen-cm6-editor'));
    } catch (e) {}
    return false;
  }

  function disposeCodeMirrorEditor(editor) {
    if (!editor) return false;
    try { if (typeof editor.dispose === 'function') return !!editor.dispose(); } catch (e) {}
    try {
      if (typeof editor.toTextArea === 'function') {
        editor.toTextArea();
        return true;
      }
    } catch (e) {}
    return false;
  }

  function createCodeMirrorFacade(cm) {
    if (!cm) return null;
    const runtime = getEditorRuntime('codemirror');
    if (runtime && typeof runtime.toFacade === 'function') {
      try {
        return runtime.toFacade(cm, {
          layout: () => {
            try { if (cm.layout) cm.layout(); else if (cm.refresh) cm.refresh(); } catch (e) {}
          },
        });
      } catch (e) {}
    }
    const helper = getEngineHelper();
    if (!helper || typeof helper.fromCodeMirror !== 'function') return null;
    try {
      return helper.fromCodeMirror(cm, {
        layout: () => {
          try { if (cm.layout) cm.layout(); else if (cm.refresh) cm.refresh(); } catch (e) {}
        },
      });
    } catch (e) {}
    return null;
  }

  function showNode(node) {
    if (!node) return;
    try { node.classList.remove('hidden'); } catch (e) {}
    try { node.style.display = ''; } catch (e2) {}
  }

  function hideNode(node) {
    if (!node) return;
    try { node.classList.add('hidden'); } catch (e) {}
    try { node.style.display = 'none'; } catch (e2) {}
  }

  function cmWrapper(cm) {
    try { return (cm && typeof cm.getWrapperElement === 'function') ? cm.getWrapperElement() : null; } catch (e) { return null; }
  }

  function modalOpen() {
    const m = $(IDS.modal);
    return !!(m && !m.classList.contains('hidden'));
  }

  function setEngineSelectValue(engine) {
    const sel = $(IDS.engineSelect);
    if (!sel) return;
    try { sel.value = normalizeEngine(engine); } catch (e) {}
  }

  async function resolvePreferredEngine() {
    let engine = 'codemirror';
    const ee = getEngineHelper();
    try {
      if (ee && typeof ee.ensureLoaded === 'function') engine = normalizeEngine(await ee.ensureLoaded());
      else if (ee && typeof ee.get === 'function') engine = normalizeEngine(ee.get());
    } catch (e) {
      try { engine = normalizeEngine(ee && ee.get ? ee.get() : 'codemirror'); } catch (e2) { engine = 'codemirror'; }
    }
    return engine;
  }

  function previewTextFallback() {
    try { if (_previewLastText) return String(_previewLastText || ''); } catch (e) {}
    try {
      if (_previewKind === 'monaco' && _previewMonacoFacade && _previewMonacoFacade.getValue) return String(_previewMonacoFacade.getValue() || '');
    } catch (e2) {}
    try {
      if (_previewCmFacade && _previewCmFacade.getValue) return String(_previewCmFacade.getValue() || '');
    } catch (e3) {}
    try {
      if (_previewCm && _previewCm.getValue) return String(_previewCm.getValue() || '');
    } catch (e4) {}
    const ta = $(IDS.preview);
    return ta ? String(ta.value || '') : '';
  }

  function disposePreviewMonaco() {
    try {
      if (_previewMonacoFacade && _previewMonacoFacade.dispose) _previewMonacoFacade.dispose();
      else if (_previewMonaco && _previewMonaco.dispose) _previewMonaco.dispose();
    } catch (e) {}
    _previewMonaco = null;
    _previewMonacoFacade = null;
  }

  async function activatePreviewEngine(engine) {
    const next = normalizeEngine(engine);
    const host = $(IDS.monacoHost);
    const ta = $(IDS.preview);

    if (next === 'monaco') {
      const runtime = await ensureEditorRuntime('monaco');
      if (!runtime || !host || typeof runtime.create !== 'function') {
        try { if (window.toast) window.toast('Monaco недоступен — используется CodeMirror', 'warning'); } catch (e0) {}
        const ee = getEngineHelper();
        try { if (ee && ee.set) await ee.set('codemirror'); } catch (e1) {}
        return activatePreviewEngine('codemirror');
      }

      // Hide CodeMirror/textarea, show Monaco host
      const w = cmWrapper(_previewCm);
      if (w) hideNode(w);
      if (ta) hideNode(ta);
      showNode(host);

      const value = previewTextFallback();

      if (!_previewMonaco) {
        const ed = await runtime.create(host, {
          language: 'yaml',
          readOnly: true,
          value: value,
          tabSize: 2,
          insertSpaces: true,
          wordWrap: 'on',
        });
        if (!ed) {
          try { if (window.toast) window.toast('Не удалось загрузить Monaco — переключаю на CodeMirror', 'warning'); } catch (e2) {}
          const ee = getEngineHelper();
          try { if (ee && ee.set) await ee.set('codemirror'); } catch (e3) {}
          if (host) hideNode(host);
          return activatePreviewEngine('codemirror');
        }
        _previewMonaco = ed;
        try {
          const helper = getEngineHelper();
          _previewMonacoFacade = (helper && typeof helper.fromMonaco === 'function') ? helper.fromMonaco(ed) : null;
        } catch (e4) {
          _previewMonacoFacade = null;
        }
        try { if (runtime.layoutOnVisible) runtime.layoutOnVisible(ed, host); } catch (e5) {}
      } else if (_previewMonacoFacade && _previewMonacoFacade.setValue) {
        _previewMonacoFacade.setValue(value);
      }

      _previewKind = 'monaco';
      try { if (_previewMonacoFacade) _previewMonacoFacade.scrollTo(0, 0); } catch (e6) {}
      try { layoutPreviewEditor(); } catch (e7) {}
      return 'monaco';
    }

    // CodeMirror
    if (host) hideNode(host);
    try { disposePreviewMonaco(); } catch (e) {}

    try {
      const runtime = await ensureEditorRuntime('codemirror', { mode: 'yaml' });
      if (runtime && typeof runtime.ensureAssets === 'function') {
        await runtime.ensureAssets({ mode: 'yaml' });
      }
    } catch (e) {}

    const cm = ensurePreviewCm();
    const value = previewTextFallback();

    if (cm && cm.setOption) {
      try { cm.setOption('theme', cmThemeFromPage()); } catch (e1) {}
    }

    if (cm && cm.setValue) {
      try {
        cm.setValue(value);
        cm.scrollTo(0, 0);
        setTimeout(() => { try { cm.refresh(); } catch (e2) {} }, 30);
      } catch (e3) {}
      const w = cmWrapper(cm);
      if (w) showNode(w);
      if (ta) hideNode(ta);
    } else {
      if (ta) {
        try { ta.value = value; } catch (e4) {}
        showNode(ta);
      }
    }

    _previewKind = 'codemirror';
    try { layoutPreviewEditor(); } catch (e5) {}
    return 'codemirror';
  }

  async function syncEngineNow() {
    if (_engineSyncing) return;
    _engineSyncing = true;
    try {
      const engine = await resolvePreferredEngine();
      setEngineSelectValue(engine);
      if (modalOpen()) await activatePreviewEngine(engine);
    } finally {
      _engineSyncing = false;
    }
  }

  function scheduleEngineSync() {
    try { setTimeout(() => { try { syncEngineNow(); } catch (e) {} }, 0); } catch (e) {}
  }

  function layoutPreviewEditor() {
    try {
      if (_previewLayoutRaf) return;
      _previewLayoutRaf = requestAnimationFrame(() => {
        _previewLayoutRaf = 0;
        try {
          if (_previewCm) {
            if (typeof _previewCm.setSize === 'function') _previewCm.setSize(null, '100%');
            if (typeof _previewCm.refresh === 'function') _previewCm.refresh();
            else if (typeof _previewCm.layout === 'function') _previewCm.layout();
          }
        } catch (e1) {}
        try {
          if (_previewCmFacade && typeof _previewCmFacade.layout === 'function') _previewCmFacade.layout();
        } catch (e2) {}
        try {
          if (_previewMonacoFacade && typeof _previewMonacoFacade.layout === 'function') _previewMonacoFacade.layout();
          else if (_previewMonaco && typeof _previewMonaco.layout === 'function') _previewMonaco.layout();
        } catch (e3) {}
      });
    } catch (e) {
      try { if (_previewCm && typeof _previewCm.refresh === 'function') _previewCm.refresh(); } catch (e2) {}
      try { if (_previewMonaco && typeof _previewMonaco.layout === 'function') _previewMonaco.layout(); } catch (e3) {}
    }
  }

  function bindPreviewResizeObserver() {
    const modal = $(IDS.modal);
    if (!modal || (modal.dataset && modal.dataset.mihomoImportPreviewResizeBound === '1')) return;
    try {
      const content = modal.querySelector ? modal.querySelector('.modal-content') : null;
      if (content && typeof ResizeObserver !== 'undefined') {
        _previewResizeObserver = new ResizeObserver(() => {
          if (!modalOpen()) return;
          layoutPreviewEditor();
        });
        _previewResizeObserver.observe(content);
      }
    } catch (e) {}
    try {
      window.addEventListener('resize', () => {
        if (modalOpen()) layoutPreviewEditor();
      });
    } catch (e2) {}
    try {
      document.addEventListener('xkeen-modal-resize', (event) => {
        const detail = event && event.detail ? event.detail : {};
        if (detail.modal && detail.modal !== IDS.modal) return;
        if (modalOpen()) layoutPreviewEditor();
      });
    } catch (e3) {}
    if (modal.dataset) modal.dataset.mihomoImportPreviewResizeBound = '1';
  }


  function ensurePreviewCm() {
    const ta = $(IDS.preview);
    if (!ta) return null;

    const runtime = getEditorRuntime('codemirror');
    const preferCm6 = isCm6Runtime(runtime);

    if (_previewCm) {
      if (!preferCm6 || isCm6Editor(_previewCm)) return _previewCm;
      try { disposeCodeMirrorEditor(_previewCm); } catch (e) {}
      _previewCm = null;
      _previewCmFacade = null;
    }

    if (!runtime || typeof runtime.create !== 'function') return null;

    _previewCm = runtime.create(ta, {
      mode: 'yaml',
      theme: cmThemeFromPage(),
      lineNumbers: false,
      lineWrapping: true,
      readOnly: 'nocursor',
      tabSize: 2,
      indentUnit: 2,
      viewportMargin: Infinity,
    });

    try {
      const w = _previewCm.getWrapperElement();
      w.classList.add('xkeen-cm', 'xk-mihomo-import-preview');
      if (typeof _previewCm.setSize === 'function') _previewCm.setSize(null, '100%');
      else if (w) w.style.height = '100%';
    } catch (e) {}

    _previewCmFacade = createCodeMirrorFacade(_previewCm);
    return _previewCm;
  }

  function setPreview(text) {
    const v = String(text || '');
    _previewLastText = v;

    try {
      if (_previewKind === 'monaco' && _previewMonacoFacade && _previewMonacoFacade.setValue) {
        _previewMonacoFacade.setValue(v);
        try { _previewMonacoFacade.scrollTo(0, 0); } catch (e2) {}
        return;
      }
    } catch (e) {}

    if (_previewCmFacade && _previewCmFacade.set) {
      _previewCmFacade.set(v);
      try { _previewCmFacade.scrollTo(0, 0); } catch (e2) {}
      return;
    }
    if (_previewCm && _previewCm.setValue) {
      _previewCm.setValue(v);
      try { _previewCm.scrollTo(0, 0); } catch (e2) {}
      return;
    }
    const el = $(IDS.preview);
    if (el) el.value = v;
  }

  function getEditorText() {
    try {
      const api = getMihomoPanelApi();
      if (api && typeof api.getEditorText === 'function') {
        return api.getEditorText();
      }
    } catch (e2) {}
    // fallback
    const ta = $('mihomo-editor');
    return ta ? String(ta.value || '') : '';
  }

  function setEditorText(text) {
    try {
      const api = getMihomoPanelApi();
      if (api && typeof api.setEditorText === 'function') return api.setEditorText(text);
    } catch (e) {}
    const ta = $('mihomo-editor');
    if (ta) ta.value = String(text || '');
  }

  function refreshEditor() {
    refreshSharedMihomoEditor();
  }

  function showModal(show) {
    const modal = $(IDS.modal);
    if (!modal) return;
    try {
      if (show) modal.classList.remove('hidden');
      else modal.classList.add('hidden');
    } catch (e) {}
    try {
      syncMihomoModalBodyScrollLock();
    } catch (e2) {}

    if (show) {
      // reset
      _lastResult = null;
      setStatus('', false);
      setHint('');
      setPreview('');
      try {
        const intervalInput = $(IDS.xrayInterval);
        if (intervalInput) intervalInput.value = String(loadXrayIntervalPref());
        updateXrayRefreshUi([]);
        loadManagedXraySubscriptions(true);
      } catch (e4d) {}
      const ins = $(IDS.btnInsert);
      if (ins) ins.disabled = true;

      // Load proxy-groups list from current config.yaml
      try { refreshGroupsUiFromConfig(); } catch (e4a) {}

      // Import mode (persisted)
      try { setImportMode(loadImportModePref()); } catch (e4b) {}
      try { updateModeUi(); } catch (e4c) {}

      // Activate preferred editor engine (CodeMirror / Monaco)
      try { scheduleEngineSync(); } catch (e4) {}

      try {
        const inp = $(IDS.input);
        if (inp) inp.focus();
      } catch (e3) {}
      try { layoutPreviewEditor(); } catch (e5) {}
    }
  }

  function wireButton(id, fn) {
    const el = $(id);
    if (!el) return;
    if (el.dataset && el.dataset.xkWired === '1') return;
    el.addEventListener('click', (e) => {
      e.preventDefault();
      try {
        const r = fn(e);
        if (r && typeof r.then === 'function') {
          r.catch((err) => { try { console.error(err); } catch (e2) {} });
        }
      } catch (err) {
        console.error(err);
      }
    });
    if (el.dataset) el.dataset.xkWired = '1';
  }

  // ---------------------------------------------------------------------------
  // Parser (adapted from outboundParser.js) - Mihomo only
  // ---------------------------------------------------------------------------

  const safeBase64 = (str) =>
    atob(
      str
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(str.length + ((4 - (str.length % 4)) % 4), '='),
    );

  const YAML_STRING_VALUE_KEYS = new Set(['short-id']);
  const YAML_KEYWORDS = new Set(['null', '~', 'true', 'false', 'yes', 'no', 'on', 'off']);
  const YAML_NEEDS_QUOTING_RE = /[\s:#\[\]{}&,*>!%`"'|@?]/;

  function yamlStringScalar(value) {
    const s = String(value == null ? '' : value).replace(/\r/g, '').replace(/\n/g, ' ');
    const low = s.trim().toLowerCase();
    if (
      s === '' ||
      YAML_KEYWORDS.has(low) ||
      YAML_NEEDS_QUOTING_RE.test(s) ||
      /^[-?:&*]/.test(s) ||
      (s.trim() !== '' && Number.isFinite(Number(s)))
    ) {
      return "'" + s.replace(/'/g, "''") + "'";
    }
    return s;
  }

  const toYaml = (obj, indent = 0) => {
    const padding = ' '.repeat(indent);
    return Object.entries(obj).reduce((result, [key, value]) => {
      if (value == null || (value === '' && key !== 'encryption')) return result;
      if (Array.isArray(value))
        return value.length
          ? result + `${padding}${key}:\n` + value.map((item) => `${padding}  - ${item}`).join('\n') + '\n'
          : result;
      if (typeof value === 'object') {
        const nested = toYaml(value, indent + 2);
        return nested.trim() ? result + `${padding}${key}:\n${nested}` : result;
      }
      const rendered =
        key === 'encryption' && value === ''
          ? '""'
          : (typeof value === 'string' || YAML_STRING_VALUE_KEYS.has(key) ? yamlStringScalar(value) : value);
      return result + `${padding}${key}: ${rendered}\n`;
    }, '');
  };

  const decodeMaybe = (value) => {
    if (value == null || value === '') return undefined;
    try { return decodeURIComponent(String(value)); } catch (e) {}
    return String(value);
  };

  const normalizeMihomoVlessFlow = (value) => {
    const flow = String(value || '').trim();
    if (!flow) return undefined;
    if (flow === 'xtls-rprx-vision' || flow.startsWith('xtls-rprx-vision-')) return 'xtls-rprx-vision';
    return flow;
  };

  const parseJsonMaybe = (raw) => {
    if (raw == null || raw === '') return undefined;
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(String(raw)); } catch (e) {}
    try { return JSON.parse(decodeURIComponent(String(raw))); } catch (e2) {}
    return undefined;
  };

  const firstDefined = (obj, ...keys) => {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const key of keys) {
      const value = obj[key];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return undefined;
  };

  const realityParam = (params, ...keys) => {
    const value = firstDefined(params, ...keys);
    return value === undefined ? undefined : decodeMaybe(value);
  };

  const boolMaybe = (obj, ...keys) => {
    const raw = firstDefined(obj, ...keys);
    if (raw === undefined) return undefined;
    if (raw === true || raw === 1) return true;
    if (raw === false || raw === 0) return false;
    const text = String(raw).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(text)) return true;
    if (['0', 'false', 'no', 'off'].includes(text)) return false;
    return undefined;
  };

  const cleanHeaders = (headers) => {
    if (!headers || typeof headers !== 'object') return undefined;
    const out = {};
    Object.entries(headers).forEach(([key, value]) => {
      const cleanKey = String(key || '').trim();
      if (!cleanKey || value == null || value === '') return;
      if (Array.isArray(value)) {
        const items = value.map((item) => String(item || '').trim()).filter(Boolean);
        if (items.length) out[cleanKey] = items;
        return;
      }
      out[cleanKey] = typeof value === 'number' || typeof value === 'boolean' ? value : String(value);
    });
    return Object.keys(out).length ? out : undefined;
  };

  const cleanReuseSettings = (reuse) => {
    if (!reuse || typeof reuse !== 'object') return undefined;
    const out = {};
    const mappings = {
      'max-concurrency': firstDefined(reuse, 'max-concurrency', 'maxConcurrency'),
      'max-connections': firstDefined(reuse, 'max-connections', 'maxConnections'),
      'c-max-reuse-times': firstDefined(reuse, 'c-max-reuse-times', 'cMaxReuseTimes'),
      'h-max-request-times': firstDefined(reuse, 'h-max-request-times', 'hMaxRequestTimes'),
      'h-max-reusable-secs': firstDefined(reuse, 'h-max-reusable-secs', 'hMaxReusableSecs'),
    };
    Object.entries(mappings).forEach(([key, value]) => {
      if (value === undefined) return;
      out[key] = typeof value === 'number' || typeof value === 'boolean' ? value : String(value);
    });
    return Object.keys(out).length ? out : undefined;
  };

  const cleanStringList = (value) => {
    if (value == null || value === '') return undefined;
    const rawItems = Array.isArray(value) ? value : String(value).split(',');
    const items = rawItems.map((item) => String(item ?? '').trim()).filter(Boolean);
    return items.length ? items : undefined;
  };

  const cleanValueTree = (value) => {
    if (value == null || value === '') return undefined;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
      const items = value.map((item) => cleanValueTree(item)).filter((item) => item !== undefined);
      return items.length ? items : undefined;
    }
    if (typeof value === 'object') {
      const out = {};
      Object.entries(value).forEach(([key, nestedValue]) => {
        const cleanKey = String(key || '').trim();
        if (!cleanKey) return;
        const cleanNested = cleanValueTree(nestedValue);
        if (cleanNested === undefined) return;
        out[cleanKey] = cleanNested;
      });
      return Object.keys(out).length ? out : undefined;
    }
    return String(value);
  };

  const cleanDownloadSettings = (download) => {
    if (!download || typeof download !== 'object') return undefined;

    const out = {};

    const path = firstDefined(download, 'path');
    if (path !== undefined) out.path = String(path);

    const host = firstDefined(download, 'host');
    if (host !== undefined) out.host = String(host);

    const headers = cleanHeaders(firstDefined(download, 'headers'));
    if (headers) out.headers = headers;

    const noGrpcHeader = boolMaybe(download, 'no-grpc-header', 'noGrpcHeader', 'noGRPCHeader');
    if (noGrpcHeader !== undefined) out['no-grpc-header'] = noGrpcHeader;

    const xPaddingBytes = firstDefined(download, 'x-padding-bytes', 'xPaddingBytes');
    if (xPaddingBytes !== undefined) {
      out['x-padding-bytes'] = typeof xPaddingBytes === 'number' ? xPaddingBytes : String(xPaddingBytes);
    }

    const scMaxEachPostBytes = firstDefined(download, 'sc-max-each-post-bytes', 'scMaxEachPostBytes');
    if (scMaxEachPostBytes !== undefined) {
      out['sc-max-each-post-bytes'] =
        typeof scMaxEachPostBytes === 'number' ? scMaxEachPostBytes : String(scMaxEachPostBytes);
    }

    const reuseSettings = cleanReuseSettings(firstDefined(download, 'reuse-settings', 'reuseSettings'));
    if (reuseSettings) out['reuse-settings'] = reuseSettings;

    const server = firstDefined(download, 'server');
    if (server !== undefined) out.server = String(server);

    const port = firstDefined(download, 'port');
    if (port !== undefined) out.port = typeof port === 'number' ? port : String(port);

    const tls = boolMaybe(download, 'tls');
    if (tls !== undefined) out.tls = tls;

    const alpn = cleanStringList(firstDefined(download, 'alpn'));
    if (alpn) out.alpn = alpn;

    const echOpts = cleanValueTree(firstDefined(download, 'ech-opts', 'echOpts'));
    if (echOpts !== undefined) out['ech-opts'] = echOpts;

    const realityOpts = cleanValueTree(firstDefined(download, 'reality-opts', 'realityOpts'));
    if (realityOpts !== undefined) out['reality-opts'] = realityOpts;

    const skipCertVerify = boolMaybe(download, 'skip-cert-verify', 'skipCertVerify');
    if (skipCertVerify !== undefined) out['skip-cert-verify'] = skipCertVerify;

    const fingerprint = firstDefined(download, 'fingerprint');
    if (fingerprint !== undefined) out.fingerprint = String(fingerprint);

    const certificate = cleanValueTree(firstDefined(download, 'certificate'));
    if (certificate !== undefined) out.certificate = certificate;

    const privateKey = cleanValueTree(firstDefined(download, 'private-key', 'privateKey'));
    if (privateKey !== undefined) out['private-key'] = privateKey;

    const servername = firstDefined(download, 'servername', 'serverName');
    if (servername !== undefined) out.servername = String(servername);

    const clientFingerprint = firstDefined(download, 'client-fingerprint', 'clientFingerprint');
    if (clientFingerprint !== undefined) out['client-fingerprint'] = String(clientFingerprint);

    return Object.keys(out).length ? out : undefined;
  };

  const normalizeXhttpSettings = (params) => {
    const extra = parseJsonMaybe(params.extra);
    const xhttp = {
      path: decodeMaybe(params.path) || '/',
      host: decodeMaybe(params.host) || decodeMaybe(params.sni),
      mode: decodeMaybe(params.mode),
    };

    const headers = cleanHeaders(firstDefined(extra, 'headers'));
    if (headers) xhttp.headers = headers;

    const noGrpcHeader = boolMaybe(extra, 'no-grpc-header', 'noGrpcHeader', 'noGRPCHeader');
    if (noGrpcHeader === true) xhttp['no-grpc-header'] = true;

    const xPaddingBytes = firstDefined(extra, 'x-padding-bytes', 'xPaddingBytes');
    if (xPaddingBytes !== undefined) {
      xhttp['x-padding-bytes'] = typeof xPaddingBytes === 'number' ? xPaddingBytes : String(xPaddingBytes);
    }

    const scMaxEachPostBytes = firstDefined(extra, 'sc-max-each-post-bytes', 'scMaxEachPostBytes');
    if (scMaxEachPostBytes !== undefined) {
      xhttp['sc-max-each-post-bytes'] =
        typeof scMaxEachPostBytes === 'number' ? scMaxEachPostBytes : String(scMaxEachPostBytes);
    }

    const reuseSettings = cleanReuseSettings(firstDefined(extra, 'reuse-settings', 'reuseSettings'));
    if (reuseSettings) xhttp['reuse-settings'] = reuseSettings;

    const downloadSettings = cleanDownloadSettings(firstDefined(extra, 'download-settings', 'downloadSettings'));
    if (downloadSettings) xhttp['download-settings'] = downloadSettings;

    return Object.fromEntries(Object.entries(xhttp).filter(([, value]) => value != null && value !== ''));
  };

  const getStreamSettings = (type, params) => {
    const number = (val) => (val ? +val : undefined);
    const bool = (val) => val === 'true' || val === true || val === '1' || undefined;
    const string = (val) => val || undefined;
    const output = {
      network: type,
      security: string(params.security),
      tlsSettings:
        params.security === 'tls'
          ? {
              fingerprint: string(params.fp) || 'chrome',
              serverName: string(params.sni),
              alpn: params.alpn?.split(','),
              allowInsecure: bool(params.allowInsecure || params.insecure),
            }
          : undefined,
      realitySettings:
        params.security === 'reality'
          ? {
              fingerprint: string(params.fp) || 'chrome',
              serverName: string(params.sni),
              publicKey: realityParam(params, 'pbk', 'publicKey', 'public-key', 'public_key'),
              shortId: realityParam(params, 'sid', 'shortId', 'short-id', 'short_id', 'shortid'),
              spiderX: string(params.spx),
              mldsa65Verify: string(params.pqv),
              supportX25519MLKEM768: boolMaybe(
                params,
                'support-x25519mlkem768',
                'supportX25519MLKEM768',
                'support_x25519mlkem768',
              ),
            }
          : undefined,
    };

    if (type === 'tcp' && params.headerType) output.tcpSettings = { header: { type: params.headerType } };
    if (type === 'raw' && params.headerType) output.rawSettings = { header: { type: params.headerType } };

    if (type === 'grpc')
      output.grpcSettings = {
        serviceName: string(params.serviceName || params.path),
        authority: string(params.authority),
        multiMode: params.mode === 'multi',
        user_agent: string(params.user_agent),
        idle_timeout: number(params.idle_timeout),
        health_check_timeout: number(params.health_check_timeout),
        permit_without_stream: bool(params.permit_without_stream),
        initial_windows_size: number(params.initial_windows_size),
      };

    if (type === 'ws')
      output.wsSettings = {
        path: params.path || '/',
        host: string(params.host),
        heartbeatPeriod: number(params.heartbeatPeriod),
      };

    if (type === 'httpupgrade') output.httpupgradeSettings = { path: params.path || '/', host: string(params.host) };
    if (type === 'xhttp') output.xhttpSettings = normalizeXhttpSettings(params);

    return output;
  };

  const parseUrl = (uri, protocol, settingsMapper) => {
    const url = new URL(uri);
    const params = Object.fromEntries(url.searchParams);

    const baseConfig = {
      tag: decodeURIComponent(url.hash.slice(1)) || 'PROXY',
      protocol: protocol,
      settings: settingsMapper(url, params),
    };

    if (!['shadowsocks', 'hysteria2'].includes(protocol)) {
      baseConfig.streamSettings = getStreamSettings(params.type || 'tcp', { ...params, sni: params.sni });
    }

    return baseConfig;
  };

  const protocols = {
    vless: (uri) =>
      parseUrl(uri, 'vless', (url, params) => ({
        address: url.hostname,
        port: +url.port || 443,
        id: url.username,
        encryption: params.encryption || 'none',
        flow: normalizeMihomoVlessFlow(params.flow),
      })),

    trojan: (uri) =>
      parseUrl(uri, 'trojan', (url) => ({
        address: url.hostname,
        port: +url.port || 443,
        password: url.username,
      })),

    hysteria2: (uri) =>
      parseUrl(uri, 'hysteria2', (url, params) => {
        // Hysteria2 URI auth formats:
        //  - hysteria2://<auth>@host:port
        //  - hy2://username:password@host:port
        const user = decodeURIComponent(url.username || '');
        const pass = decodeURIComponent(url.password || '');
        const auth = user && pass ? `${user}:${pass}` : user;

        const alpnRaw = params.alpn || '';
        const alpn = alpnRaw ? String(alpnRaw).split(',').map((s) => s.trim()).filter(Boolean) : ['h3'];
        const obfsPassword = params['obfs-password'] || params.obfsPassword || params['obfs_password'] || undefined;

        return {
          address: url.hostname,
          port: +url.port || 443,
          password: auth,
          sni: params.sni,
          insecure: params.insecure === '1' || params.allowInsecure === '1',
          alpn,
          obfs: params.obfs || undefined,
          obfsPassword,
        };
      }),

    // aliases
    hy2: (uri) => protocols.hysteria2(uri),
    hysteria: (uri) => protocols.hysteria2(uri),

    ss: (uri) => {
      const url = new URL(uri);
      let method, password;
      if (url.username && !url.password) {
        const decoded = safeBase64(url.username).split(':');
        method = decoded[0];
        password = decoded.slice(1).join(':');
      } else {
        method = url.username;
        password = url.password;
      }
      return {
        tag: decodeURIComponent(url.hash.slice(1)) || 'PROXY',
        protocol: 'shadowsocks',
        settings: { address: url.hostname, port: +url.port, method, password },
      };
    },

    vmess: (uri) => {
      const data = JSON.parse(safeBase64(uri.slice(8)));
      if (data.tls === 'tls') {
        data.security = 'tls';
        data.sni = data.sni || data.host;
      }
      return {
        tag: data.ps || 'PROXY',
        protocol: 'vmess',
        settings: {
          address: data.add,
          port: +data.port,
          id: data.id,
          alterId: +data.aid || 0,
          security: data.scy || 'auto',
        },
        streamSettings: getStreamSettings(data.net || 'tcp', data),
      };
    },
  };

  function parseProxyUri(uri) {
    const protocolRaw = String(uri.split(':')[0] || '').toLowerCase();
    const protocol = protocolRaw === 'hy2' || protocolRaw === 'hysteria' ? 'hysteria2' : protocolRaw;
    if (!protocols[protocol]) throw new Error('Неизвестная ссылка');
    return protocols[protocol](uri);
  }

  function isBackendSubscriptionLink(value) {
    const text = String(value || '').trim();
    return /^https?:\/\//i.test(text) || /^happ:\/\/crypt[0-9]*\//i.test(text);
  }

  function convertToMihomoYaml(proxyConfig) {
    const settings = proxyConfig.settings;
    const streamSettings = proxyConfig.streamSettings || {};

    const common = {
      name: proxyConfig.tag,
      type: proxyConfig.protocol,
      server: settings.address,
      port: settings.port,
      udp: true,
    };

    if (proxyConfig.protocol === 'vless') {
      const enc = String(settings.encryption || '').trim().toLowerCase();
      Object.assign(common, {
        uuid: settings.id,
        flow: normalizeMihomoVlessFlow(settings.flow),
        'packet-encoding': 'xudp',
        encryption: !enc || enc === 'none' ? '' : settings.encryption,
      });
    } else if (proxyConfig.protocol === 'vmess') {
      Object.assign(common, { uuid: settings.id, alterId: settings.alterId, cipher: settings.security });
    } else if (proxyConfig.protocol === 'trojan') {
      common.password = settings.password;
    } else if (proxyConfig.protocol === 'hysteria2') {
      // Hysteria2 (hy2://, hysteria2://)
      common.password = settings.password;
      common['fast-open'] = true;
      if (settings.sni) common.sni = settings.sni;
      if (settings.insecure) common['skip-cert-verify'] = true;
      if (settings.alpn && settings.alpn.length) common.alpn = settings.alpn;
      if (settings.obfs) common.obfs = settings.obfs;
      if (settings.obfsPassword) common['obfs-password'] = settings.obfsPassword;
    } else if (proxyConfig.protocol === 'shadowsocks') {
      Object.assign(common, { cipher: settings.method, password: settings.password });
    }

    if (streamSettings.network) common.network = streamSettings.network;

    if (['tls', 'reality'].includes(streamSettings.security)) {
      const tls = streamSettings.tlsSettings || {};
      const reality = streamSettings.realitySettings || {};
      const serverName = tls.serverName || reality.serverName;

      Object.assign(common, {
        tls: true,
        tfo: true,
        'client-fingerprint': tls.fingerprint || reality.fingerprint,
        alpn: tls.alpn,
      });

      if (['trojan', 'hysteria2'].includes(proxyConfig.protocol)) {
        if (serverName) common.sni = serverName;
      } else {
        if (serverName) common.servername = serverName;
      }

      if (tls.allowInsecure) common['skip-cert-verify'] = true;

      if (streamSettings.security === 'reality') {
        const shortId = reality.shortId;
        const supportX25519MLKEM768 = boolMaybe(
          reality,
          'support-x25519mlkem768',
          'supportX25519MLKEM768',
          'support_x25519mlkem768',
        );
        common['reality-opts'] = {
          'public-key': reality.publicKey,
          'short-id': shortId == null ? undefined : String(shortId),
          'support-x25519mlkem768': supportX25519MLKEM768 === true ? true : undefined,
          'spider-x': reality.spiderX == null ? undefined : String(reality.spiderX),
        };
      }
    }

    if (streamSettings.network === 'xhttp' && proxyConfig.protocol !== 'vless') {
      throw new Error('XHTTP transport поддерживается в Mihomo только для VLESS');
    }

    if (streamSettings.network === 'ws') {
      common['ws-opts'] = {
        path: streamSettings.wsSettings?.path,
        headers: streamSettings.wsSettings?.host ? { Host: streamSettings.wsSettings.host } : undefined,
      };
    } else if (streamSettings.network === 'grpc') {
      const grpcServiceName = streamSettings.grpcSettings?.serviceName;
      if (grpcServiceName) common['grpc-opts'] = { 'grpc-service-name': grpcServiceName };
    } else if (streamSettings.network === 'httpupgrade') {
      common['http-upgrade-opts'] = {
        path: streamSettings.httpupgradeSettings?.path,
        headers: streamSettings.httpupgradeSettings?.host ? { Host: streamSettings.httpupgradeSettings.host } : undefined,
      };
    } else if (streamSettings.network === 'xhttp') {
      common['xhttp-opts'] = {
        path: streamSettings.xhttpSettings?.path,
        host: streamSettings.xhttpSettings?.host,
        mode: streamSettings.xhttpSettings?.mode,
        headers: streamSettings.xhttpSettings?.headers,
        'no-grpc-header': streamSettings.xhttpSettings?.['no-grpc-header'],
        'x-padding-bytes': streamSettings.xhttpSettings?.['x-padding-bytes'],
        'sc-max-each-post-bytes': streamSettings.xhttpSettings?.['sc-max-each-post-bytes'],
        'reuse-settings': streamSettings.xhttpSettings?.['reuse-settings'],
        'download-settings': streamSettings.xhttpSettings?.['download-settings'],
      };
    }

    return `  - ${toYaml(common).trim().replace(/\n/g, '\n    ')}`;
  }

  function proxyYamlRawFromIndented(indented) {
    const s = String(indented || '');
    // convert from list-item under `proxies:` (2-space indent) to raw block starting with `- name:`
    return s.replace(/^ {2}/gm, '');
  }


  function sanitizeProviderName(name) {
    let s = String(name || '').trim();
    if (!s) return '';
    s = s.replace(/\s+/g, '_');
    s = s.replace(/[^A-Za-z0-9._-]+/g, '_');
    s = s.replace(/_+/g, '_').replace(/^[._-]+|[._-]+$/g, '');
    return s.slice(0, 64);
  }

  function uniqueProviderName(base, existingConfig, fallbackBase) {
    const fallback = sanitizeProviderName(fallbackBase || 'subscription') || 'subscription';
    const cleanBase = sanitizeProviderName(base || '');
    if (cleanBase) {
      if (!configHasProviderName(existingConfig, cleanBase)) return cleanBase;
      let i = 2;
      while (i < 2000) {
        const candidate = `${cleanBase}_${i}`;
        if (!configHasProviderName(existingConfig, candidate)) return candidate;
        i++;
      }
      return `${cleanBase}_${Date.now()}`;
    }

    let index = 1;
    while (configHasProviderName(existingConfig, `${fallback}_${index}`)) index++;
    return `${fallback}_${index}`;
  }

  function localProviderAdapterUrl(url, insecure) {
    const raw = String(url || '').trim();
    let port = '';
    try {
      port = String(window.location && window.location.port ? window.location.port : '').trim();
      if (!port) port = (window.location && window.location.protocol === 'https:') ? '443' : '80';
    } catch (e) {
      port = '8088';
    }
    const params = new URLSearchParams();
    params.set('url', raw);
    params.set('insecure', insecure ? '1' : '0');
    return `http://127.0.0.1:${port}/mihomo/provider.yaml?${params.toString()}`;
  }

  function normalizeProviderHeaders(headers) {
    if (!headers || typeof headers !== 'object') return null;
    const out = {};
    Object.entries(headers).forEach(([key, value]) => {
      const cleanKey = String(key || '').trim();
      if (!cleanKey) return;
      const values = Array.isArray(value) ? value : [value];
      const cleanValues = values.map((item) => String(item == null ? '' : item).trim()).filter(Boolean);
      if (cleanValues.length) out[cleanKey] = cleanValues;
    });
    return Object.keys(out).length ? out : null;
  }

  async function probeRegularProvider(url) {
    const http = getMihomoCoreHttpApi();
    const post = http && typeof http.postJSON === 'function' ? http.postJSON : null;
    if (!post) throw new Error('core http.postJSON РЅРµРґРѕСЃС‚СѓРїРµРЅ');
    const data = await post('/api/mihomo/provider/probe', {
      url: String(url || '').trim(),
      insecure: false,
      prefer: 'head_then_range_get',
      timeout_ms: 8000,
    });
    if (!data || data.ok === false) throw new Error((data && data.error && data.error.message) || (data && data.error) || 'provider probe failed');
    return data;
  }

  async function buildSubscriptionProviderConfig(uri, existingConfig, options = {}) {
    let probe = null;
    try {
      probe = await probeRegularProvider(uri);
    } catch (e) {
      try { console.warn('mihomo provider probe failed, using generated provider name', e); } catch (e2) {}
    }
    const profile = (probe && probe.profile) || {};
    const providerName = String(profile.suggested_name || profile.profile_title || '').trim();
    const providerProxies = Array.isArray(probe && probe.provider_proxies) ? probe.provider_proxies : [];
    if (options && options.staticProxies && providerProxies.length) {
      const warnings = providerProbeWarningMessages(probe);
      return providerProxies
        .map((p) => ({
          type: 'proxy',
          proxy_name: String(p.proxy_name || p.proxyName || '').trim(),
          content: String(p.proxy_yaml || p.proxyYaml || p.content || '').trimEnd() + '\n',
          providerStaticBulk: true,
          provider_mode: String((probe && probe.provider_mode) || '').trim(),
          provider_payload: (probe && probe.provider_payload) || null,
          provider_warnings: warnings,
          refresh_parser: 'mihomo-provider',
        }))
        .filter((p) => p.proxy_name && String(p.content || '').trim());
    }
    const providerUrl = String((probe && probe.provider_url) || '').trim() || localProviderAdapterUrl(uri, false);
    const providerHeaders = normalizeProviderHeaders((probe && probe.provider_headers) || null);
    const out = generateConfigForMihomo(uri, existingConfig, { providerName, providerUrl, providerHeaders });
    out.profile_title = String(profile.profile_title || '').trim();
    out.provider_name = providerName || out.provider_name || '';
    out.provider_mode = String((probe && probe.provider_mode) || '').trim();
    out.hwid_response_headers = (probe && probe.hwid_response_headers) || {};
    out.provider_payload = (probe && probe.provider_payload) || null;
    out.provider_warnings = providerProbeWarningMessages(probe);
    return out;
  }


  function generateConfigForMihomo(uri, existingConfig = '', options = {}) {
    const generateName = (base, existsFn) => {
      let index = 1;
      while (existsFn(existingConfig, `${base}_${index}`)) index++;
      return `${base}_${index}`;
    };

    if (isBackendSubscriptionLink(uri)) {
      const opts = options || {};
      const name = uniqueProviderName(opts.providerName || '', existingConfig, 'subscription');
      const providerUrl = String(opts.providerUrl || '').trim() || localProviderAdapterUrl(uri, false);
      const headers = normalizeProviderHeaders(opts.providerHeaders || null);
      const provider = {
        type: 'http',
        url: providerUrl,
        interval: 43200,
        path: `./proxy_providers/${name}.yaml`,
        'health-check': {
          enable: true,
          url: 'https://www.gstatic.com/generate_204',
          interval: 300,
          'expected-status': 204,
        },
        override: { udp: true, tfo: true },
      };
      if (headers) provider.header = headers;
      return {
        type: 'proxy-provider',
        provider_name: name,
        content: toYaml(
          {
            [name]: provider,
          },
          2,
        ),
      };
    }
    // Keep xhttp synchronous in the shared parser API used by import and proxy tools.
    if (uri.includes('type=xhttp')) {
      const config = parseProxyUri(uri);
      if (config.tag === 'PROXY' || configHasProxyName(existingConfig, config.tag)) {
        config.tag = generateName(config.protocol, configHasProxyName);
      }
      const indented = convertToMihomoYaml(config);
      const raw = proxyYamlRawFromIndented(indented);
      return { type: 'proxy', proxy_name: config.tag, content: raw + '\n' };
    }

    const config = parseProxyUri(uri);
    if (config.tag === 'PROXY' || configHasProxyName(existingConfig, config.tag)) {
      config.tag = generateName(config.protocol, configHasProxyName);
    }

    const indented = convertToMihomoYaml(config);
    const raw = proxyYamlRawFromIndented(indented);
    return { type: 'proxy', proxy_name: config.tag, content: raw + '\n' };
  }

  // Expose a minimal helper API for other modules (Proxy Tools, etc.)
  // NOTE: keep this stable; it is used as a shared parser/generator.
  MI.generateConfigForMihomo = MI.generateConfigForMihomo || generateConfigForMihomo;
  MI.proxyYamlRawFromIndented = MI.proxyYamlRawFromIndented || proxyYamlRawFromIndented;

  // ---------------------------------------------------------------------------
  // YAML insertion helpers (shared)
  // ---------------------------------------------------------------------------

  function yamlPatch() {
    try {
      return getMihomoYamlPatchApi();
    } catch (e) {
      return null;
    }
  }

  function insertProvidersIntoConfig(existingText, outputs) {
    let txt = String(existingText || '');
    const yp = yamlPatch();

    if (!yp || typeof yp.insertIntoSection !== 'function') {
      throw new Error('mihomoYamlPatch не загружен');
    }

    const providers = (outputs || []).filter((o) => o.type === 'proxy-provider');
    providers.forEach((o) => {
      txt = yp.insertIntoSection(txt, 'proxy-providers', o.content);
    });
    return txt;
  }

  async function applyInsertProxy(txt, proxyOut, groups) {
    const body = {
      content: String(txt || ''),
      proxy_yaml: String(proxyOut && proxyOut.content ? proxyOut.content : ''),
      proxy_name: String((proxyOut && (proxyOut.proxy_name || proxyOut.proxyName)) || '').trim(),
      groups: Array.isArray(groups) ? groups : [],
    };

    const http = getMihomoCoreHttpApi();
    const post = http && typeof http.postJSON === 'function' ? http.postJSON : null;
    if (!post) throw new Error('core http.postJSON недоступен');

    const data = await post('/api/mihomo/patch/apply_insert', body);
    if (!data || data.ok === false) throw new Error((data && data.error) ? data.error : 'apply_insert failed');
    return String(data.content || '');
  }

  async function registerImportedXraySubscriptions(configText, groups) {
    const grouped = groupXrayOutputsByUri(_lastResult && _lastResult.outputs)
      .map((group) => ({ ...group, refreshParser: 'xray-json' }))
      .concat(
        groupProviderStaticOutputsByUri(_lastResult && _lastResult.outputs)
          .map((group) => ({ ...group, refreshParser: 'mihomo-provider' })),
      );
    if (!grouped.length) return [];

    const intervalHours = readXrayIntervalHours();
    saveXrayIntervalPref(intervalHours);

    const http = getMihomoCoreHttpApi();
    const post = http && typeof http.postJSON === 'function' ? http.postJSON : null;
    if (!post) throw new Error('core http.postJSON недоступен');

    const results = [];
    for (const group of grouped) {
      const data = await post('/api/mihomo/subscriptions/imported-xray', {
        url: group.uri,
        config: String(configText || ''),
        groups: Array.isArray(groups) ? groups : [],
        interval_hours: intervalHours,
        refresh_parser: group.refreshParser,
        tag: group.refreshParser === 'mihomo-provider' ? 'mihomo-provider:' + hostFromUrl(group.uri) : undefined,
        proxies: group.items.map((item) => ({
          proxy_name: String(item.proxy_name || '').trim(),
          proxy_yaml: String(item.content || '').trimEnd(),
        })),
      });
      if (!data || data.ok === false) {
        throw new Error((data && data.error) ? data.error : 'subscription register failed');
      }
      if (data.subscription) results.push(data.subscription);
    }
    return results;
  }


  function escapeRegExp(s) {
    return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function hostFromUrl(url) {
    try {
      const host = new URL(String(url || '')).hostname || '';
      return host || 'provider';
    } catch (e) {
      return 'provider';
    }
  }

  function configHasProxyName(cfgText, name) {
    const n = String(name || '').trim();
    if (!n) return false;
    const re1 = new RegExp('^\\s*-\\s*name\\s*:\\s*(?:"' + escapeRegExp(n) + '"|\'' + escapeRegExp(n) + '\'|' + escapeRegExp(n) + ')\\s*(?:#.*)?$', 'm');
    return re1.test(String(cfgText || ''));
  }

  function configHasProviderName(cfgText, name) {
    const n = String(name || '').trim();
    if (!n) return false;
    const re1 = new RegExp('^\\s+' + escapeRegExp(n) + '\\s*:\\s*(?:#.*)?$', 'm');
    return re1.test(String(cfgText || ''));
  }

  function makeUniqueName(base, cfgText) {
    const b = String(base || 'WG').trim() || 'WG';
    if (!configHasProxyName(cfgText, b)) return b;
    let i = 2;
    while (i < 2000) {
      const cand = b + '_' + i;
      if (!configHasProxyName(cfgText, cand)) return cand;
      i++;
    }
    return b + '_' + Date.now();
  }

  async function parseConfigViaApi(kind, confText, desiredName) {
    const http = getMihomoCoreHttpApi();
    const post = http && typeof http.postJSON === 'function' ? http.postJSON : null;
    if (!post) throw new Error('core http.postJSON недоступен');

    const body = { text: String(confText || '') };
    if (desiredName) body.name = String(desiredName || '');

    const safeKind = String(kind || '').trim().toLowerCase();
    const data = await post('/api/mihomo/parse/' + safeKind, body);
    if (!data || data.ok === false) throw new Error((data && data.error) ? data.error : 'parse/' + safeKind + ' failed');

    const proxy_name = String(data.proxy_name || data.name || '').trim();
    const proxy_yaml = String(data.proxy_yaml || data.proxy || data.yaml || '').trimEnd() + '\n';
    if (!proxy_name || !proxy_yaml) throw new Error(safeKind + ': пустой результат парсинга');

    return { type: 'proxy', proxy_name, content: proxy_yaml };
  }

  function collectProxyNamesFromText(text) {
    const names = [];
    const lines = String(text || '').split(/\r?\n/);
    for (const ln of lines) {
      const m = ln.match(/^\s*-\s*name\s*:\s*(?:'((?:[^']|'')*)'|"((?:[^"\\]|\\.)*)"|(\S+))/);
      if (m) names.push((m[1] || m[2] || m[3] || '').replace(/''/g, "'"));
    }
    return names.filter(Boolean);
  }

  // Probe a URL against the backend Xray-JSON parser. Returns:
  //   - array of {type:'proxy', proxy_name, content} on success,
  //   - null when the response says "not_xray_json" (caller should fall back),
  //   - throws on any other error so the caller can surface it.
  async function parseXrayJsonViaApi(url, existingNames) {
    const http = getMihomoCoreHttpApi();
    const post = http && typeof http.postJSON === 'function' ? http.postJSON : null;
    if (!post) throw new Error('core http.postJSON недоступен');

    const body = { url: String(url || '') };
    if (Array.isArray(existingNames) && existingNames.length) {
      body.existing_names = existingNames.slice(0, 4096);
    }

    let data;
    try {
      data = await post('/api/mihomo/parse/xray-json', body);
    } catch (e) {
      const code = (e && e.data && e.data.code) || '';
      if (code === 'not_xray_json') return null;
      const msg = (e && e.data && e.data.error) || (e && e.message) || 'parse/xray-json failed';
      const hint = (e && e.data && e.data.hint) || '';
      const err = new Error(hint && !String(msg).includes(hint) ? `${msg}. ${hint}` : msg);
      if (code) err.code = code;
      if (hint) err.hint = hint;
      if (e && e.status) err.status = e.status;
      throw err;
    }

    if (!data || data.ok === false) {
      const code = (data && data.code) || '';
      if (code === 'not_xray_json') return null;
      const msg = (data && data.error) || 'parse/xray-json failed';
      const hint = (data && data.hint) || '';
      const err = new Error(hint && !String(msg).includes(hint) ? `${msg}. ${hint}` : msg);
      if (code) err.code = code;
      if (hint) err.hint = hint;
      throw err;
    }

    const proxies = Array.isArray(data.proxies) ? data.proxies : [];
    return proxies.map((p) => ({
      type: 'proxy',
      proxy_name: String(p.proxy_name || '').trim(),
      content: String(p.proxy_yaml || '').trimEnd() + '\n',
      xrayBulk: true,
    }));
  }


  // ---------------------------------------------------------------------------
  // UI Actions
  // ---------------------------------------------------------------------------

  async function parseInput(options = {}) {
    const inp = $(IDS.input);
    const rawText = inp ? String(inp.value || '') : '';
    const mode = getImportMode();
    const staticProviderProxies = boolOpt(options && options.staticProviderProxies);

    if (!rawText.trim()) {
      let msg = 'Вставь ссылку узла или https-подписку.';
      if (mode === 'wireguard') msg = 'Вставь WireGuard (.conf) и нажми «Преобразовать».';
      else if (mode === 'openvpn') msg = 'Вставь OpenVPN (.ovpn) и нажми «Преобразовать».';
      else if (mode === 'tailscale') msg = 'Вставь Tailscale-параметры и нажми «Преобразовать».';
      setStatus(msg, true);
      setHint('');
      setPreview('');
      updateXrayRefreshUi([]);
      const ins = $(IDS.btnInsert);
      if (ins) ins.disabled = true;
      return;
    }

    const existing = getEditorText() || '';
    let tmp = existing;

    const outputs = [];
    const errors = [];

    // Config modes: parse whole textarea as a single config.
    if (mode === 'wireguard' || mode === 'openvpn' || mode === 'tailscale') {
      const label = mode === 'wireguard' ? 'WireGuard' : (mode === 'openvpn' ? 'OpenVPN' : 'Tailscale');
      setStatus('Разбираю ' + label + '…', false, null, { busy: true });
      try {
        let out = await parseConfigViaApi(mode, rawText, null);
        // Ensure unique name against current config.yaml
        if (configHasProxyName(existing, out.proxy_name)) {
          const unique = makeUniqueName(out.proxy_name, existing);
          out = await parseConfigViaApi(mode, rawText, unique);
        }
        outputs.push({ ...out, uri: mode + '.conf' });
      } catch (e) {
        const msg = e && e.message ? e.message : String(e || 'ошибка');
        // Make error a bit more readable for typical missing-key issue
        const human = msg.includes('missing mandatory keys')
          ? 'Некорректный WireGuard (.conf): нет PrivateKey/PublicKey/Endpoint'
          : msg;
        errors.push(human);
      }
    } else {
      // Line-based parsing (auto/proxy/subscription)
      const lines = rawText
        .split(/\r?\n/)
        .map((s) => String(s || '').trim())
        .filter(Boolean);

      if (!lines.length) {
        setStatus('Вставь данные и нажми «Преобразовать».', true);
        setHint('');
        setPreview('');
        updateXrayRefreshUi([]);
        const ins = $(IDS.btnInsert);
        if (ins) ins.disabled = true;
        return;
      }

      for (const line of lines) {
        try {
          if (mode === 'subscription' && !isBackendSubscriptionLink(line)) {
            throw new Error('Ожидается HTTPS‑подписка или Happ deep-link (happ://crypt...)');
          }
          if (mode === 'proxy' && /^https?:\/\//i.test(line)) {
            throw new Error('Это похоже на подписку. Выбери «HTTPS subscription» или «Auto».');
          }
          if (mode !== 'subscription' && /^tailscale:\/\//i.test(line)) {
            let out = await parseConfigViaApi('tailscale', line, null);
            if (configHasProxyName(tmp, out.proxy_name)) {
              const unique = makeUniqueName(out.proxy_name, tmp);
              out = await parseConfigViaApi('tailscale', line, unique);
            }
            outputs.push({ ...out, uri: line });
            tmp += '\n' + out.content;
            continue;
          }

          // For http(s)/Happ URLs in subscription/auto modes, try the backend
          // Xray-JSON parser first; on not_xray_json we transparently fall
          // back to creating a regular proxy-provider entry.
          if (isBackendSubscriptionLink(line) && mode !== 'proxy') {
            setStatus(`Распознаю подписку ${line}…`, false, null, { busy: true });
            const existingNames = collectProxyNamesFromText(tmp);
            const xrayProxies = await parseXrayJsonViaApi(line, existingNames);
            if (xrayProxies && xrayProxies.length) {
              for (const p of xrayProxies) {
                outputs.push({ ...p, uri: line });
                tmp += '\n' + p.content;
              }
              continue;
            }
            const out = await buildSubscriptionProviderConfig(line, tmp, {
              staticProxies: staticProviderProxies,
            });
            if (Array.isArray(out)) {
              out.forEach((item) => {
                outputs.push({ ...item, uri: line });
                tmp += '\n' + item.content;
              });
            } else {
              outputs.push({ ...out, uri: line });
              tmp += '\n' + out.content;
            }
            continue;
          }

          const out = generateConfigForMihomo(line, tmp);

          if (mode === 'subscription' && out.type !== 'proxy-provider') {
            throw new Error('Не удалось распознать URL подписки');
          }
          if (mode === 'proxy' && out.type !== 'proxy') {
            throw new Error('Не удалось распознать ссылку узла');
          }

          outputs.push({ ...out, uri: line });
          tmp += '\n' + out.content;
        } catch (e) {
          errors.push(`${line}: ${e && e.message ? e.message : 'ошибка'}`);
        }
      }
    }

    if (!outputs.length) {
      setStatus(errors.join('\n') || 'Не удалось распознать данные.', true);
      setHint('');
      setPreview('');
      updateXrayRefreshUi([]);
      const ins = $(IDS.btnInsert);
      if (ins) ins.disabled = true;
      return;
    }

    _lastResult = { outputs };

    // Build preview. Group consecutive xrayBulk proxies sharing the same
    // source URI into a single section so that a 27-node subscription doesn't
    // render as 27 repeated "# proxies" headers.
    const previewSections = [];
    let i = 0;
    while (i < outputs.length) {
      const o = outputs[i];
      if (o.type === 'proxy-provider') {
        previewSections.push(`# proxy-providers\n${String(o.content || '').trimEnd()}`);
        i += 1;
        continue;
      }
      if (o.xrayBulk) {
        const startUri = o.uri;
        const group = [];
        while (i < outputs.length && outputs[i].xrayBulk && outputs[i].uri === startUri) {
          const raw = String(outputs[i].content || '').trimEnd();
          group.push(raw.split('\n').map((l) => (l ? '  ' + l : l)).join('\n'));
          i += 1;
        }
        const header = `# proxies (Xray-подписка: ${group.length} узлов из ${startUri})`;
        previewSections.push(`${header}\n${group.join('\n\n')}`);
        continue;
      }
      if (o.providerStaticBulk) {
        const startUri = o.uri;
        const group = [];
        while (i < outputs.length && outputs[i].providerStaticBulk && outputs[i].uri === startUri) {
          const raw = String(outputs[i].content || '').trimEnd();
          group.push(raw.split('\n').map((l) => (l ? '  ' + l : l)).join('\n'));
          i += 1;
        }
        const header = `# proxies (HWID-подписка: ${group.length} узлов из ${startUri})`;
        previewSections.push(`${header}\n${group.join('\n\n')}`);
        continue;
      }
      const raw = String(o.content || '').trimEnd();
      const ind = raw.split('\n').map((l) => (l ? '  ' + l : l)).join('\n');
      previewSections.push(`# proxies\n${ind}`);
      i += 1;
    }
    const preview = previewSections.join('\n\n');

    setPreview(preview + '\n');

    const targets = Array.from(new Set(outputs.map((o) => (o.type === 'proxy-provider' ? 'proxy-providers' : 'proxies'))));
    setHint('Будет добавлено в секцию: ' + targets.join(' + '));

    const xrayNodeCount = outputs.filter((o) => o.xrayBulk).length;
    const providerStaticNodeCount = outputs.filter((o) => o.providerStaticBulk).length;
    const providerWarningsRaw = [];
    outputs.forEach((o) => {
      providerWarningsRaw.push(...providerOutputWarnings(o));
    });
    const providerWarnings = uniqueStrings(providerWarningsRaw);
    updateXrayRefreshUi(outputs);
    if (errors.length) {
      setStatus('Часть данных распознана, часть — нет. Проверь строки ниже в preview.', true);
      setPreview(preview + '\n\n# Ошибки\n' + errors.map((x) => '# ' + x).join('\n') + '\n');
    } else if (providerWarnings.length) {
      setStatus(
        'Готово, но провайдер вернул предупреждение:\n' + providerWarnings.map((msg) => '• ' + msg).join('\n'),
        false,
        'warning',
      );
      toastMsg(providerWarnings[0], 'warning');
    } else if (xrayNodeCount > 0) {
      const intervalHours = readXrayIntervalHours();
      setStatus(
        `Распознана Xray-подписка: ${xrayNodeCount} узлов будут вставлены как блок proxies. Автообновление: каждые ${intervalHours} ч после вставки.`,
        false,
      );
    } else if (providerStaticNodeCount > 0) {
      const intervalHours = readXrayIntervalHours();
      setStatus(
        `Распознана HWID-подписка: ${providerStaticNodeCount} узлов будут вставлены как блок proxies. Автообновление: каждые ${intervalHours} ч после вставки.`,
        false,
      );
    } else {
      setStatus('Готово. Нажми «Вставить в конфиг».', false);
    }

    const ins = $(IDS.btnInsert);
    if (ins) ins.disabled = false;
  }

  async function insertIntoEditor() {
    if (!_lastResult || !_lastResult.outputs || !_lastResult.outputs.length) {
      setStatus('Сначала нажми «Преобразовать».', true);
      return;
    }

    const btnIns = $(IDS.btnInsert);
    const btnParse = $(IDS.btnParse);
    const btnParseStatic = $(IDS.btnParseStatic);

    if (btnIns) {
      btnIns.disabled = true;
      try { btnIns.classList.add('loading'); } catch (e) {}
    }
    if (btnParse) {
      btnParse.disabled = true;
      try { btnParse.classList.add('loading'); } catch (e2) {}
    }
    if (btnParseStatic) {
      btnParseStatic.disabled = true;
      try { btnParseStatic.classList.add('loading'); } catch (e2b) {}
    }

    setStatus('Вставляю в config.yaml…', false, null, { busy: true });

    try {
      let txt = getEditorText() || '';

      // 1) Providers — локальный патч (секция proxy-providers)
      txt = insertProvidersIntoConfig(txt, _lastResult.outputs);

      // 2) Proxies — через backend apply_insert (вставка + добавление в proxy-groups)
      const groups = readSelectedGroupsFromUi();
      const proxies = _lastResult.outputs.filter((o) => o.type === 'proxy');

      for (const o of proxies) {
        txt = await applyInsertProxy(txt, o, groups);
      }

      let registeredXrayCount = 0;
      let xrayRegisterFailed = false;
      try {
        const registered = await registerImportedXraySubscriptions(txt, groups);
        registeredXrayCount = Array.isArray(registered) ? registered.length : 0;
        if (registeredXrayCount) {
          try { await loadManagedXraySubscriptions(true); } catch (e4b) {}
        }
      } catch (registerErr) {
        xrayRegisterFailed = true;
        try { console.warn('mihomo import subscription register failed', registerErr); } catch (e4a) {}
        toastMsg(
          'YAML вставлен, но автообновление подписки не сохранилось: ' +
            (registerErr && registerErr.message ? registerErr.message : String(registerErr || 'ошибка')),
          true,
        );
      }

      setEditorText(txt);
      refreshEditor();

      // Persist groups selection if requested
      try { maybePersistGroupsSelection(); } catch (e3) {}

      showModal(false);
      if (!xrayRegisterFailed) {
        toastMsg(
          registeredXrayCount
            ? `Добавлено в config.yaml. Автообновление: ${registeredXrayCount} ${pluralRu(registeredXrayCount, ['подписка', 'подписки', 'подписок'])}.`
            : 'Добавлено в config.yaml ✅',
          false,
        );
      }

      try {
        // mark last activity badge
        if (typeof window.updateLastActivity === 'function') {
          const fp = getXkeenFilePath('mihomo', '/opt/etc/mihomo/config.yaml');
          window.updateLastActivity('modified', 'mihomo', fp);
        }
      } catch (e4) {}
    } catch (e) {
      console.error(e);
      setStatus('Ошибка вставки: ' + (e && e.message ? e.message : String(e || 'ошибка')), true);
      // keep modal open
    } finally {
      if (btnIns) {
        btnIns.disabled = false;
        try { btnIns.classList.remove('loading'); } catch (e5) {}
      }
      if (btnParse) {
        btnParse.disabled = false;
        try { btnParse.classList.remove('loading'); } catch (e6) {}
      }
      if (btnParseStatic) {
        btnParseStatic.disabled = false;
        try { btnParseStatic.classList.remove('loading'); } catch (e6b) {}
      }
    }
  }


  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  MI.init = function init() {
    const openBtn = $(IDS.btnOpen);
    const modal = $(IDS.modal);
    if (!openBtn || !modal) return;

    if (_inited || (modal.dataset && modal.dataset.xkMihomoImportInited === '1')) return;
    _inited = true;
    if (modal.dataset) modal.dataset.xkMihomoImportInited = '1';

    wireButton(IDS.btnOpen, () => showModal(true));
    wireButton(IDS.btnClose, () => showModal(false));
    wireButton(IDS.btnCancel, () => showModal(false));

    // Groups (proxy-groups) selection helpers
    wireButton(IDS.groupsAllBtn, () => { setAllGroupsChecked(true); maybePersistGroupsSelection(); });
    wireButton(IDS.groupsNoneBtn, () => { setAllGroupsChecked(false); maybePersistGroupsSelection(); });

    // Import mode selector
    const modeSel = $(IDS.modeSelect);
    if (modeSel && (!modeSel.dataset || modeSel.dataset.mihomoImportModeBound !== '1')) {
      modeSel.addEventListener('change', () => {
        try { updateModeUi(); } catch (e) {}
        try { saveImportModePref(getImportMode()); } catch (e2) {}
      });
      if (modeSel.dataset) modeSel.dataset.mihomoImportModeBound = '1';
    }

    wireButton(IDS.btnParse, () => parseInput());
    wireButton(IDS.btnParseStatic, () => parseInput({ staticProviderProxies: true }));
    wireButton(IDS.btnInsert, () => insertIntoEditor());

    // Persist groups selection (if remember enabled)
    const rememberCb = $(IDS.groupsRemember);
    if (rememberCb && (!rememberCb.dataset || rememberCb.dataset.mihomoImportGroupsBound !== '1')) {
      rememberCb.addEventListener('change', () => { try { maybePersistGroupsSelection(); } catch (e) {} });
      if (rememberCb.dataset) rememberCb.dataset.mihomoImportGroupsBound = '1';
    }

    const groupsBox = $(IDS.groupsBox);
    if (groupsBox && (!groupsBox.dataset || groupsBox.dataset.mihomoImportGroupsBound !== '1')) {
      groupsBox.addEventListener('change', () => { try { maybePersistGroupsSelection(); } catch (e) {} });
      if (groupsBox.dataset) groupsBox.dataset.mihomoImportGroupsBound = '1';
    }

    const xrayIntervalInput = $(IDS.xrayInterval);
    if (xrayIntervalInput && (!xrayIntervalInput.dataset || xrayIntervalInput.dataset.mihomoImportXrayIntervalBound !== '1')) {
      xrayIntervalInput.addEventListener('change', () => {
        const hours = readXrayIntervalHours();
        saveXrayIntervalPref(hours);
        if (_lastResult && (xrayBulkOutputs(_lastResult.outputs).length || providerStaticBulkOutputs(_lastResult.outputs).length)) {
          const count = xrayBulkOutputs(_lastResult.outputs).length + providerStaticBulkOutputs(_lastResult.outputs).length;
          setStatus(
            `Распознана статическая подписка: ${count} узлов будут вставлены как блок proxies. Автообновление: каждые ${hours} ч после вставки.`,
            false,
          );
        }
      });
      if (xrayIntervalInput.dataset) xrayIntervalInput.dataset.mihomoImportXrayIntervalBound = '1';
    }

    // Engine toggle (preview)
    const sel = $(IDS.engineSelect);
    if (sel && !(sel.dataset && sel.dataset.xkWired === '1')) {
      if (sel.dataset) sel.dataset.xkWired = '1';
      sel.addEventListener('change', async () => {
        const ee = getEngineHelper();
        try { if (ee && ee.set) await ee.set(sel.value); } catch (e) {}
        scheduleEngineSync();
      });
    }

    // Listen for global engine changes
    if (!_engineUnsub) {
      const ee = getEngineHelper();
      if (ee && typeof ee.onChange === 'function') {
        _engineUnsub = ee.onChange((d) => {
          try { setEngineSelectValue(d && d.engine ? d.engine : 'codemirror'); } catch (e) {}
          if (modalOpen()) scheduleEngineSync();
        });
      }
    }

    try { bindPreviewResizeObserver(); } catch (e) {}

    // Close on backdrop click (outside content)
    if (!modal.dataset || modal.dataset.xkBackdrop !== '1') {
      modal.addEventListener('click', (e) => {
        try {
          const content = modal.querySelector('.modal-content');
          if (!content) return;
          if (e.target === modal) showModal(false);
        } catch (err) {}
      });
      if (modal.dataset) modal.dataset.xkBackdrop = '1';
    }

    // Ctrl+Enter = parse, Ctrl+Shift+Enter = insert
    const inp = $(IDS.input);
    if (inp && (!inp.dataset || inp.dataset.xkKeys !== '1')) {
      inp.addEventListener('keydown', (e) => {
        try {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            if (e.shiftKey) insertIntoEditor();
            else parseInput();
          }
        } catch (err) {}
      });
      if (inp.dataset) inp.dataset.xkKeys = '1';
    }
  };
})();
export function getMihomoImportApi() {
  try {
    if (mihomoImportModuleApi && typeof mihomoImportModuleApi.init === 'function') return mihomoImportModuleApi;
  }
  catch (error) {}
  return null;
}

function callMihomoImportApi(method, ...args) {
  const api = getMihomoImportApi();
  if (!api || typeof api[method] !== 'function') return null;
  return api[method](...args);
}

export function initMihomoImport(...args) {
  return callMihomoImportApi('init', ...args);
}

export function generateMihomoImportConfig(...args) {
  return callMihomoImportApi('generateConfigForMihomo', ...args);
}

export function proxyYamlRawFromIndentedMihomo(...args) {
  return callMihomoImportApi('proxyYamlRawFromIndented', ...args);
}

export const mihomoImportApi = Object.freeze({
  get: getMihomoImportApi,
  init: initMihomoImport,
  generateConfigForMihomo: generateMihomoImportConfig,
  proxyYamlRawFromIndented: proxyYamlRawFromIndentedMihomo,
});
