import { getBackupsApi } from './backups.js';
import { getRestartLogApi } from './restart_log.js';
import { getRoutingApi } from './routing.js';
import {
  getXkeenConfigDirtyApi,
  getXkeenFilePath,
  getXkeenUiConfigShellApi,
  openXkeenJsonEditor,
  syncXkeenBodyScrollLock,
  toastXkeen,
} from './xkeen_runtime.js';

let outboundsModuleApi = null;

(() => {
  // Outbounds editor for 04_outbounds.json (VLESS URL helper)
  // API:
  //  - GET  /api/outbounds  -> { url: "vless://..." } or {}
  //  - POST /api/outbounds  -> { ok:true, restarted?:bool }
  //
  // This module owns:
  //  - wiring of UI buttons + collapse state
  //  - load/save calls
  //  - backup button call (/api/backup-outbounds)

  outboundsModuleApi = (() => {
    let inited = false;
    let _savedUrl = '';

    // Active outbounds fragment file (basename or absolute). Controlled by dropdown.
    let _activeFragment = null;
    let _fragmentItems = [];
    let _fragmentDir = '';
    let _featureLifecycle = null;
    let _subscriptionOutputFiles = null;
    let _subscriptionOutputFilesTs = 0;
    let _outboundsNodes = [];
    let _outboundsNodeLatency = Object.create(null);
    let _outboundsNodePingState = Object.create(null);
    let _outboundsPingAllBusy = false;
    let _outboundsNodeLayoutSeq = 0;

    const IDS = {
      fragmentSelect: 'outbounds-fragment-select',
      fragmentRefresh: 'outbounds-fragment-refresh-btn',
      fileCode: 'outbounds-file-code',
    };

    const OUTBOUND_NODE_IDS = {
      panel: 'outbounds-nodes-panel',
      caption: 'outbounds-nodes-caption',
      summary: 'outbounds-nodes-summary',
      pingAll: 'outbounds-nodes-pingall',
      list: 'outbounds-nodes-list',
      empty: 'outbounds-nodes-empty',
    };

    function $(id) {
      return document.getElementById(id);
    }

    function getConfigShellApi() {
      return getXkeenUiConfigShellApi();
    }

    function refreshRestartLog() {
      try {
        const api = getRestartLogApi();
        if (api && typeof api.load === 'function') return api.load();
      } catch (e) {}
      return null;
    }

    async function streamRestartJob(jobId, intro) {
      const api = getRestartLogApi();
      if (!api || !jobId || typeof api.streamJob !== 'function') return null;
      return api.streamJob(String(jobId), {
        clear: true,
        reveal: true,
        intro: String(intro || ''),
        maxWaitMs: 5 * 60 * 1000,
      });
    }

    function getFeatureLifecycle() {
      if (_featureLifecycle) return _featureLifecycle;
      const shell = getConfigShellApi();
      if (!shell) return null;
      const factory = (typeof shell.getFeatureLifecycle === 'function')
        ? shell.getFeatureLifecycle
        : shell.createFeatureLifecycle;
      if (typeof factory !== 'function') return null;
      try {
        _featureLifecycle = factory.call(shell, 'outbounds', {
          label: 'Outbounds',
          fileCodeId: IDS.fileCode,
          dirtySourceName: 'form',
        });
      } catch (e) {
        _featureLifecycle = null;
      }
      return _featureLifecycle;
    }

    function publishLifecycleState(patch, reason) {
      const lifecycle = getFeatureLifecycle();
      if (!lifecycle || typeof lifecycle.publish !== 'function') return null;
      try {
        return lifecycle.publish(patch || {}, reason || 'outbounds-state');
      } catch (e) {}
      return null;
    }

    function syncShellState(dir, items) {
      if (dir != null) _fragmentDir = String(dir || '');
      if (Array.isArray(items)) _fragmentItems = items.slice();

      const lifecycle = getFeatureLifecycle();
      if (!lifecycle || typeof lifecycle.syncTab !== 'function') return null;

      try {
        return lifecycle.syncTab({
          label: 'Outbounds',
          fileCodeId: IDS.fileCode,
          dir: _fragmentDir,
          items: _fragmentItems,
          activeFragment: getActiveFragment(),
        });
      } catch (e) {}
      return null;
    }

    function decorateFragmentName(name) {
      const value = String(name || '');
      if (!value) return '';
      if (/_hys2\.json$/i.test(value)) return value + ' (Hysteria2)';
      return value;
    }

    function applyActiveFragment(name, dir, items) {
      _activeFragment = name ? String(name) : null;
      if (_activeFragment) rememberActiveFragment(_activeFragment);
      const nextDir = (dir != null) ? String(dir || '') : _fragmentDir;
      const cleanDir = nextDir ? String(nextDir).replace(/\/+$/, '') : '';
      try {
        updateActiveFileLabel((cleanDir ? cleanDir + '/' : '') + (_activeFragment || ''), cleanDir);
      } catch (e) {}
      try { syncShellState(cleanDir, Array.isArray(items) ? items : null); } catch (e2) {}
      return _activeFragment;
    }

    function restoreFragmentSelection(sel, fragment, dir, items) {
      const selectEl = sel || $(IDS.fragmentSelect);
      const value = String(fragment || '').trim();
      if (!selectEl || !value) return;

      let opt = null;
      try {
        opt = Array.from(selectEl.options || []).find((item) => String(item.value || '') === value) || null;
      } catch (e) {}

      if (!opt) {
        try {
          opt = document.createElement('option');
          opt.value = value;
          opt.textContent = decorateFragmentName(value) + ' (текущий)';
          selectEl.appendChild(opt);
        } catch (e2) {}
      }

      try { selectEl.value = value; } catch (e3) {}
      applyActiveFragment(value, dir, items);
    }

    async function guardFragmentSwitch(next, prev, opts) {
      const config = (opts && typeof opts === 'object') ? opts : {};
      const lifecycle = getFeatureLifecycle();
      if (!lifecycle || typeof lifecycle.guardSwitch !== 'function') {
        if (typeof config.commit === 'function') {
          await Promise.resolve(config.commit());
        }
        return true;
      }
      return lifecycle.guardSwitch(Object.assign({
        currentValue: String(prev || ''),
        nextValue: String(next || ''),
        title: 'Несохранённые изменения',
        message: 'Во вкладке outbounds есть несохранённые изменения. Переключить файл и потерять их?',
        okText: 'Переключить',
        cancelText: 'Остаться',
      }, config));
    }

    function getCurrentUrl() {
      try {
        const input = $('outbounds-url');
        return input ? String(input.value || '').trim() : '';
      } catch (e) {}
      return '';
    }

    function syncDirtyUi(dirty) {
      try {
        const saveBtn = $('outbounds-save-btn');
        if (saveBtn) saveBtn.classList.toggle('dirty', !!dirty);
      } catch (e) {}
    }

    function syncDirtyState(forceDirty) {
      const currentValue = String(getCurrentUrl() || '');
      const savedValue = String(_savedUrl || '');
      const dirty = (typeof forceDirty === 'boolean')
        ? !!forceDirty
        : (currentValue !== savedValue);

      syncDirtyUi(dirty);

      const dirtyOpts = {
        sourceName: 'form',
        scopeLabel: 'Outbounds',
        confirmTitle: 'Несохранённые изменения',
        confirmMessage: 'Во вкладке outbounds есть несохранённые изменения. Переключить файл и потерять их?',
        okText: 'Переключить',
        cancelText: 'Остаться',
        label: 'Ссылка outbounds',
        summary: dirty ? 'Текущая ссылка отличается от последней сохранённой версии.' : '',
        currentValue,
        savedValue,
      };

      const lifecycle = getFeatureLifecycle();
      if (lifecycle && typeof lifecycle.setDirty === 'function') {
        try {
          lifecycle.setDirty(dirty, dirtyOpts);
        } catch (e) {}
      }

      return dirty;
    }

    function getSelectedFragmentFromUI() {
      try {
        const sel = $(IDS.fragmentSelect);
        if (sel && sel.value) return String(sel.value);
      } catch (e) {}
      return null;
    }

    function rememberActiveFragment(name) {
      try {
        if (name) localStorage.setItem('xkeen.outbounds.fragment', String(name));
      } catch (e) {}
    }

    function restoreRememberedFragment() {
      try {
        const v = localStorage.getItem('xkeen.outbounds.fragment');
        if (v) return String(v);
      } catch (e) {}
      return null;
    }

    function getActiveFragment() {
      return getSelectedFragmentFromUI() || _activeFragment || restoreRememberedFragment() || null;
    }

    function updateActiveFileLabel(fullPathOrName, configsDir) {
      const codeEl = $(IDS.fileCode);
      if (!codeEl) return;
      const v = String(fullPathOrName || '');
      if (v) {
        codeEl.textContent = v;
        return;
      }
      try {
        const f = getActiveFragment();
        if (f && configsDir) {
          codeEl.textContent = String(configsDir).replace(/\/+$/, '') + '/' + f;
        } else if (f) {
          codeEl.textContent = f;
        }
      } catch (e) {}
    }

    function baseName(value) {
      try {
        const parts = String(value || '').split(/[\\/]+/);
        return String(parts[parts.length - 1] || '').trim();
      } catch (e) {}
      return String(value || '').trim();
    }

    async function refreshSubscriptionOutputFiles(force) {
      const now = Date.now();
      if (!force && _subscriptionOutputFiles && (now - _subscriptionOutputFilesTs) < 15000) {
        return _subscriptionOutputFiles;
      }
      const files = new Set();
      try {
        const res = await fetch('/api/xray/subscriptions', { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        const items = Array.isArray(data && data.subscriptions) ? data.subscriptions : [];
        items.forEach((sub) => {
          const name = baseName(sub && sub.output_file);
          if (name) files.add(name);
        });
      } catch (e) {}
      _subscriptionOutputFiles = files;
      _subscriptionOutputFilesTs = now;
      return files;
    }

    function getConfigOutbounds(cfg) {
      if (Array.isArray(cfg)) return cfg;
      if (cfg && typeof cfg === 'object' && Array.isArray(cfg.outbounds)) return cfg.outbounds;
      return [];
    }

    function isProxyOutbound(ob) {
      if (!ob || typeof ob !== 'object') return false;
      const protocol = String(ob.protocol || '').trim().toLowerCase();
      if (!protocol) return false;
      return !['freedom', 'blackhole', 'dns', 'loopback'].includes(protocol);
    }

    function summarizeOutboundsConfig(cfg) {
      const outbounds = getConfigOutbounds(cfg);
      const proxies = outbounds.filter(isProxyOutbound);
      const protocolCounts = {};
      const tags = [];
      proxies.forEach((ob) => {
        const protocol = String(ob.protocol || '').trim() || 'proxy';
        protocolCounts[protocol] = (protocolCounts[protocol] || 0) + 1;
        const tag = String(ob.tag || '').trim();
        if (tag) tags.push(tag);
      });
      return { outbounds, proxies, protocolCounts, tags };
    }

    function renderOutboundsFragmentSummary(fileName, summary, opts) {
      const el = $('outbounds-fragment-summary');
      if (!el) return;
      const options = (opts && typeof opts === 'object') ? opts : {};
      const s = summary || summarizeOutboundsConfig(null);
      const title = String(options.title || 'Сгенерированный фрагмент подписки');
      const emptyMeta = String(options.emptyMeta || 'outbounds подписки');
      const protocols = Object.keys(s.protocolCounts || {})
        .sort()
        .map((key) => `${escapeHtml(key)} × ${Number(s.protocolCounts[key] || 0)}`)
        .join(' · ');
      const tags = (s.tags || []).map((tag) => `<code>${escapeHtml(tag)}</code>`).join('')
        || '<span class="outbounds-fragment-empty">Теги не найдены</span>';
      el.innerHTML = `
        <div class="outbounds-fragment-summary-head">
          <div>
            <div class="outbounds-fragment-summary-title">${escapeHtml(title)}</div>
            <div class="outbounds-fragment-summary-file"><code>${escapeHtml(fileName || '04_outbounds.*.json')}</code></div>
          </div>
          <div class="outbounds-fragment-count">${Number((s.proxies || []).length)} прокси</div>
        </div>
        <div class="outbounds-fragment-summary-meta">${protocols || escapeHtml(emptyMeta)}</div>
        <div class="outbounds-fragment-tags">${tags}</div>
      `;
    }

    function setOutboundsSummaryFragmentMode(mode, fileName, summary) {
      const body = $('outbounds-body');
      const input = $('outbounds-url');
      const summaryEl = $('outbounds-fragment-summary');
      const normalizedMode = String(mode || '').trim().toLowerCase();
      const enabled = !!normalizedMode;
      try {
        if (body) {
          body.classList.toggle('xk-outbounds-summary-fragment', enabled);
          body.classList.toggle('xk-outbounds-subscription-fragment', normalizedMode === 'subscription');
          body.classList.toggle('xk-outbounds-pool-fragment', normalizedMode === 'pool');
        }
      } catch (e) {}

      if (enabled) {
        if (input) {
          input.value = '';
          input.classList.remove('xk-invalid');
        }
        try { renderParsePreview({ ok: false, scheme: '', fields: {}, errors: [], warnings: [] }); } catch (e) {}
        const isPool = normalizedMode === 'pool';
        renderOutboundsFragmentSummary(fileName, summary, {
          title: isPool ? 'Пул прокси' : 'Сгенерированный фрагмент подписки',
          emptyMeta: isPool ? 'outbounds пула' : 'outbounds подписки',
        });
        try { if (summaryEl) summaryEl.classList.remove('hidden'); } catch (e2) {}
      } else {
        try { if (summaryEl) summaryEl.classList.add('hidden'); } catch (e) {}
      }
    }

    function setSubscriptionFragmentMode(enabled, fileName, summary) {
      setOutboundsSummaryFragmentMode(enabled ? 'subscription' : '', fileName, summary);
    }

    function setPoolFragmentMode(enabled, fileName, summary) {
      setOutboundsSummaryFragmentMode(enabled ? 'pool' : '', fileName, summary);
    }

    function isSubscriptionFragmentMode() {
      const body = $('outbounds-body');
      try { return !!(body && body.classList.contains('xk-outbounds-subscription-fragment')); } catch (e) {}
      return false;
    }

    function isOutboundsSummaryFragmentMode() {
      const body = $('outbounds-body');
      try { return !!(body && body.classList.contains('xk-outbounds-summary-fragment')); } catch (e) {}
      return false;
    }

    function isPoolGeneratedText(text) {
      return /Generated\s+by\s+XKeen\s+UI\s+\(outbounds\s+pool\)/i.test(String(text || ''));
    }

    function shouldUsePoolFragmentSummary(data, summary) {
      const s = summary || summarizeOutboundsConfig(null);
      const proxyCount = Array.isArray(s.proxies) ? s.proxies.length : 0;
      if (proxyCount <= 0) return false;
      if (isPoolGeneratedText(data && data.text)) return true;
      return !((data && data.url) || '') && proxyCount > 0;
    }

    function outboundsNodesApiUrl(suffix) {
      let url = '/api/xray/outbounds/nodes' + String(suffix || '');
      const f = getActiveFragment();
      if (f) url += '?file=' + encodeURIComponent(String(f));
      return url;
    }

    function outboundsNodePingStateKey(nodeKey) {
      return [String(getActiveFragment() || ''), String(nodeKey || '')].join('::');
    }

    function outboundsNodeLatencyEntry(nodeKey) {
      const key = String(nodeKey || '').trim();
      const map = (_outboundsNodeLatency && typeof _outboundsNodeLatency === 'object') ? _outboundsNodeLatency : {};
      const item = key ? map[key] : null;
      return (item && typeof item === 'object') ? item : null;
    }

    function outboundsSetNodes(nodes, latency) {
      _outboundsNodes = Array.isArray(nodes) ? nodes : [];
      _outboundsNodeLatency = (latency && typeof latency === 'object') ? latency : Object.create(null);
      outboundsRenderNodeList();
    }

    function outboundsSetNodesVisible(visible) {
      const panel = $(OUTBOUND_NODE_IDS.panel);
      if (!panel) return;
      try { panel.classList.toggle('hidden', !visible); } catch (e) {}
    }

    function outboundsCanRelayoutNodeList() {
      const body = $('outbounds-body');
      const panel = $(OUTBOUND_NODE_IDS.panel);
      const listEl = $(OUTBOUND_NODE_IDS.list);
      if (!body || !panel || !listEl) return false;
      try {
        if (body.style && body.style.display === 'none') return false;
      } catch (e) {}
      try {
        if (panel.classList && panel.classList.contains('hidden')) return false;
      } catch (e2) {}
      try {
        const bodyStyle = (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function')
          ? window.getComputedStyle(body)
          : null;
        if (bodyStyle && bodyStyle.display === 'none') return false;
      } catch (e3) {}
      try {
        const panelStyle = (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function')
          ? window.getComputedStyle(panel)
          : null;
        if (panelStyle && panelStyle.display === 'none') return false;
      } catch (e4) {}
      const width = Number(listEl.clientWidth || panel.clientWidth || body.clientWidth || 0);
      return width > 0;
    }

    function scheduleOutboundsNodeListLayout() {
      const nodes = Array.isArray(_outboundsNodes) ? _outboundsNodes : [];
      if (!nodes.length) return;
      const seq = ++_outboundsNodeLayoutSeq;
      const run = () => {
        if (seq !== _outboundsNodeLayoutSeq) return;
        if (!outboundsCanRelayoutNodeList()) return;
        const listEl = $(OUTBOUND_NODE_IDS.list);
        if (!listEl) return;
        try { void listEl.offsetHeight; } catch (e) {}
        try { outboundsRenderNodeList(); } catch (e2) {}
      };

      run();
      try { requestAnimationFrame(run); } catch (e) { setTimeout(run, 0); }
      setTimeout(run, 0);
      setTimeout(run, 60);
      setTimeout(run, 180);
    }

    function onShow(opts) {
      const reason = String((opts && opts.reason) || 'show');
      const rerunLayout = () => {
        try {
          const body = $('outbounds-body');
          if (!body || body.style.display === 'none') return;
        } catch (e) {}
        try { scheduleOutboundsNodeListLayout(); } catch (e2) {}
      };

      try {
        requestAnimationFrame(() => {
          rerunLayout();
          try { setTimeout(rerunLayout, 0); } catch (e) {}
          try { setTimeout(rerunLayout, 120); } catch (e2) {}
          try { setTimeout(rerunLayout, 260); } catch (e3) {}
        });
      } catch (e) {
        rerunLayout();
      }

      return reason;
    }

    async function refreshOutboundsNodes(visible) {
      if (isSubscriptionFragmentMode()) {
        outboundsSetNodes([], {});
        outboundsSetNodesVisible(false);
        return false;
      }
      try {
        const res = await fetch(outboundsNodesApiUrl(''), { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data || data.ok === false) {
          outboundsSetNodes([], {});
          outboundsSetNodesVisible(false);
          return false;
        }
        outboundsSetNodes(
          Array.isArray(data.nodes) ? data.nodes : [],
          (data.node_latency && typeof data.node_latency === 'object') ? data.node_latency : {},
        );
        const hasNodes = Array.isArray(data.nodes) && data.nodes.length > 0;
        outboundsSetNodesVisible(visible !== false && hasNodes);
        if (visible !== false && hasNodes) scheduleOutboundsNodeListLayout();
        return hasNodes;
      } catch (e) {
        outboundsSetNodes([], {});
        outboundsSetNodesVisible(false);
        return false;
      }
    }

    function outboundsUpdatePingAllBtnState() {
      const btn = $(OUTBOUND_NODE_IDS.pingAll);
      if (!btn) return;
      const nodes = Array.isArray(_outboundsNodes) ? _outboundsNodes : [];
      const hasPingable = nodes.some((node) => node && node.key && node.tag);
      const tooltip = _outboundsPingAllBusy
        ? 'Идёт проверка задержки всех proxy-узлов.'
        : (hasPingable
          ? 'Проверить задержку всех proxy-узлов в текущем 04_outbounds-фрагменте.'
          : 'В текущем outbounds-фрагменте нет proxy-узлов для проверки.');
      btn.setAttribute('data-tooltip', tooltip);
      btn.setAttribute('title', tooltip);
      btn.setAttribute('aria-label', hasPingable ? 'Пинг всех proxy-узлов' : 'Пинг всех proxy-узлов недоступен');
      btn.disabled = _outboundsPingAllBusy || !hasPingable;
      btn.classList.toggle('is-busy', !!_outboundsPingAllBusy);
    }

    function outboundsRenderNodeList() {
      const panel = $(OUTBOUND_NODE_IDS.panel);
      const caption = $(OUTBOUND_NODE_IDS.caption);
      const summary = $(OUTBOUND_NODE_IDS.summary);
      const listEl = $(OUTBOUND_NODE_IDS.list);
      const empty = $(OUTBOUND_NODE_IDS.empty);
      if (!panel || !caption || !summary || !listEl || !empty) return;

      const nodes = Array.isArray(_outboundsNodes) ? _outboundsNodes : [];
      const rows = [];
      nodes.forEach((node) => {
        const keyText = String(node && node.key ? node.key : '').trim();
        const tagText = String(node && node.tag ? node.tag : '').trim();
        const key = escapeHtml(keyText);
        const name = escapeHtml(String(node && node.name ? node.name : tagText || 'proxy'));
        const tag = escapeHtml(tagText);
        const protocol = escapeHtml(String(node && node.protocol ? node.protocol : ''));
        const transport = escapeHtml(String(node && node.transport ? node.transport : ''));
        const security = escapeHtml(String(node && node.security ? node.security : ''));
        const host = escapeHtml(String(node && node.host ? node.host : ''));
        const port = escapeHtml(String(node && (node.port || node.port === 0) ? node.port : ''));
        const detail = escapeHtml(String(node && node.detail ? node.detail : ''));
        const endpoint = [host, port].filter(Boolean).join(':');
        const canPing = !!(keyText && tagText);
        const pingBusy = !!_outboundsNodePingState[outboundsNodePingStateKey(keyText)];
        const latencyEntry = outboundsNodeLatencyEntry(keyText);
        const latencyLabel = escapeHtml(subsNodeLatencyLabel(latencyEntry, pingBusy, canPing));
        const latencyTooltip = escapeHtml(subsNodeLatencyTooltip(latencyEntry, pingBusy, canPing));
        const latencyClass = subsNodeLatencyTone(latencyEntry, pingBusy, canPing);
        rows.push(`
          <div class="xk-sub-node-item xk-outbounds-node-item is-enabled" data-node-key="${key}">
            <div class="xk-sub-node-main">
              <div class="xk-sub-node-name">${name}</div>
              <div class="xk-sub-node-meta">
                ${protocol ? `<span class="xk-sub-node-pill">${protocol}</span>` : ''}
                ${transport ? `<span class="xk-sub-node-pill xk-sub-node-pill-transport">${transport}</span>` : ''}
                ${security ? `<span class="xk-sub-node-pill xk-sub-node-pill-security">${security}</span>` : ''}
                ${endpoint ? `<span class="xk-sub-node-endpoint">${endpoint}</span>` : ''}
              </div>
              ${detail ? `<div class="xk-sub-node-detail">${detail}</div>` : ''}
            </div>
            <div class="xk-sub-node-side">
              <div class="xk-sub-node-latency ${latencyClass}" data-tooltip="${latencyTooltip}">${latencyLabel}</div>
              <div class="xk-sub-node-state is-enabled">${tag || 'proxy'}</div>
              <div class="xk-sub-node-actions">
                <button type="button" class="btn-secondary btn-compact xk-sub-node-ping xk-outbounds-node-ping ${pingBusy ? 'is-busy' : ''}" data-node-key="${key}" title="Проверить задержку" data-tooltip="${escapeHtml(canPing ? 'Проверить задержку этого proxy-узла.' : 'Узел нельзя проверить: не найден tag.')}" aria-label="Проверить задержку" ${canPing ? '' : 'disabled'}>
                  <span class="xk-sub-icon-glyph" aria-hidden="true">⏱</span>
                </button>
              </div>
            </div>
          </div>
        `);
      });

      summary.textContent = String(nodes.length || 0);
      caption.textContent = nodes.length === 1
        ? 'Одиночный proxy-узел из текущего outbounds-фрагмента.'
        : (nodes.length > 1 ? `Пул proxy-узлов: ${nodes.length}.` : 'Proxy-узлы не найдены.');
      listEl.innerHTML = rows.join('');
      empty.style.display = rows.length ? 'none' : 'block';
      empty.textContent = 'Proxy-узлы не найдены.';
      outboundsSetNodesVisible(nodes.length > 0);
      outboundsUpdatePingAllBtnState();

      Array.from(listEl.querySelectorAll('.xk-outbounds-node-ping')).forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (btn.disabled) return;
          const nodeKey = String(btn.getAttribute('data-node-key') || '').trim();
          if (!nodeKey) return;
          await outboundsProbeNode(nodeKey);
        });
      });
    }

    async function outboundsProbeNode(nodeKey) {
      const key = String(nodeKey || '').trim();
      if (!key) return false;
      const pendingKey = outboundsNodePingStateKey(key);
      if (_outboundsNodePingState[pendingKey]) return false;
      _outboundsNodePingState[pendingKey] = true;
      try { outboundsRenderNodeList(); } catch (e) {}
      const statusEl = $('outbounds-status');
      if (statusEl) statusEl.textContent = 'Проверяю задержку proxy-узла…';
      try {
        const res = await fetch(outboundsNodesApiUrl('/ping'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ node_key: key }),
        });
        const data = await res.json().catch(() => ({}));
        if (data && data.entry) _outboundsNodeLatency[key] = data.entry;
        if (!res.ok || !data || data.ok === false) {
          const msg = String((data && (data.error || data.message)) || 'Не удалось проверить задержку proxy-узла.');
          if (statusEl) statusEl.textContent = msg;
          try { toastXkeen(msg, 'error'); } catch (e2) {}
          return false;
        }
        const delay = Number(data.delay_ms || (data.entry && data.entry.delay_ms));
        if (statusEl) {
          statusEl.textContent = Number.isFinite(delay) && delay >= 0
            ? `Задержка proxy-узла: ${Math.round(delay)} ms.`
            : 'Проверка proxy-узла завершена.';
        }
        return true;
      } catch (e) {
        const msg = 'Ошибка проверки задержки: ' + String(e && e.message ? e.message : e);
        if (statusEl) statusEl.textContent = msg;
        try { toastXkeen(msg, 'error'); } catch (e2) {}
        return false;
      } finally {
        delete _outboundsNodePingState[pendingKey];
        try { outboundsRenderNodeList(); } catch (e3) {}
      }
    }

    async function outboundsProbeAllNodes() {
      if (_outboundsPingAllBusy) return false;
      const nodes = (Array.isArray(_outboundsNodes) ? _outboundsNodes : [])
        .filter((node) => node && node.key && node.tag);
      const statusEl = $('outbounds-status');
      if (!nodes.length) {
        if (statusEl) statusEl.textContent = 'В текущем outbounds-фрагменте нет proxy-узлов для проверки.';
        return false;
      }

      _outboundsPingAllBusy = true;
      const pendingKeys = nodes.map((node) => outboundsNodePingStateKey(String(node.key || ''))).filter(Boolean);
      pendingKeys.forEach((key) => { _outboundsNodePingState[key] = true; });
      outboundsUpdatePingAllBtnState();
      try { outboundsRenderNodeList(); } catch (e) {}
      if (statusEl) statusEl.textContent = `Проверяю задержку: ${nodes.length} proxy-узлов…`;

      try {
        const res = await fetch(outboundsNodesApiUrl('/ping-bulk'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ node_keys: nodes.map((node) => String(node.key || '')).filter(Boolean) }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data) {
          throw new Error(String((data && (data.error || data.message)) || ('HTTP ' + res.status)));
        }
        if (data.node_latency && typeof data.node_latency === 'object') {
          _outboundsNodeLatency = data.node_latency;
        } else if (Array.isArray(data.results)) {
          data.results.forEach((item) => {
            const key = String(item && item.node_key || '').trim();
            if (!key || !item || !item.entry) return;
            _outboundsNodeLatency[key] = item.entry;
          });
        }
        const ok = Number(data.ok_count || 0);
        const failed = Number(data.failed_count || 0);
        const total = Number(data.requested || nodes.length);
        if (statusEl) {
          statusEl.textContent = failed <= 0
            ? `Проверено proxy-узлов: ${ok}.`
            : `Проверено ${ok} из ${total}, ошибок: ${failed}.`;
        }
        return failed <= 0;
      } catch (e) {
        const msg = 'Ошибка массовой проверки задержки: ' + String(e && e.message ? e.message : e);
        if (statusEl) statusEl.textContent = msg;
        try { toastXkeen(msg, 'error'); } catch (e2) {}
        return false;
      } finally {
        pendingKeys.forEach((key) => { delete _outboundsNodePingState[key]; });
        _outboundsPingAllBusy = false;
        outboundsUpdatePingAllBtnState();
        try { outboundsRenderNodeList(); } catch (e) {}
      }
    }

    async function isSubscriptionOutputFragment(fileName) {
      const name = baseName(fileName);
      if (!name) return false;
      const files = await refreshSubscriptionOutputFiles(false);
      return !!(files && files.has(name));
    }

    async function refreshFragmentsList(opts) {
      const sel = $(IDS.fragmentSelect);
      if (!sel) return;

      const notify = !!(opts && opts.notify);

      let data = null;
      try {
        const res = await fetch('/api/outbounds/fragments', { cache: 'no-store' });
        data = await res.json().catch(() => null);
      } catch (e) {
        data = null;
      }
      if (!data || !data.ok || !Array.isArray(data.items)) {
        try { if (notify) toastXkeen('Не удалось обновить список outbounds', 'error'); } catch (e) {}
        return;
      }

      const currentDefault = (data.current || sel.dataset.current || '').toString();
      const remembered = restoreRememberedFragment();
      const preferred = (getActiveFragment() || remembered || currentDefault || (data.items[0] ? data.items[0].name : '')).toString();

      try { if (sel.dataset) sel.dataset.dir = String(data.dir || ''); } catch (e) {}
      sel.innerHTML = '';

      const names = data.items.map((it) => String(it.name || '')).filter(Boolean);
      if (currentDefault && names.indexOf(currentDefault) === -1) {
        const opt = document.createElement('option');
        opt.value = currentDefault;
        opt.textContent = decorateFragmentName(currentDefault) + ' (текущий)';
        sel.appendChild(opt);
      }

      data.items.forEach((it) => {
        const name = String(it.name || '');
        if (!name) return;
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = decorateFragmentName(name);
        sel.appendChild(opt);
      });

      try {
        const finalChoice = names.indexOf(preferred) !== -1 ? preferred : (currentDefault || (names[0] || ''));
        if (finalChoice) sel.value = finalChoice;
        const dir = data.dir ? String(data.dir).replace(/\/+$/, '') : '';
        applyActiveFragment(sel.value || finalChoice || null, dir, data.items);
      } catch (e) {}

      // Wire refresh button
      try {
        const btn = $(IDS.fragmentRefresh);
        if (btn && !btn.dataset.xkWired) {
          btn.addEventListener('click', async (e) => {
            e.preventDefault();
            const prev = getActiveFragment();
            const prevDir = _fragmentDir;
            await refreshFragmentsList({ notify: true });
            const next = getActiveFragment();
            if (!next || next === prev) return;
            await guardFragmentSwitch(next, prev, {
              onCancel: () => restoreFragmentSelection(sel, prev, prevDir, _fragmentItems),
              commit: async () => { await load(); },
            });
          });
          btn.dataset.xkWired = '1';
        }
      } catch (e) {}

      // Success toast (only when explicitly requested)
      try { if (notify) toastXkeen('Список outbounds обновлён', 'success'); } catch (e) {}

      // Wire select change
      try {
        if (!sel.dataset.xkWired) {
          sel.addEventListener('change', async () => {
            const next = String(sel.value || '');
            if (!next) return;
            const prev = _activeFragment || String(sel.dataset.current || '');
            const dir = sel.dataset && sel.dataset.dir ? String(sel.dataset.dir) : _fragmentDir;
            await guardFragmentSwitch(next, prev, {
              onCancel: () => restoreFragmentSelection(sel, prev, dir, _fragmentItems),
              commit: async () => {
                applyActiveFragment(next, dir);
                await load();
              },
            });
          });
          sel.dataset.xkWired = '1';
        }
      } catch (e) {}
    }

    function wireButton(btnId, handler) {
      const btn = $(btnId);
      if (!btn) return;
      if (btn.dataset && btn.dataset.xkeenWired === '1') return;

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        handler();
      });

      if (btn.dataset) btn.dataset.xkeenWired = '1';
    }

    function bindConfigAction(btnId, handler, opts) {
      const lifecycle = getFeatureLifecycle();
      if (!lifecycle || typeof lifecycle.bindAction !== 'function') return false;
      try {
        return !!lifecycle.bindAction(btnId, handler, opts || {});
      } catch (e) {}
      return false;
    }

    function wireHeader(headerId, handler) {
      const header = $(headerId);
      if (!header) return;
      if (header.dataset && header.dataset.xkeenWiredHeader === '1') return;

      header.addEventListener('click', (e) => {
        const target = e.target;
        if (target && (target.closest && target.closest('button, a, input, label, select, textarea'))) return;
        e.preventDefault();
        handler();
      });

      if (header.dataset) header.dataset.xkeenWiredHeader = '1';
    }

    function shouldRestartAfterSave() {
      // Global toggle on panel.html; absent on dedicated pages => default true
      const cb = $('global-autorestart-xkeen');
      if (!cb) return true;
      return !!cb.checked;
    }

    /* Outbounds: URL hints (dropdown protocol/type/security)
     * These dropdowns do NOT replace the generator, they only help avoid mistakes when pasting links.
     * We auto-detect current scheme and update dropdowns; and if user changes type/security for vless/trojan,
     * we gently apply params back to the URL (only type/security).
     */

    function detectScheme(url) {
      const s = String(url || '').trim();
      const m = s.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
      return m ? m[1].toLowerCase() : '';
    }

    function safeB64Decode(str) {
      // Decode URL-safe base64 into a UTF-8 string.
      // Works better for vmess:// with non-ascii tags.
      try {
        let s = String(str || '').trim().replace(/-/g, '+').replace(/_/g, '/');
        s = s.padEnd(s.length + ((4 - (s.length % 4)) % 4), '=');
        const bin = atob(s);
        // If TextDecoder exists, treat as UTF-8 bytes.
        if (typeof TextDecoder !== 'undefined') {
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        }
        return bin;
      } catch (e) {
        return '';
      }
    }

    function safeB64Encode(str) {
      // Encode UTF-8 string into URL-safe base64 without padding.
      try {
        let bin = '';
        if (typeof TextEncoder !== 'undefined') {
          const bytes = new TextEncoder().encode(String(str || ''));
          // bytes length is small (vmess json), safe to concat
          for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        } else {
          bin = String(str || '');
        }
        return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
      } catch (e) {
        return '';
      }
    }

    function escapeHtml(s) {
      return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function isValidPort(p) {
      const n = Number(p);
      return Number.isFinite(n) && n > 0 && n <= 65535;
    }

    function looksLikeUuid(s) {
      const v = String(s || '').trim();
      if (!v) return false;
      const re1 = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
      const re2 = /^[0-9a-fA-F]{32}$/;
      return re1.test(v) || re2.test(v);
    }

    function maskSecret(s) {
      const v = String(s || '');
      if (!v) return '';
      if (v.length <= 6) return '***';
      return v.slice(0, 3) + '***' + v.slice(-3);
    }

    // ---------- Client-side parse/validation + preview ----------

    function parseSS(url) {
      const out = {
        ok: false,
        scheme: 'ss',
        fields: {},
        errors: [],
        warnings: [],
        type: 'tcp',
        security: 'none'
      };

      let s = String(url || '').trim();
      if (!s.toLowerCase().startsWith('ss://')) {
        out.errors.push('Ожидается ссылка ss://');
        return out;
      }

      // Split fragment/tag
      let tag = '';
      const hashIdx = s.indexOf('#');
      if (hashIdx >= 0) {
        tag = s.slice(hashIdx + 1);
        s = s.slice(0, hashIdx);
        try { tag = decodeURIComponent(tag); } catch (e) {}
      }

      // Split query
      let query = '';
      const qIdx = s.indexOf('?');
      if (qIdx >= 0) {
        query = s.slice(qIdx + 1);
        s = s.slice(0, qIdx);
      }

      const plugin = (() => {
        if (!query) return '';
        try {
          const qs = new URLSearchParams(query);
          return qs.get('plugin') || '';
        } catch (e) {
          return '';
        }
      })();

      let rest = s.slice(5); // after ss://
      if (!rest) {
        out.errors.push('Пустая ссылка ss://');
        return out;
      }

      // Try to obtain "userinfo@host:port"
      let userinfo = '';
      let hostport = '';

      if (rest.includes('@')) {
        const parts = rest.split('@');
        userinfo = parts[0] || '';
        hostport = parts.slice(1).join('@');
      } else {
        const decoded = safeB64Decode(rest);
        if (decoded && decoded.includes('@')) {
          const parts = decoded.split('@');
          userinfo = parts[0] || '';
          hostport = parts.slice(1).join('@');
        } else if (decoded && decoded.includes(':') && decoded.match(/:\d+$/)) {
          // Sometimes the whole payload decodes to method:pass@host:port or method:pass:host:port (rare)
          // Keep as-is and fall-through
          rest = decoded;
        }
      }

      // If still no hostport, maybe the decoded payload already contains both parts
      if (!hostport && rest.includes('@')) {
        const parts = rest.split('@');
        userinfo = parts[0] || '';
        hostport = parts.slice(1).join('@');
      }

      // Decode userinfo if needed
      let creds = String(userinfo || '');
      if (creds && !creds.includes(':')) {
        const dec = safeB64Decode(creds);
        if (dec && dec.includes(':')) creds = dec;
      }

      // If creds still contain host:port inside (full base64 form)
      if (creds && creds.includes('@') && !hostport) {
        const parts = creds.split('@');
        creds = parts[0] || '';
        hostport = parts.slice(1).join('@');
      }

      let method = '';
      let password = '';
      if (creds && creds.includes(':')) {
        const idx = creds.indexOf(':');
        method = creds.slice(0, idx);
        password = creds.slice(idx + 1);
      }

      // Parse host:port (IPv6-friendly)
      let host = '';
      let port = '';
      const hp = String(hostport || '').trim();
      if (hp.startsWith('[')) {
        const m = hp.match(/^\[([^\]]+)\]:(\d+)$/);
        if (m) {
          host = m[1];
          port = m[2];
        }
      } else {
        const idx = hp.lastIndexOf(':');
        if (idx > 0) {
          host = hp.slice(0, idx);
          port = hp.slice(idx + 1);
        }
      }

      if (!method) out.errors.push('Не удалось распознать метод (cipher) для ss://');
      if (!password) out.errors.push('Не удалось распознать пароль для ss://');
      if (!host) out.errors.push('Не удалось распознать host для ss://');
      if (!port || !isValidPort(port)) out.errors.push('Не удалось распознать корректный порт для ss://');

      out.fields['Protocol'] = 'ss';
      if (tag) out.fields['Tag'] = tag;
      if (host) out.fields['Server'] = host;
      if (port) out.fields['Port'] = port;
      if (method) out.fields['Cipher'] = method;
      if (plugin) out.fields['Plugin'] = plugin;

      out.ok = out.errors.length === 0;
      return out;
    }

    function parseHY2(url) {
      const out = {
        ok: false,
        scheme: 'hy2',
        fields: {},
        errors: [],
        warnings: [],
        type: 'hysteria',
        security: 'tls'
      };

      const s0 = String(url || '').trim();
      const scheme = detectScheme(s0);
      if (!(scheme === 'hy2' || scheme === 'hysteria2' || scheme === 'hysteria')) {
        out.errors.push('Ожидается ссылка hy2://');
        return out;
      }

      let u;
      try {
        u = new URL(s0);
      } catch (e) {
        out.errors.push('Некорректная ссылка HY2: не удалось распарсить URL');
        return out;
      }

      const host = (u.hostname || '').trim();
      const port = String(u.port || '').trim();
      const user = (u.username || '').trim();
      const pass = (u.password || '').trim();
      const auth = (user || pass) ? (user + (pass ? ':' + pass : '')) : '';

      if (!host) out.errors.push('Не указан host');
      if (port && !isValidPort(port)) out.errors.push('Некорректный port');
      if (!auth) out.errors.push('Не указан auth (username/password)');

      // basic params
      const qs = u.searchParams;
      const sni = (qs.get('sni') || '').trim();
      const insecure = (qs.get('insecure') || qs.get('allowInsecure') || '').trim();
      const obfs = (qs.get('obfs') || '').trim();
      const obfsPwd = (qs.get('obfs-password') || qs.get('obfs_password') || '').trim();
      const pin = (qs.get('pinSHA256') || '').trim();

      out.fields['Host'] = host;
      if (port) out.fields['Port'] = port;
      if (auth) out.fields['Auth'] = maskSecret(auth);
      if (sni) out.fields['SNI'] = sni;
      if (insecure) out.fields['Insecure'] = insecure;
      if (obfs) out.fields['Obfs'] = obfs;
      if (obfsPwd) out.fields['Obfs Password'] = maskSecret(obfsPwd);
      if (pin) out.fields['PinSHA256'] = pin;

      if (obfs && obfs.toLowerCase() !== 'salamander') {
        out.warnings.push('Obfs кроме salamander сейчас может не поддерживаться ядром Xray');
      }

      // pinSHA256 поддерживается: будет добавлен в Xray-конфиг как
      // tlsSettings.pinnedPeerCertificateChainSha256

      out.ok = out.errors.length === 0;
      return out;
    }

    function parseVMess(url) {
      const out = {
        ok: false,
        scheme: 'vmess',
        fields: {},
        errors: [],
        warnings: [],
        type: 'tcp',
        security: 'none'
      };

      const s = String(url || '').trim();
      if (!s.toLowerCase().startsWith('vmess://')) {
        out.errors.push('Ожидается ссылка vmess://');
        return out;
      }

      const payload = s.slice(8);
      if (!payload) {
        out.errors.push('Пустая ссылка vmess://');
        return out;
      }

      const decoded = safeB64Decode(payload);
      if (!decoded) {
        out.errors.push('Не удалось декодировать base64 для vmess://');
        return out;
      }

      let data = null;
      try {
        data = JSON.parse(decoded);
      } catch (e) {
        out.errors.push('vmess:// не похож на JSON (base64)');
        return out;
      }

      const host = (data.add || '').toString();
      const port = (data.port || '').toString();
      const uuid = (data.id || '').toString();
      const ps = (data.ps || '').toString();
      const net = (data.net || 'tcp').toString().toLowerCase();
      const tls = (data.tls || '').toString().toLowerCase();
      const sni = (data.sni || data.host || '').toString();

      out.type = net || 'tcp';
      out.security = (tls === 'tls') ? 'tls' : 'none';

      if (!host) out.errors.push('vmess://: отсутствует add (host)');
      if (!port || !isValidPort(port)) out.errors.push('vmess://: некорректный port');
      if (!uuid) out.errors.push('vmess://: отсутствует id (UUID)');
      if (uuid && !looksLikeUuid(uuid)) out.warnings.push('vmess://: id не похож на UUID');

      out.fields['Protocol'] = 'vmess';
      if (ps) out.fields['Tag'] = ps;
      if (host) out.fields['Server'] = host;
      if (port) out.fields['Port'] = port;
      if (uuid) out.fields['UUID'] = uuid;
      out.fields['Transport'] = out.type;
      out.fields['Security'] = out.security;
      if (sni) out.fields['SNI/Host'] = sni;
      if (data.path) out.fields['Path'] = data.path;
      if (data.host && net === 'ws') out.fields['WS Host'] = data.host;
      if (data.scy) out.fields['Cipher'] = data.scy;
      if (data.alpn) out.fields['ALPN'] = data.alpn;
      if (data.fp) out.fields['FP'] = data.fp;

      out.ok = out.errors.length === 0;
      return out;
    }

    function parseVlessOrTrojan(url, scheme) {
      const out = {
        ok: false,
        scheme,
        fields: {},
        errors: [],
        warnings: [],
        type: 'tcp',
        security: 'auto'
      };

      let u;
      try {
        u = new URL(url);
      } catch (e) {
        out.errors.push('Ссылка не похожа на корректный URL');
        return out;
      }

      const user = (u.username || '').toString();
      const host = (u.hostname || '').toString();
      const port = (u.port || '').toString();
      const tag = (u.hash || '').replace(/^#/, '');

      const type = (u.searchParams.get('type') || u.searchParams.get('net') || 'tcp').toLowerCase();
      const secRaw = (u.searchParams.get('security') || '').toLowerCase();
      // For UI we treat VLESS as reality by default, Trojan as TLS by default
      const security = secRaw || (scheme === 'trojan' ? 'tls' : 'reality');

      const sni = (u.searchParams.get('sni') || u.searchParams.get('serverName') || '').toString();
      const fp = (u.searchParams.get('fp') || '').toString();
      const alpn = (u.searchParams.get('alpn') || '').toString();
      const flow = (u.searchParams.get('flow') || '').toString();
      const pbk = (u.searchParams.get('pbk') || u.searchParams.get('publicKey') || '').toString();
      const sid = (u.searchParams.get('sid') || u.searchParams.get('shortId') || '').toString();

      const path = (u.searchParams.get('path') || '').toString();
      const wsHost = (u.searchParams.get('host') || '').toString();
      const serviceName = (u.searchParams.get('serviceName') || '').toString();
      const authority = (u.searchParams.get('authority') || '').toString();
      const mode = (u.searchParams.get('mode') || '').toString();

      out.type = type || 'tcp';
      out.security = security || 'auto';

      if (!host) out.errors.push('Отсутствует host');
      if (!port || !isValidPort(port)) out.errors.push('Некорректный порт');

      if (!user) out.errors.push(scheme === 'vless' ? 'Отсутствует UUID' : 'Отсутствует пароль');

      if (scheme === 'vless' && user && !looksLikeUuid(user)) {
        out.warnings.push('UUID не похож на UUID (проверь ссылку)');
      }

      if (out.security === 'reality') {
        if (!pbk) out.errors.push('Reality: отсутствует pbk (publicKey)');
        if (!sid) out.warnings.push('Reality: желательно указать sid (shortId)');
        if (!sni) out.warnings.push('Reality: желательно указать sni/serverName');
      }

      if (out.type === 'ws' || out.type === 'httpupgrade') {
        if (!path) out.warnings.push('Для WS/HTTP Upgrade обычно нужен параметр path');
      }

      if (out.type === 'grpc') {
        if (!serviceName) out.warnings.push('Для gRPC обычно нужен serviceName');
      }

      out.fields['Protocol'] = scheme;
      if (tag) out.fields['Tag'] = (() => { try { return decodeURIComponent(tag); } catch (e) { return tag; } })();
      if (host) out.fields['Server'] = host;
      if (port) out.fields['Port'] = port;
      if (scheme === 'vless' && user) out.fields['UUID'] = user;
      if (scheme === 'trojan' && user) out.fields['Password'] = maskSecret(user);
      out.fields['Transport'] = out.type;
      out.fields['Security'] = out.security;
      if (sni) out.fields['SNI'] = sni;
      if (flow) out.fields['Flow'] = flow;
      if (alpn) out.fields['ALPN'] = alpn;
      if (fp) out.fields['FP'] = fp;
      if (pbk) out.fields['PBK'] = pbk;
      if (sid) out.fields['SID'] = sid;
      if (path) out.fields['Path'] = path;
      if (wsHost) out.fields[(out.type === 'ws' ? 'WS Host' : 'Host')] = wsHost;
      if (serviceName) out.fields['ServiceName'] = serviceName;
      if (authority) out.fields['Authority'] = authority;
      if (mode) out.fields['Mode'] = mode;

      out.ok = out.errors.length === 0;
      return out;
    }

    function parseProxyUrl(url) {
      const s = String(url || '').trim();
      const scheme = detectScheme(s);
      if (!s) {
        return { ok: false, scheme: '', fields: {}, errors: [], warnings: [] };
      }
      if (scheme === 'vless') return parseVlessOrTrojan(s, 'vless');
      if (scheme === 'trojan') return parseVlessOrTrojan(s, 'trojan');
      if (scheme === 'vmess') return parseVMess(s);
      if (scheme === 'ss') return parseSS(s);
      if (scheme === 'hy2' || scheme === 'hysteria2' || scheme === 'hysteria') return parseHY2(s);
      return {
        ok: false,
        scheme: scheme || '',
        fields: {},
        errors: ['Поддерживаются только vless://, trojan://, vmess://, ss:// или hy2://'],
        warnings: []
      };
    }

    function renderParsePreview(parsed) {
      const box = $('outbounds-parse-box');
      const kv = $('outbounds-parse-kv');
      const err = $('outbounds-parse-error');
      const warn = $('outbounds-parse-warn');

      const badgeProto = $('outbounds-badge-proto');
      const badgeType = $('outbounds-badge-type');
      const badgeSec = $('outbounds-badge-sec');
      const badgeOk = $('outbounds-badge-state');
      const badgeBad = $('outbounds-badge-state-bad');

      if (!box || !kv || !err || !warn || !badgeProto || !badgeType || !badgeSec || !badgeOk || !badgeBad) return;

      const hasAny = parsed && (parsed.scheme || (parsed.fields && Object.keys(parsed.fields).length) || (parsed.errors && parsed.errors.length) || (parsed.warnings && parsed.warnings.length));
      box.style.display = hasAny ? 'block' : 'none';

      badgeProto.textContent = parsed.scheme ? parsed.scheme.toUpperCase() : '—';
      badgeType.textContent = parsed.type ? String(parsed.type).toUpperCase() : '—';
      badgeSec.textContent = parsed.security ? String(parsed.security).toUpperCase() : '—';

      badgeOk.style.display = parsed.ok ? 'inline-flex' : 'none';
      badgeBad.style.display = parsed.ok ? 'none' : 'inline-flex';

      // errors / warnings
      if (parsed.errors && parsed.errors.length) {
        err.style.display = 'block';
        err.innerHTML = '❌ ' + parsed.errors.map(escapeHtml).join('<br>');
      } else {
        err.style.display = 'none';
        err.textContent = '';
      }

      if (parsed.warnings && parsed.warnings.length) {
        warn.style.display = 'block';
        warn.innerHTML = '⚠️ ' + parsed.warnings.map(escapeHtml).join('<br>');
      } else {
        warn.style.display = 'none';
        warn.textContent = '';
      }

      // KV preview
      const rows = [];
      const fields = parsed.fields || {};
      for (const k of Object.keys(fields)) {
        const v = fields[k];
        if (v === undefined || v === null || String(v).trim() === '') continue;
        rows.push(
          `<div class="outbounds-kv-row"><div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(v)}</div></div>`
        );
      }
      kv.innerHTML = rows.join('');
    }

    function validateAndUpdateUI() {
      const input = $('outbounds-url');
      const saveBtn = $('outbounds-save-btn');
      if (!input) return;

      const url = String(input.value || '').trim();
      if (!url) {
        if (saveBtn) saveBtn.disabled = false;
        input.classList.remove('xk-invalid');
        renderParsePreview({ ok: false, scheme: '', fields: {}, errors: [], warnings: [] });
        try { syncDirtyState(); } catch (e) {}
        return;
      }

      const parsed = parseProxyUrl(url);

      renderParsePreview(parsed);

      if (parsed.ok) {
        input.classList.remove('xk-invalid');
        if (saveBtn) saveBtn.disabled = false;
      } else {
        input.classList.add('xk-invalid');
        if (saveBtn) saveBtn.disabled = true;
      }
      try { syncDirtyState(); } catch (e) {}
    }

    function setSelectValue(el, value) {
      if (!el) return;
      const opts = Array.from(el.options || []);
      const exists = opts.some(o => String(o.value) === String(value));
      if (exists) el.value = value;
    }

    function setHintsEnabled(scheme) {
      const typeSel = $('outbounds-type');
      const secSel = $('outbounds-security');
      // Для vmess/ss мы не переписываем URL, но подсказки оставляем как readonly.
      const readonly = (scheme === 'vmess' || scheme === 'ss' || scheme === 'hy2' || scheme === 'hysteria2' || scheme === 'hysteria' || scheme === '');
      if (typeSel) typeSel.disabled = readonly;
      if (secSel) secSel.disabled = readonly;
    }

    function updateHintsFromUrl(url) {
      const input = $('outbounds-url');
      const protoSel = $('outbounds-proto');
      const typeSel = $('outbounds-type');
      const secSel = $('outbounds-security');
      if (!input || !protoSel || !typeSel || !secSel) return;

      const s = String(url || '').trim();
      if (!s) {
        setSelectValue(protoSel, 'auto');
        setSelectValue(typeSel, 'auto');
        setSelectValue(secSel, 'auto');
        setHintsEnabled('');
        return;
      }

      const scheme = detectScheme(s);
      setHintsEnabled(scheme);

      if (protoSel && protoSel.value === 'auto') {
        if (['vless', 'trojan', 'vmess', 'ss', 'hy2', 'hysteria2', 'hysteria'].includes(scheme)) {
          // для удобства приводим hysteria2/hysteria к hy2
          const v = (scheme === 'hysteria2' || scheme === 'hysteria') ? 'hy2' : scheme;
          setSelectValue(protoSel, v);
        }
      }

      if (scheme === 'vless' || scheme === 'trojan') {
        try {
          const u = new URL(s);
          const type = (u.searchParams.get('type') || u.searchParams.get('net') || 'tcp').toLowerCase();
          const security = (u.searchParams.get('security') || (scheme === 'vless' ? 'reality' : 'tls')).toLowerCase();
          if (typeSel.value === 'auto') setSelectValue(typeSel, type);
          if (secSel.value === 'auto') setSelectValue(secSel, security);
          return;
        } catch (e) {}
      }

      if (scheme === 'vmess') {
        try {
          const raw = safeB64Decode(s.slice(8));
          const data = JSON.parse(raw || '{}');
          const type = (data.net || 'tcp').toLowerCase();
          const security = (data.tls === 'tls') ? 'tls' : ((data.security || 'none') + '').toLowerCase();
          if (typeSel.value === 'auto') setSelectValue(typeSel, type);
          if (secSel.value === 'auto') setSelectValue(secSel, security);
        } catch (e) {}
      }
    }

    function applyHintsToUrl() {
      const input = $('outbounds-url');
      const typeSel = $('outbounds-type');
      const secSel = $('outbounds-security');
      if (!input || !typeSel || !secSel) return;

      const url = String(input.value || '').trim();
      const scheme = detectScheme(url);
      if (!url || !(scheme === 'vless' || scheme === 'trojan')) return;

      try {
        const u = new URL(url);
        const typeVal = String(typeSel.value || 'auto').toLowerCase();
        const secVal = String(secSel.value || 'auto').toLowerCase();

        if (typeVal !== 'auto') {
          if (typeVal === 'tcp') u.searchParams.delete('type');
          else u.searchParams.set('type', typeVal);
        }

        if (secVal !== 'auto') {
          if (secVal === 'none') u.searchParams.delete('security');
          else u.searchParams.set('security', secVal);
        }

        const t = (u.searchParams.get('type') || 'tcp').toLowerCase();
        if (t === 'ws' && !u.searchParams.get('path')) u.searchParams.set('path', '/');
        if (t === 'httpupgrade' && !u.searchParams.get('path')) u.searchParams.set('path', '/');

        input.value = u.toString();
      } catch (e) {}
    }

    // ---------- Normalization helpers (make the pasted link neat + add safe defaults) ----------

    function reorderSearchParams(u, preferredKeys) {
      try {
        const cur = u.searchParams;
        const all = [];
        for (const [k, v] of cur.entries()) all.push([k, v]);

        const taken = new Set();
        const next = new URLSearchParams();

        // 1) preferred keys in order
        for (const k of (preferredKeys || [])) {
          for (const [kk, vv] of all) {
            if (kk === k && !taken.has(kk + '\u0000' + vv)) {
              next.append(kk, vv);
              taken.add(kk + '\u0000' + vv);
            }
          }
        }

        // 2) remaining keys alphabetically
        const rest = all.filter(([kk, vv]) => !taken.has(kk + '\u0000' + vv));
        rest.sort((a, b) => (a[0] === b[0] ? (a[1] > b[1] ? 1 : -1) : (a[0] > b[0] ? 1 : -1)));
        for (const [kk, vv] of rest) next.append(kk, vv);

        u.search = next.toString();
      } catch (e) {}
    }

    function normalizePath(p) {
      let v = String(p || '').trim();
      if (!v) return '/';
      if (!v.startsWith('/')) v = '/' + v;
      return v;
    }

    function normalizeVlessTrojan(url, scheme, typeHint, secHint) {
      let u;
      try {
        u = new URL(String(url || '').trim());
      } catch (e) {
        return '';
      }

      // Port default
      if (!u.port) u.port = '443';

      // Type/security
      const typeRaw = (u.searchParams.get('type') || u.searchParams.get('net') || typeHint || 'tcp').toLowerCase();
      const secRaw = (u.searchParams.get('security') || secHint || (scheme === 'trojan' ? 'tls' : 'reality')).toLowerCase();
      const type = (!typeRaw || typeRaw === 'auto') ? 'tcp' : typeRaw;
      const security = (!secRaw || secRaw === 'auto') ? (scheme === 'trojan' ? 'tls' : 'reality') : secRaw;

      // Prefer canonical keys
      if (!u.searchParams.get('pbk') && u.searchParams.get('publicKey')) u.searchParams.set('pbk', u.searchParams.get('publicKey') || '');
      if (!u.searchParams.get('sid') && u.searchParams.get('shortId')) u.searchParams.set('sid', u.searchParams.get('shortId') || '');
      if (!u.searchParams.get('sni') && u.searchParams.get('serverName')) u.searchParams.set('sni', u.searchParams.get('serverName') || '');

      u.searchParams.delete('publicKey');
      u.searchParams.delete('shortId');
      u.searchParams.delete('serverName');
      u.searchParams.delete('net');

      // Write type/security
      if (type === 'tcp') u.searchParams.delete('type');
      else u.searchParams.set('type', type);

      if (security === 'none') u.searchParams.delete('security');
      else u.searchParams.set('security', security);

      // Safe defaults for paths
      if (type === 'ws' || type === 'httpupgrade') {
        u.searchParams.set('path', normalizePath(u.searchParams.get('path')));
      }

      // Remove empty params
      for (const k of Array.from(u.searchParams.keys())) {
        const v = u.searchParams.get(k);
        if (v === null || v === undefined || String(v).trim() === '') u.searchParams.delete(k);
      }

      // Normalize fragment encoding
      if (u.hash) {
        let tag = u.hash.replace(/^#/, '');
        try { tag = decodeURIComponent(tag); } catch (e) {}
        u.hash = tag ? '#' + encodeURIComponent(tag) : '';
      }

      reorderSearchParams(u, [
        'type', 'security',
        'encryption', 'flow',
        'sni', 'fp', 'alpn',
        'pbk', 'sid', 'spx', 'pqv',
        'path', 'host',
        'serviceName', 'authority', 'mode',
        'allowInsecure', 'insecure'
      ]);

      return u.toString();
    }

    function normalizeVMess(url, typeHint, secHint) {
      const s = String(url || '').trim();
      if (!s.toLowerCase().startsWith('vmess://')) return '';
      const payload = s.slice(8);
      const decoded = safeB64Decode(payload);
      if (!decoded) return '';

      let data;
      try { data = JSON.parse(decoded); } catch (e) { return ''; }

      // Defaults
      if (!data.v) data.v = '2';
      if (data.aid === undefined || data.aid === null || data.aid === '') data.aid = '0';

      const net = String(data.net || typeHint || 'tcp').toLowerCase();
      data.net = net || 'tcp';

      // Security normalization: prefer tls key
      const sec = String((data.tls || data.security || secHint || '')).toLowerCase();
      if (sec === 'tls') {
        data.tls = 'tls';
        data.sni = data.sni || data.host || '';
      } else {
        // Keep tls empty if not used
        if (data.tls) data.tls = '';
      }

      // Port default (keep as string for compatibility)
      if (!data.port) data.port = '443';

      // WS default path
      if (data.net === 'ws') {
        data.path = normalizePath(data.path || '/');
      }
      if (data.net === 'httpupgrade') {
        data.path = normalizePath(data.path || '/');
      }

      // Remove empty keys (but keep required ones)
      const keep = new Set(['v', 'ps', 'add', 'port', 'id', 'aid', 'net', 'type', 'host', 'path', 'tls', 'sni', 'alpn', 'fp', 'scy']);
      for (const k of Object.keys(data)) {
        if (!keep.has(k)) continue;
        const v = data[k];
        if (v === null || v === undefined || String(v).trim() === '') {
          // Do not delete required keys
          if (['v', 'add', 'port', 'id', 'net'].includes(k)) continue;
          delete data[k];
        }
      }

      const json = JSON.stringify(data);
      const b64 = safeB64Encode(json);
      if (!b64) return '';
      return 'vmess://' + b64;
    }

    function normalizeSS(url) {
      let u;
      try { u = new URL(String(url || '').trim()); } catch (e) { return ''; }
      if (u.protocol.toLowerCase() !== 'ss:') return '';

      // Extract method/password
      let method = '';
      let password = '';
      if (u.username && u.password) {
        method = u.username;
        password = u.password;
      } else if (u.username && !u.password) {
        const decoded = safeB64Decode(u.username);
        if (decoded && decoded.includes(':')) {
          const idx = decoded.indexOf(':');
          method = decoded.slice(0, idx);
          password = decoded.slice(idx + 1);
        }
      }

      const host = u.hostname;
      const port = u.port || '';
      if (!host || !port) return '';

      const creds = safeB64Encode(String(method || '') + ':' + String(password || ''));
      if (!creds) return '';

      // Preserve plugin if present
      const plugin = (() => {
        try {
          const v = u.searchParams.get('plugin') || '';
          return v ? 'plugin=' + encodeURIComponent(v) : '';
        } catch (e) {
          return '';
        }
      })();

      let tag = '';
      if (u.hash) {
        tag = u.hash.replace(/^#/, '');
        try { tag = decodeURIComponent(tag); } catch (e) {}
      }

      const out = 'ss://' + creds + '@' + host + ':' + port + (plugin ? '?' + plugin : '') + (tag ? '#' + encodeURIComponent(tag) : '');
      return out;
    }

    function normalizeCurrentUrl() {
      const statusEl = $('outbounds-status');
      const input = $('outbounds-url');
      const typeSel = $('outbounds-type');
      const secSel = $('outbounds-security');
      if (!input) return;
      if (isOutboundsSummaryFragmentMode()) {
        if (statusEl) statusEl.textContent = 'Фрагмент со списком прокси нельзя нормализовать как одну ссылку. Откройте JSON-редактор, «Пул прокси» или «Подписки».';
        return;
      }

      const raw = String(input.value || '').trim();
      if (!raw) {
        if (statusEl) statusEl.textContent = 'Вставь ссылку, чтобы нормализовать.';
        try { if (typeof showToast === 'function') showToast('Ссылка пустая.', true); } catch (e) {}
        return;
      }

      const scheme = detectScheme(raw);
      const typeHint = typeSel ? String(typeSel.value || 'auto').toLowerCase() : 'auto';
      const secHint = secSel ? String(secSel.value || 'auto').toLowerCase() : 'auto';

      let normalized = '';
      if (scheme === 'vless' || scheme === 'trojan') normalized = normalizeVlessTrojan(raw, scheme, typeHint, secHint);
      else if (scheme === 'vmess') normalized = normalizeVMess(raw, typeHint, secHint);
      else if (scheme === 'ss') normalized = normalizeSS(raw);
      else if (scheme === 'hy2' || scheme === 'hysteria2' || scheme === 'hysteria') normalized = raw;

      if (!normalized) {
        const msg = 'Не удалось нормализовать ссылку (проверь формат).';
        if (statusEl) statusEl.textContent = msg;
        try { if (typeof showToast === 'function') showToast(msg, true); } catch (e) {}
        return;
      }

      input.value = normalized;
      try { updateHintsFromUrl(normalized); } catch (e) {}
      try { validateAndUpdateUI(); } catch (e) {}
      const msg = 'Ссылка нормализована.';
      if (statusEl) statusEl.textContent = msg;
      try { if (typeof showToast === 'function') showToast(msg, false); } catch (e) {}
    }

    function wireHints() {
      const input = $('outbounds-url');
      const protoSel = $('outbounds-proto');
      const typeSel = $('outbounds-type');
      const secSel = $('outbounds-security');
      if (!input || !protoSel || !typeSel || !secSel) return;

      if (input.dataset && input.dataset.xkeenHintsWired === '1') return;

      input.addEventListener('input', () => {
        try { updateHintsFromUrl(input.value); } catch (e) {}
        try { validateAndUpdateUI(); } catch (e) {}
      });

      protoSel.addEventListener('change', () => {
        try {
          const cur = String(input.value || '').trim();
          const v = String(protoSel.value || 'auto');
          if (!cur && v !== 'auto') input.value = v + '://';
          updateHintsFromUrl(input.value);
          validateAndUpdateUI();
        } catch (e) {}
      });

      const onPick = () => {
        try { applyHintsToUrl(); } catch (e) {}
        try { validateAndUpdateUI(); } catch (e) {}
      };

      typeSel.addEventListener('change', onPick);
      secSel.addEventListener('change', onPick);

      if (input.dataset) input.dataset.xkeenHintsWired = '1';
    }


    // ---------- URL hint helpers (protocol/type/security) ----------

    function setCollapsedFromStorage() {
      const body = $('outbounds-body');
      const arrow = $('outbounds-arrow');
      if (!body || !arrow) return;

      let open = false;
      try {
        if (window.localStorage) {
          const stored = localStorage.getItem('xkeen_outbounds_open');
          if (stored === '1') open = true;
          else if (stored === '0') open = false;
        }
      } catch (e) {
        // ignore
      }

      body.style.display = open ? 'block' : 'none';
      arrow.textContent = open ? '▲' : '▼';
    }

    function toggleCard() {
      const body = $('outbounds-body');
      const arrow = $('outbounds-arrow');
      if (!body || !arrow) return;

      const willOpen = body.style.display === 'none';
      body.style.display = willOpen ? 'block' : 'none';
      if (willOpen) scheduleOutboundsNodeListLayout();
      arrow.textContent = willOpen ? '▲' : '▼';

      try {
        if (window.localStorage) {
          localStorage.setItem('xkeen_outbounds_open', willOpen ? '1' : '0');
        }
      } catch (e) {
        // ignore
      }
    }

    async function load() {
      const statusEl = $('outbounds-status');
      const input = $('outbounds-url');
      if (!input) return;

      publishLifecycleState({ loading: true, initialized: false }, 'outbounds-load-start');
      try {
        const file = getActiveFragment();
        const url = file ? ('/api/outbounds?file=' + encodeURIComponent(file)) : '/api/outbounds';
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) {
          if (statusEl) statusEl.textContent = 'Не удалось загрузить outbounds.';
          return;
        }
        const data = await res.json().catch(() => ({}));
        const fileName = baseName((data && data.file) || file || '');
        const summary = summarizeOutboundsConfig(data && data.config);
        const isSubscriptionFragment = await isSubscriptionOutputFragment(fileName);

        if (isSubscriptionFragment) {
          _savedUrl = '';
          setSubscriptionFragmentMode(true, fileName, summary);
          try { await refreshOutboundsNodes(false); } catch (e) {}
          try { syncDirtyState(false); } catch (e) {}
          publishLifecycleState({
            savedValue: '',
            currentValue: '',
            initialized: true,
          }, 'outbounds-load-subscription-fragment');
          if (statusEl) {
            statusEl.textContent = `Подписочный фрагмент загружен: ${summary.proxies.length} прокси. Для правок используйте «Подписки» или JSON-редактор.`;
          }
          try {
            if (typeof updateLastActivity === 'function') {
              const fp = getXkeenFilePath('outbounds', '');
              updateLastActivity('loaded', 'outbounds', fp);
            }
          } catch (e) {}
          return;
        }

        if (shouldUsePoolFragmentSummary(data, summary)) {
          _savedUrl = '';
          setPoolFragmentMode(true, fileName, summary);
          try { await refreshOutboundsNodes(true); } catch (e) {}
          try { syncDirtyState(false); } catch (e) {}
          publishLifecycleState({
            savedValue: '',
            currentValue: '',
            initialized: true,
          }, 'outbounds-load-pool-fragment');
          if (statusEl) {
            statusEl.textContent = `Пул прокси загружен: ${summary.proxies.length} прокси. Для правок используйте «Пул прокси» или JSON-редактор.`;
          }
          try {
            if (typeof updateLastActivity === 'function') {
              const fp = getXkeenFilePath('outbounds', '');
              updateLastActivity('loaded', 'outbounds', fp);
            }
          } catch (e) {}
          return;
        }

        setSubscriptionFragmentMode(false, fileName, summary);
        if (data && data.url) {
          _savedUrl = String(data.url || '');
          input.value = _savedUrl;
          updateHintsFromUrl(_savedUrl);
          validateAndUpdateUI();
          try { await refreshOutboundsNodes(true); } catch (e) {}
          publishLifecycleState({
            savedValue: String(_savedUrl || ''),
            currentValue: String(getCurrentUrl() || _savedUrl || ''),
            initialized: true,
          }, 'outbounds-load-success');
          if (statusEl) statusEl.textContent = 'Текущая ссылка загружена.';
          try {
            if (typeof updateLastActivity === 'function') {
              const fp = getXkeenFilePath('outbounds', '');
              updateLastActivity('loaded', 'outbounds', fp);
            }
          } catch (e) {}
        } else {
          _savedUrl = '';
          input.value = '';
          try { await refreshOutboundsNodes(false); } catch (e) {}
          if (statusEl) statusEl.textContent = 'Файл outbounds отсутствует или не содержит прокси-конфиг.';
          updateHintsFromUrl('');
          validateAndUpdateUI();
          publishLifecycleState({
            savedValue: '',
            currentValue: String(getCurrentUrl() || ''),
            initialized: true,
          }, 'outbounds-load-empty');
          try {
            if (typeof updateLastActivity === 'function') {
              const fp = getXkeenFilePath('outbounds', '');
              updateLastActivity('loaded', 'outbounds', fp);
            }
          } catch (e) {}
        }
      } catch (e) {
        console.error(e);
        if (statusEl) statusEl.textContent = 'Ошибка загрузки outbounds.';
      } finally {
        publishLifecycleState({ loading: false, initialized: true }, 'outbounds-load-finished');
      }
    }

    async function save() {
      const statusEl = $('outbounds-status');
      const input = $('outbounds-url');
      if (!input) return;
      if (isOutboundsSummaryFragmentMode()) {
        if (statusEl) statusEl.textContent = 'Фрагмент со списком прокси не сохраняется через single-link форму. Используйте «Пул прокси», «Подписки» или JSON-редактор.';
        return;
      }

      publishLifecycleState({ saving: true, initialized: true }, 'outbounds-save-start');
      let streamedRestart = false;
      try {
        const url = String(input.value || '').trim();
        if (!url) {
          if (statusEl) statusEl.textContent = 'Введи ссылку прокси (vless / trojan / vmess / ss).';
          return;
        }

        // Client-side validation guard
        try {
          const parsed = parseProxyUrl(url);
          renderParsePreview(parsed);
          if (!parsed.ok) {
            if (statusEl) statusEl.textContent = 'Ссылка содержит ошибки — исправь и попробуй снова.';
            input.classList.add('xk-invalid');
            return;
          }
        } catch (e) {}

        try {
          const file = getActiveFragment();
          const restart = shouldRestartAfterSave();
          const params = new URLSearchParams();
          if (file) params.set('file', file);
          if (restart) params.set('async', '1');
          const apiUrl = '/api/outbounds' + (params.toString() ? ('?' + params.toString()) : '');
          const res = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, restart }),
          });
          const data = await res.json().catch(() => ({}));

          if (res.ok && data && data.ok) {
            let msg = 'Outbounds сохранены.';
            if (statusEl) statusEl.textContent = msg;
            _savedUrl = url;
            try { syncDirtyState(false); } catch (e) {}
            publishLifecycleState({
              savedValue: String(_savedUrl || ''),
              currentValue: String(getCurrentUrl() || _savedUrl || ''),
            }, 'outbounds-save-success');
            try {
              if (typeof updateLastActivity === 'function') {
                const fp = getXkeenFilePath('outbounds', '');
                updateLastActivity('saved', 'outbounds', fp);
              }
            } catch (e) {}

            const jobId = (data && (data.restart_job_id || data.job_id || data.restartJobId))
              ? String(data.restart_job_id || data.job_id || data.restartJobId)
              : '';

            if (restart && jobId) {
              streamedRestart = true;
              if (statusEl) statusEl.textContent = 'Outbounds сохранены. Перезапуск xkeen...';
              const result = await streamRestartJob(jobId, 'xkeen -restart (job)...\n');
              const ok = !!(result && result.ok);
              if (ok) {
                msg = 'Outbounds сохранены и xkeen перезапущен.';
                if (statusEl) statusEl.textContent = msg;
                try { toastXkeen(msg, 'success'); } catch (e) {}
              } else {
                const err = (result && (result.error || result.message)) ? String(result.error || result.message) : '';
                const exitCode = (result && typeof result.exit_code === 'number') ? result.exit_code : null;
                const detail = err
                  ? ('Ошибка: ' + err)
                  : (exitCode !== null ? ('Ошибка (exit_code=' + exitCode + ')') : '');
                const restartLog = getRestartLogApi();
                if (detail && restartLog && typeof restartLog.append === 'function') {
                  try { restartLog.append('\n' + detail + '\n'); } catch (e) {}
                }
                msg = 'Outbounds сохранены, но перезапуск xkeen завершился с ошибкой.';
                if (statusEl) statusEl.textContent = msg;
                try { toastXkeen(msg, 'error'); } catch (e2) {}
              }
            } else {
              try { if (!data || !data.restarted) { if (typeof showToast === 'function') showToast(msg, false); } } catch (e) {}
            }
          } else {
            const msg = 'Save error: ' + ((data && data.error) || res.status);
            if (statusEl) statusEl.textContent = msg;
            try { if (typeof showToast === 'function') showToast(msg, true); } catch (e) {}
          }
        } catch (e) {
          console.error(e);
          const msg = 'Failed to save outbounds.';
          if (statusEl) statusEl.textContent = msg;
          try { if (typeof showToast === 'function') showToast(msg, true); } catch (e2) {}
        } finally {
          if (!streamedRestart) {
            try { refreshRestartLog(); } catch (e) {}
          }
        }
      } finally {
        publishLifecycleState({ saving: false, initialized: true }, 'outbounds-save-finished');
      }
    }

    async function backup() {
      const statusEl = $('outbounds-status');
      const backupsStatusEl = $('backups-status');

      function _baseName(p, fallback) {
        try {
          if (!p) return fallback;
          const parts = String(p).split(/\//);
          const b = parts[parts.length - 1];
          return b || fallback;
        } catch (e) {
          return fallback;
        }
      }

      const fileLabel = _baseName(getXkeenFilePath('outbounds', ''), '04_outbounds.json');

      try {
        const file = getActiveFragment();
        const url = file ? ('/api/backup-outbounds?file=' + encodeURIComponent(file)) : '/api/backup-outbounds';
        const res = await fetch(url, { method: 'POST' });
        const data = await res.json().catch(() => ({}));

        if (res.ok && data && data.ok) {
          const msg = 'Бэкап ' + fileLabel + ' создан: ' + (data.filename || '');
          if (statusEl) statusEl.textContent = msg;
          if (backupsStatusEl) backupsStatusEl.textContent = '';
          try { if (typeof showToast === 'function') showToast(msg, false); } catch (e) {}
          try {
            const backupsApi = getBackupsApi();
            if (backupsApi) {
              if (typeof backupsApi.refresh === 'function') await backupsApi.refresh();
              else if (typeof backupsApi.load === 'function') await backupsApi.load();
            }
          } catch (e) {}
        } else {
          const msg = 'Ошибка создания бэкапа ' + fileLabel + ': ' + ((data && data.error) || 'неизвестная ошибка');
          if (statusEl) statusEl.textContent = msg;
          try { if (typeof showToast === 'function') showToast(msg, true); } catch (e) {}
        }
      } catch (e) {
        console.error(e);
        const msg = 'Ошибка создания бэкапа ' + fileLabel + '.';
        if (statusEl) statusEl.textContent = msg;
        try { if (typeof showToast === 'function') showToast(msg, true); } catch (e2) {}
      }
    }


    // ---------- Mini generator modal (build proxy link from hints) ----------

    function safeDecodeURIComponent(s) {
      try { return decodeURIComponent(String(s || '')); } catch (e) { return String(s || ''); }
    }

    function setElValue(id, value) {
      const el = $(id);
      if (!el) return;
      try { el.value = (value === undefined || value === null) ? '' : String(value); } catch (e) {}
    }

    function setSelectIfExists(id, value) {
      const el = $(id);
      if (!el) return;
      const raw = (value === undefined || value === null) ? '' : String(value).trim();
      const v = raw.toLowerCase();
      try {
        // Only set if option exists. Empty value is allowed when select has an explicit blank option.
        const ok = Array.from(el.options || []).some(o => String(o.value || '').trim().toLowerCase() === v);
        if (ok) el.value = raw;
      } catch (e) {}
    }

    function parseSSRaw(url) {
      // Returns sensitive fields too (method/password) for generator prefill.
      const out = { ok: false, host: '', port: '', method: '', password: '', plugin: '', tag: '' };
      let s = String(url || '').trim();
      if (!s.toLowerCase().startsWith('ss://')) return out;

      // Tag
      const hashIdx = s.indexOf('#');
      if (hashIdx >= 0) {
        out.tag = safeDecodeURIComponent(s.slice(hashIdx + 1));
        s = s.slice(0, hashIdx);
      }

      // Query/plugin
      const qIdx = s.indexOf('?');
      if (qIdx >= 0) {
        const query = s.slice(qIdx + 1);
        s = s.slice(0, qIdx);
        try {
          const qs = new URLSearchParams(query);
          out.plugin = qs.get('plugin') || '';
        } catch (e) {}
      }

      let rest = s.slice(5); // after ss://
      if (!rest) return out;

      // userinfo@host:port
      let userinfo = '';
      let hostport = '';

      if (rest.includes('@')) {
        const parts = rest.split('@');
        userinfo = parts[0] || '';
        hostport = parts.slice(1).join('@');
      } else {
        const decoded = safeB64Decode(rest);
        if (decoded && decoded.includes('@')) {
          const parts = decoded.split('@');
          userinfo = parts[0] || '';
          hostport = parts.slice(1).join('@');
        } else {
          // Some variants encode only creds in base64 without @ in outer form
          hostport = rest;
        }
      }

      // Decode userinfo to method:pass
      let creds = String(userinfo || '').trim();
      if (creds && !creds.includes(':')) {
        const dec = safeB64Decode(creds);
        if (dec && dec.includes(':')) creds = dec;
      }
      if (creds.includes(':')) {
        const idx = creds.indexOf(':');
        out.method = creds.slice(0, idx);
        out.password = creds.slice(idx + 1);
      }

      // Host/port
      const hp = String(hostport || '').trim();
      if (hp.startsWith('[')) {
        const m = hp.match(/^\[([^\]]+)\]:(\d+)$/);
        if (m) {
          out.host = m[1];
          out.port = m[2];
        }
      } else {
        const idx = hp.lastIndexOf(':');
        if (idx > 0) {
          out.host = hp.slice(0, idx);
          out.port = hp.slice(idx + 1);
        }
      }

      out.ok = !!(out.host && out.port && out.method && out.password && isValidPort(out.port));
      return out;
    }

    function prefillGeneratorFromUrl(url) {
      const s = String(url || '').trim();
      if (!s) return false;
      const schemeRaw = detectScheme(s);
      if (!['vless', 'trojan', 'vmess', 'ss', 'hy2', 'hysteria2', 'hysteria'].includes(schemeRaw)) return false;
      // normalize hysteria/hysteria2 to hy2
      const scheme = (schemeRaw === 'hysteria2' || schemeRaw === 'hysteria') ? 'hy2' : schemeRaw;

      // Reset basic fields (do not clear preview/status here)
      setElValue('outbounds-gen-host', '');
      setElValue('outbounds-gen-port', '443');
      setElValue('outbounds-gen-tag', '');

      // Reset creds
      setElValue('outbounds-gen-uuid', '');
      setElValue('outbounds-gen-pass', '');
      setElValue('outbounds-gen-vmess-uuid', '');
      // HY2
      setElValue('outbounds-gen-hy2-auth', '');
      // SS
      setElValue('outbounds-gen-ss-pass', '');
      setElValue('outbounds-gen-ss-plugin', '');

      // Reset advanced
      ['outbounds-gen-sni','outbounds-gen-fp','outbounds-gen-alpn','outbounds-gen-path','outbounds-gen-hosthdr',
       'outbounds-gen-service','outbounds-gen-authority','outbounds-gen-pbk','outbounds-gen-sid','outbounds-gen-spx',
       'outbounds-gen-hy2-obfspwd','outbounds-gen-hy2-pinsha256'].forEach((id) => setElValue(id, ''));
      setElValue('outbounds-gen-spx', '/');
      setSelectIfExists('outbounds-gen-flow', '');
      setSelectIfExists('outbounds-gen-grpc-mode', '');
      setSelectIfExists('outbounds-gen-allowinsecure', '0');
      setSelectIfExists('outbounds-gen-hy2-insecure', '0');
      setSelectIfExists('outbounds-gen-hy2-obfs', '');

      // defaults
      setSelectIfExists('outbounds-gen-proto', scheme);

      // Close advanced by default, open it only when we found advanced params
      try {
        const adv = $('outbounds-gen-advanced');
        if (adv) adv.open = false;
      } catch (e) {}

      let filledAnyAdvanced = false;

      if (scheme === 'vless' || scheme === 'trojan') {
        let u;
        try { u = new URL(s); } catch (e) { return false; }

        const host = (u.hostname || '').toString();
        const port = (u.port || '').toString() || '443';
        const user = (u.username || '').toString();
        const tag = safeDecodeURIComponent((u.hash || '').replace(/^#/, ''));

        const type = (u.searchParams.get('type') || u.searchParams.get('net') || 'tcp').toLowerCase();
        const secRaw = (u.searchParams.get('security') || '').toLowerCase();
        const security = secRaw || (scheme === 'trojan' ? 'tls' : 'reality');

        setElValue('outbounds-gen-host', host);
        setElValue('outbounds-gen-port', port);
        setElValue('outbounds-gen-tag', tag);
        setSelectIfExists('outbounds-gen-type', type);
        setSelectIfExists('outbounds-gen-security', security);

        if (scheme === 'vless') setElValue('outbounds-gen-uuid', user);
        else setElValue('outbounds-gen-pass', user);

        const sni = (u.searchParams.get('sni') || u.searchParams.get('serverName') || '').toString();
        const fp = (u.searchParams.get('fp') || '').toString();
        const alpn = (u.searchParams.get('alpn') || '').toString();
        const flow = (u.searchParams.get('flow') || '').toString();
        const allowInsecure = (u.searchParams.get('allowInsecure') || '').toString();

        const pbk = (u.searchParams.get('pbk') || u.searchParams.get('publicKey') || '').toString();
        const sid = (u.searchParams.get('sid') || u.searchParams.get('shortId') || '').toString();
        const spx = (u.searchParams.get('spx') || '').toString();

        const path = (u.searchParams.get('path') || '').toString();
        const hostHdr = (u.searchParams.get('host') || '').toString();
        const serviceName = (u.searchParams.get('serviceName') || '').toString();
        const authority = (u.searchParams.get('authority') || '').toString();
        const mode = (u.searchParams.get('mode') || '').toString();

        if (sni) { setElValue('outbounds-gen-sni', sni); filledAnyAdvanced = true; }
        if (fp) { setElValue('outbounds-gen-fp', fp); filledAnyAdvanced = true; }
        if (alpn) { setElValue('outbounds-gen-alpn', alpn); filledAnyAdvanced = true; }
        if (flow && scheme === 'vless') { setSelectIfExists('outbounds-gen-flow', flow); filledAnyAdvanced = true; }
        if (allowInsecure === '1' || allowInsecure.toLowerCase() === 'true') { setSelectIfExists('outbounds-gen-allowinsecure', '1'); filledAnyAdvanced = true; }

        if (path) { setElValue('outbounds-gen-path', path); filledAnyAdvanced = true; }
        if (hostHdr) { setElValue('outbounds-gen-hosthdr', hostHdr); filledAnyAdvanced = true; }
        if (serviceName) { setElValue('outbounds-gen-service', serviceName); filledAnyAdvanced = true; }
        if (authority) { setElValue('outbounds-gen-authority', authority); filledAnyAdvanced = true; }
        if (mode) { setSelectIfExists('outbounds-gen-grpc-mode', mode); filledAnyAdvanced = true; }

        if (pbk) { setElValue('outbounds-gen-pbk', pbk); filledAnyAdvanced = true; }
        if (sid) { setElValue('outbounds-gen-sid', sid); filledAnyAdvanced = true; }
        if (spx) { setElValue('outbounds-gen-spx', spx); filledAnyAdvanced = true; }

        try {
          const adv = $('outbounds-gen-advanced');
          if (adv) adv.open = !!filledAnyAdvanced;
        } catch (e) {}

        return true;
      }

      if (scheme === 'vmess') {
        const payload = s.slice(8);
        const decoded = safeB64Decode(payload);
        if (!decoded) return false;
        let data = null;
        try { data = JSON.parse(decoded); } catch (e) { return false; }

        const host = (data.add || '').toString();
        const port = (data.port || '').toString() || '443';
        const uuid = (data.id || '').toString();
        const tag = (data.ps || '').toString();
        const net = (data.net || 'tcp').toString().toLowerCase();
        const tls = (data.tls || '').toString().toLowerCase();

        setElValue('outbounds-gen-host', host);
        setElValue('outbounds-gen-port', port);
        setElValue('outbounds-gen-tag', tag);
        setElValue('outbounds-gen-vmess-uuid', uuid);

        setSelectIfExists('outbounds-gen-type', net);
        setSelectIfExists('outbounds-gen-security', (tls === 'tls') ? 'tls' : 'none');

        // Advanced
        if (data.sni) { setElValue('outbounds-gen-sni', data.sni); filledAnyAdvanced = true; }
        if (data.fp) { setElValue('outbounds-gen-fp', data.fp); filledAnyAdvanced = true; }
        if (data.alpn) { setElValue('outbounds-gen-alpn', data.alpn); filledAnyAdvanced = true; }
        if (data.allowInsecure) { setSelectIfExists('outbounds-gen-allowinsecure', '1'); filledAnyAdvanced = true; }

        if (net === 'ws' || net === 'httpupgrade') {
          if (data.path) { setElValue('outbounds-gen-path', data.path); filledAnyAdvanced = true; }
          if (data.host) { setElValue('outbounds-gen-hosthdr', data.host); filledAnyAdvanced = true; }
        }
        if (net === 'grpc') {
          if (data.path) { setElValue('outbounds-gen-service', data.path); filledAnyAdvanced = true; }
          if (data.host) { setElValue('outbounds-gen-authority', data.host); filledAnyAdvanced = true; }
        }

        try {
          const adv = $('outbounds-gen-advanced');
          if (adv) adv.open = !!filledAnyAdvanced;
        } catch (e) {}

        return true;
      }

      if (scheme === 'ss') {
        const ss = parseSSRaw(s);
        if (!ss.ok && !(ss.host && ss.port)) {
          return false;
        }
        setElValue('outbounds-gen-host', ss.host);
        setElValue('outbounds-gen-port', ss.port || '8388');
        setElValue('outbounds-gen-tag', ss.tag);

        if (ss.method) setSelectIfExists('outbounds-gen-ss-method', ss.method);
        setElValue('outbounds-gen-ss-pass', ss.password);
        setElValue('outbounds-gen-ss-plugin', ss.plugin);

        // Force selects
        setSelectIfExists('outbounds-gen-type', 'tcp');
        setSelectIfExists('outbounds-gen-security', 'none');

        try {
          const adv = $('outbounds-gen-advanced');
          if (adv) adv.open = !!(ss.plugin);
        } catch (e) {}
        try {
          if (filledAnyAdvanced) {
            const adv = $('outbounds-gen-advanced');
            if (adv) adv.open = true;
          }
        } catch (e) {}
        return true;
      }

      if (scheme === 'hy2') {
        let u;
        try { u = new URL(s); } catch (e) { return false; }

        const host = (u.hostname || '').toString();
        const port = (u.port || '').toString() || '443';
        const tag = safeDecodeURIComponent((u.hash || '').replace(/^#/, ''));

        const user = (u.username || '').toString();
        const pass = (u.password || '').toString();
        const auth = (user || pass) ? (user + (pass ? (':' + pass) : '')) : '';

        setElValue('outbounds-gen-host', host);
        setElValue('outbounds-gen-port', port);
        setElValue('outbounds-gen-tag', tag);
        setElValue('outbounds-gen-hy2-auth', auth);

        // HY2 does not use these in our generator, keep them neutral
        setSelectIfExists('outbounds-gen-type', 'auto');
        setSelectIfExists('outbounds-gen-security', 'auto');

        const sni = (u.searchParams.get('sni') || '').toString();
        const insecure = (u.searchParams.get('insecure') || u.searchParams.get('allowInsecure') || '').toString();
        const obfs = (u.searchParams.get('obfs') || '').toString();
        const obfsPwd = (u.searchParams.get('obfs-password') || u.searchParams.get('obfs_password') || '').toString();
        const pin = (u.searchParams.get('pinSHA256') || '').toString();

        if (sni) { setElValue('outbounds-gen-sni', sni); filledAnyAdvanced = true; }
        if (insecure === '1' || insecure.toLowerCase() === 'true') { setSelectIfExists('outbounds-gen-hy2-insecure', '1'); filledAnyAdvanced = true; }
        if (obfs) { setSelectIfExists('outbounds-gen-hy2-obfs', obfs); filledAnyAdvanced = true; }
        if (obfsPwd) { setElValue('outbounds-gen-hy2-obfspwd', obfsPwd); filledAnyAdvanced = true; }
        if (pin) { setElValue('outbounds-gen-hy2-pinsha256', pin); filledAnyAdvanced = true; }

        try {
          const adv = $('outbounds-gen-advanced');
          if (adv) adv.open = !!filledAnyAdvanced;
        } catch (e) {}

        return true;
      }

      return false;
    }

    function showGeneratorModal(show) {
      const modal = $('outbounds-generator-modal');
      if (!modal) return;
      try {
        if (show) modal.classList.remove('hidden');
        else modal.classList.add('hidden');
      } catch (e) {}
      try { syncXkeenBodyScrollLock(!!show); } catch (e) {}
    }

    function getResolvedGenProto() {
      const genProto = ($('outbounds-gen-proto') && $('outbounds-gen-proto').value) || 'auto';
      const p = String(genProto || 'auto').trim().toLowerCase();
      if (p && p !== 'auto') return p;

      // If proto is auto: try detect from current input, otherwise default to vless.
      const input = $('outbounds-url');
      const scheme = input ? detectScheme(String(input.value || '').trim()) : '';
      if (scheme === 'vless' || scheme === 'trojan' || scheme === 'vmess' || scheme === 'ss') return scheme;
      if (scheme === 'hy2' || scheme === 'hysteria2' || scheme === 'hysteria') return 'hy2';
      return 'vless';
    }

    function defaultSecurityForProto(proto) {
      if (proto === 'hy2') return 'tls';
      if (proto === 'trojan') return 'tls';
      if (proto === 'vmess') return 'tls';
      if (proto === 'ss') return 'none';
      // vless
      return 'reality';
    }

    function resolveGenType() {
      const typeEl = $('outbounds-gen-type');
      let t = typeEl ? String(typeEl.value || 'auto').trim().toLowerCase() : 'auto';
      if (!t || t === 'auto') t = 'tcp';
      return t;
    }

    function resolveGenSecurity(proto) {
      const secEl = $('outbounds-gen-security');
      let s = secEl ? String(secEl.value || 'auto').trim().toLowerCase() : 'auto';
      if (!s || s === 'auto') s = defaultSecurityForProto(proto);

      // HY2 always uses TLS, ignore other values
      if (proto === 'hy2') return 'tls';

      // VMess does not support Reality in our backend parser (tlsSettings only)
      if (proto === 'vmess' && s === 'reality') s = 'tls';
      // Shadowsocks does not use this
      if (proto === 'ss') s = 'none';
      return s;
    }

    function updateGeneratorSummary() {
      const el = $('outbounds-gen-summary');
      if (!el) return;
      const proto = getResolvedGenProto();
      const type = (proto === 'hy2') ? 'HY2' : resolveGenType().toUpperCase();
      const sec = (proto === 'hy2') ? 'TLS' : resolveGenSecurity(proto);
      const protoLabelMap = { vless: 'VLESS', trojan: 'Trojan', vmess: 'VMess', ss: 'SS', hy2: 'HY2' };
      const secLabelMap = { none: 'None', tls: 'TLS', reality: 'Reality' };
      const protoLabel = protoLabelMap[proto] || String(proto || 'auto').toUpperCase();
      const secLabel = secLabelMap[String(sec || '').toLowerCase()] || String(sec || '').toUpperCase() || 'Auto';
      el.textContent = proto === 'hy2' ? `${protoLabel} · QUIC · ${secLabel}` : `${protoLabel} · ${type} · ${secLabel}`;
    }

    function markGeneratorDirty() {
      const previewEl = $('outbounds-gen-preview');
      const insertBtn = $('outbounds-gen-insert-btn');
      const statusEl = $('outbounds-gen-status');
      const modal = $('outbounds-generator-modal');
      if (!modal || modal.classList.contains('hidden')) return;
      updateGeneratorSummary();
      if (previewEl && String(previewEl.value || '').trim()) {
        previewEl.value = '';
        if (insertBtn) insertBtn.disabled = true;
        if (statusEl) statusEl.textContent = 'Изменены поля — нажмите «Собрать», чтобы обновить ссылку.';
      }
    }

    function updateGeneratorVisibility() {
      const proto = getResolvedGenProto();
      // HY2 does not use classic transport/security selectors here
      const type = (proto === 'hy2') ? 'hysteria' : resolveGenType();
      const sec = (proto === 'hy2') ? 'tls' : resolveGenSecurity(proto);

      const vlessCred = $('outbounds-gen-cred-vless');
      const trojanCred = $('outbounds-gen-cred-trojan');
      const vmessCred = $('outbounds-gen-cred-vmess');
      const ssCred = $('outbounds-gen-cred-ss');
      const ssPass = $('outbounds-gen-cred-ss-pass');
      const hy2Cred = $('outbounds-gen-cred-hy2');

      function show(el, on) {
        if (!el) return;
        el.style.display = on ? '' : 'none';
      }

      show(vlessCred, proto === 'vless');
      show(trojanCred, proto === 'trojan');
      show(vmessCred, proto === 'vmess');
      show(ssCred, proto === 'ss');
      show(ssPass, proto === 'ss');
      show(hy2Cred, proto === 'hy2');

      // Transport dependent fields
      const isWS = type === 'ws' || type === 'httpupgrade';
      const isGRPC = type === 'grpc';

      show($('outbounds-gen-field-path'), isWS);
      show($('outbounds-gen-field-hosthdr'), isWS);
      show($('outbounds-gen-field-grpc-service'), isGRPC);
      show($('outbounds-gen-field-grpc-authority'), isGRPC);
      show($('outbounds-gen-field-grpc-mode'), isGRPC);

      // Security dependent fields
      show($('outbounds-gen-field-sni'), proto !== 'ss' && sec !== 'none');
      // HY2 does not use fp/alpn/allowInsecure params
      show($('outbounds-gen-field-fp'), proto !== 'ss' && proto !== 'hy2' && sec !== 'none');
      show($('outbounds-gen-field-alpn'), proto !== 'ss' && proto !== 'hy2' && sec === 'tls');
      show($('outbounds-gen-field-allowinsecure'), proto !== 'ss' && proto !== 'hy2' && sec === 'tls');
      show($('outbounds-gen-field-reality-pbk'), proto !== 'ss' && sec === 'reality');
      show($('outbounds-gen-field-reality-sid'), proto !== 'ss' && sec === 'reality');
      show($('outbounds-gen-field-reality-spx'), proto !== 'ss' && sec === 'reality');

      // HY2 extra fields
      show($('outbounds-gen-field-hy2-insecure'), proto === 'hy2');
      show($('outbounds-gen-field-hy2-obfs'), proto === 'hy2');
      show($('outbounds-gen-field-hy2-obfspwd'), proto === 'hy2');
      show($('outbounds-gen-field-hy2-pinsha256'), proto === 'hy2');

      // VLESS only
      show($('outbounds-gen-field-flow'), proto === 'vless');

      // SS only
      show($('outbounds-gen-field-ss-plugin'), proto === 'ss');

      // Disable irrelevant selects for SS (keep visible, but no confusion)
      try {
        const secEl = $('outbounds-gen-security');
        const typeEl = $('outbounds-gen-type');
        if (secEl) secEl.disabled = (proto === 'ss' || proto === 'hy2');
        if (typeEl) typeEl.disabled = (proto === 'ss' || proto === 'hy2');
      } catch (e) {}

      // Small hint if VMess+Reality auto-converted
      try {
        const statusEl = $('outbounds-gen-status');
        if (statusEl && proto === 'vmess') {
          const rawSec = ($('outbounds-gen-security') && $('outbounds-gen-security').value) || 'auto';
          if (String(rawSec).toLowerCase() == 'reality') {
            statusEl.textContent = 'VMess не поддерживает Reality — будет использован TLS.';
          } else if (statusEl.textContent && statusEl.textContent.indexOf('VMess не поддерживает') === 0) {
            statusEl.textContent = '';
          }
        }
      } catch (e) {}
    }

    function buildLinkFromGenerator() {
      const proto = getResolvedGenProto();
      // HY2 does not use classic transport/security selectors here
      const type = (proto === 'hy2') ? 'hysteria' : resolveGenType();
      const sec = (proto === 'hy2') ? 'tls' : resolveGenSecurity(proto);

      const host = String(($('outbounds-gen-host') && $('outbounds-gen-host').value) || '').trim();
      const portStr = String(($('outbounds-gen-port') && $('outbounds-gen-port').value) || '').trim();
      const port = portStr ? parseInt(portStr, 10) : 443;
      const tag = String(($('outbounds-gen-tag') && $('outbounds-gen-tag').value) || '').trim();

      const sni = String(($('outbounds-gen-sni') && $('outbounds-gen-sni').value) || '').trim();
      const fp = String(($('outbounds-gen-fp') && $('outbounds-gen-fp').value) || '').trim() || 'chrome';
      const alpn = String(($('outbounds-gen-alpn') && $('outbounds-gen-alpn').value) || '').trim();
      const flow = String(($('outbounds-gen-flow') && $('outbounds-gen-flow').value) || '').trim();

      const path = String(($('outbounds-gen-path') && $('outbounds-gen-path').value) || '').trim();
      const hostHdr = String(($('outbounds-gen-hosthdr') && $('outbounds-gen-hosthdr').value) || '').trim();
      const serviceName = String(($('outbounds-gen-service') && $('outbounds-gen-service').value) || '').trim();
      const authority = String(($('outbounds-gen-authority') && $('outbounds-gen-authority').value) || '').trim();
      const grpcMode = String(($('outbounds-gen-grpc-mode') && $('outbounds-gen-grpc-mode').value) || '').trim();

      const pbk = String(($('outbounds-gen-pbk') && $('outbounds-gen-pbk').value) || '').trim();
      const sid = String(($('outbounds-gen-sid') && $('outbounds-gen-sid').value) || '').trim();
      const spx = String(($('outbounds-gen-spx') && $('outbounds-gen-spx').value) || '').trim() || '/';

      const allowInsecure = String(($('outbounds-gen-allowinsecure') && $('outbounds-gen-allowinsecure').value) || '0') === '1';

      const errors = [];
      const warnings = [];

      if (!host) errors.push('Не указан host');
      if (!port || !isValidPort(String(port))) errors.push('Некорректный port');

      if (proto === 'hy2') {
        const authRaw = String(($('outbounds-gen-hy2-auth') && $('outbounds-gen-hy2-auth').value) || '').trim();
        if (!authRaw) errors.push('Для HY2 нужен auth');

        // Split auth into username/password (optional)
        let hyUser = authRaw;
        let hyPass = '';
        const idx = authRaw.indexOf(':');
        if (idx >= 0) {
          hyUser = authRaw.slice(0, idx);
          hyPass = authRaw.slice(idx + 1);
        }

        const insecureVal = String(($('outbounds-gen-hy2-insecure') && $('outbounds-gen-hy2-insecure').value) || '0').trim();
        const obfs = String(($('outbounds-gen-hy2-obfs') && $('outbounds-gen-hy2-obfs').value) || '').trim();
        const obfsPwd = String(($('outbounds-gen-hy2-obfspwd') && $('outbounds-gen-hy2-obfspwd').value) || '').trim();
        const pin = String(($('outbounds-gen-hy2-pinsha256') && $('outbounds-gen-hy2-pinsha256').value) || '').trim();

        const params = new URLSearchParams();
        if (sni) params.set('sni', sni);
        if (insecureVal === '1') params.set('insecure', '1');
        if (obfs) params.set('obfs', obfs);
        if (obfsPwd && obfs) params.set('obfs-password', obfsPwd);
        if (obfsPwd && !obfs) warnings.push('HY2: указан obfs-password без obfs');
        if (pin) params.set('pinSHA256', pin);

        if (insecureVal === '1' && !pin) {
          warnings.push('HY2: insecure=1 снижает безопасность (лучше использовать pinSHA256)');
        }

        const userInfo = encodeURIComponent(hyUser) + (hyPass ? (':' + encodeURIComponent(hyPass)) : '');
        const q = params.toString();
        const hash = tag ? ('#' + encodeURIComponent(tag)) : '';
        const url = `hy2://${userInfo}@${host}:${port}${q ? ('?' + q) : ''}${hash}`;
        return { ok: errors.length === 0, url, errors, warnings };
      }

      if (proto === 'vless') {
        const uuid = String(($('outbounds-gen-uuid') && $('outbounds-gen-uuid').value) || '').trim();
        if (!uuid) errors.push('Для VLESS нужен UUID');
        else if (!looksLikeUuid(uuid)) warnings.push('UUID не похож на UUID (проверь)');

        if (sec === 'reality' && !pbk) errors.push('Reality: нужен pbk (publicKey)');

        const params = new URLSearchParams();
        params.set('type', type);
        params.set('security', sec);
        params.set('encryption', 'none');
        if (flow) params.set('flow', flow);

        if (sec !== 'none') {
          if (fp) params.set('fp', fp);
          if (sni) params.set('sni', sni);
        }
        if (sec === 'tls') {
          if (alpn) params.set('alpn', alpn);
          if (allowInsecure) params.set('allowInsecure', '1');
        }
        if (sec === 'reality') {
          if (fp) params.set('fp', fp);
          if (sni) params.set('sni', sni);
          if (pbk) params.set('pbk', pbk);
          if (sid) params.set('sid', sid);
          if (spx) params.set('spx', spx);
        }

        if (type === 'ws' || type === 'httpupgrade') {
          params.set('path', path || '/');
          if (hostHdr) params.set('host', hostHdr);
        }
        if (type === 'grpc') {
          if (serviceName) params.set('serviceName', serviceName);
          else warnings.push('gRPC: желательно указать serviceName');
          if (authority) params.set('authority', authority);
          if (grpcMode) params.set('mode', grpcMode);
        }

        const userEnc = encodeURIComponent(uuid);
        const hostEnc = host;
        const q = params.toString();
        const hash = tag ? ('#' + encodeURIComponent(tag)) : '';
        const url = `vless://${userEnc}@${hostEnc}:${port}?${q}${hash}`;
        return { ok: errors.length === 0, url, errors, warnings };
      }

      if (proto === 'trojan') {
        const pass = String(($('outbounds-gen-pass') && $('outbounds-gen-pass').value) || '').trim();
        if (!pass) errors.push('Для Trojan нужен пароль');

        if (sec === 'reality' && !pbk) errors.push('Reality: нужен pbk (publicKey)');

        const params = new URLSearchParams();
        params.set('type', type);
        params.set('security', sec);

        if (sec !== 'none') {
          if (fp) params.set('fp', fp);
          if (sni) params.set('sni', sni);
        }
        if (sec === 'tls') {
          if (alpn) params.set('alpn', alpn);
          if (allowInsecure) params.set('allowInsecure', '1');
        }
        if (sec === 'reality') {
          if (fp) params.set('fp', fp);
          if (sni) params.set('sni', sni);
          if (pbk) params.set('pbk', pbk);
          if (sid) params.set('sid', sid);
          if (spx) params.set('spx', spx);
        }

        if (type === 'ws' || type === 'httpupgrade') {
          params.set('path', path || '/');
          if (hostHdr) params.set('host', hostHdr);
        }
        if (type === 'grpc') {
          if (serviceName) params.set('serviceName', serviceName);
          else warnings.push('gRPC: желательно указать serviceName');
          if (authority) params.set('authority', authority);
          if (grpcMode) params.set('mode', grpcMode);
        }

        const userEnc = encodeURIComponent(pass);
        const q = params.toString();
        const hash = tag ? ('#' + encodeURIComponent(tag)) : '';
        const url = `trojan://${userEnc}@${host}:${port}?${q}${hash}`;
        return { ok: errors.length === 0, url, errors, warnings };
      }


      if (proto === 'vmess') {
        const uuid = String(($('outbounds-gen-vmess-uuid') && $('outbounds-gen-vmess-uuid').value) || '').trim();
        if (!uuid) errors.push('Для VMess нужен UUID');
        else if (!looksLikeUuid(uuid)) warnings.push('UUID не похож на UUID (проверь)');

        // VMess supports TLS/None (Reality is auto-converted to TLS)
        const tlsOn = (sec === 'tls');

        const net = type; // tcp/ws/grpc/httpupgrade
        if (!['tcp', 'ws', 'grpc', 'httpupgrade'].includes(net)) {
          warnings.push('VMess: транспорт "' + net + '" может не поддерживаться, лучше TCP/WS/gRPC');
        }

        const data = {
          v: '2',
          ps: tag || 'vmess',
          add: host,
          port: String(port),
          id: uuid,
          aid: '0',
          scy: 'auto',
          net: net,
          type: 'none',
          tls: tlsOn ? 'tls' : '',
        };

        if (tlsOn) {
          data.fp = fp || 'chrome';
          data.sni = sni || host;
          if (alpn) data.alpn = alpn;
          if (allowInsecure) data.allowInsecure = true;
        }

        if (net === 'ws' || net === 'httpupgrade') {
          data.path = path || '/';
          if (hostHdr) data.host = hostHdr;
        } else if (net === 'grpc') {
          data.path = serviceName || '';
          if (!serviceName) warnings.push('gRPC: желательно указать serviceName');
          // In many generators "host" is used as authority for gRPC
          if (authority) data.host = authority;
        }

        let b64 = '';
        try {
          b64 = safeB64Encode(JSON.stringify(data));
        } catch (e) {
          errors.push('VMess: не удалось сериализовать JSON');
        }
        const url = 'vmess://' + b64;
        return { ok: errors.length === 0, url, errors, warnings };
      }

      if (proto === 'ss') {
        const method = String(($('outbounds-gen-ss-method') && $('outbounds-gen-ss-method').value) || '').trim();
        const pass = String(($('outbounds-gen-ss-pass') && $('outbounds-gen-ss-pass').value) || '').trim();
        const plugin = String(($('outbounds-gen-ss-plugin') && $('outbounds-gen-ss-plugin').value) || '').trim();

        if (!method) errors.push('Для SS нужен method');
        if (!pass) errors.push('Для SS нужен password');

        let b64 = '';
        try {
          b64 = safeB64Encode(method + ':' + pass);
        } catch (e) {
          errors.push('SS: не удалось закодировать данные');
        }

        let url = `ss://${b64}@${host}:${port}`;
        if (plugin) url += `?plugin=${encodeURIComponent(plugin)}`;
        if (tag) url += `#${encodeURIComponent(tag)}`;

        return { ok: errors.length === 0, url, errors, warnings };
      }

      return { ok: false, url: '', errors: ['Неизвестный протокол'], warnings: [] };
    }

    function openGeneratorModal() {
      if (isOutboundsSummaryFragmentMode()) {
        try { toastXkeen('Мини-генератор работает только с одиночной proxy-ссылкой, не со списком прокси.', 'error'); } catch (e) {}
        return;
      }
      updateGeneratorSummary();
      // Sync selects from main hints for convenience
      try {
        const mainProto = $('outbounds-proto');
        const mainType = $('outbounds-type');
        const mainSec = $('outbounds-security');

        const gp = $('outbounds-gen-proto');
        const gt = $('outbounds-gen-type');
        const gs = $('outbounds-gen-security');

        if (gp && mainProto && mainProto.value) {
          const v = String(mainProto.value || '').toLowerCase();
          // Normalize hysteria/hysteria2 to hy2
          gp.value = (v === 'hysteria2' || v === 'hysteria') ? 'hy2' : v;
        }
        if (gt && mainType && mainType.value) gt.value = mainType.value;
        if (gs && mainSec && mainSec.value) gs.value = mainSec.value;

        // defaults
        const portEl = $('outbounds-gen-port');
        if (portEl && !String(portEl.value || '').trim()) portEl.value = '443';
      } catch (e) {}

      try {
        const preview = $('outbounds-gen-preview');
        if (preview) preview.value = '';
        const insertBtn = $('outbounds-gen-insert-btn');
        if (insertBtn) insertBtn.disabled = true;
        const statusEl = $('outbounds-gen-status');
        if (statusEl) statusEl.textContent = '';
      } catch (e) {}

      // Auto-prefill from current input (if it is a supported link)
      try {
        const input = $('outbounds-url');
        const current = input ? String(input.value || '').trim() : '';
        const prefillBtn = $('outbounds-gen-prefill-btn');
        if (prefillBtn) prefillBtn.disabled = !current;
        const prefillHint = $('outbounds-gen-prefill-hint');
        if (prefillHint) prefillHint.textContent = current ? 'Можно взять данные из текущего поля' : 'Основное поле сейчас пустое';
        if (current) {
          const ok = prefillGeneratorFromUrl(current);
          if (ok) {
            // Immediately build a preview link (canonical form) so user can insert right away.
            try { generatorGenerate(); } catch (e) {}

            // If generator did not output anything (rare), show a small hint.
            const statusEl = $('outbounds-gen-status');
            const previewEl = $('outbounds-gen-preview');
            if (statusEl && previewEl && !String(previewEl.value || '').trim() && !String(statusEl.textContent || '').trim()) {
              statusEl.textContent = '↩️ Поля заполнены из текущей ссылки.';
            }
          }
        }
      } catch (e) {}

      updateGeneratorVisibility();
      updateGeneratorSummary();
      showGeneratorModal(true);

      try {
        const hostEl = $('outbounds-gen-host');
        if (hostEl) hostEl.focus();
      } catch (e) {}
    }

    function closeGeneratorModal() {
      showGeneratorModal(false);
    }

    function renderGeneratorResult(result) {
      const statusEl = $('outbounds-gen-status');
      const previewEl = $('outbounds-gen-preview');
      const insertBtn = $('outbounds-gen-insert-btn');

      if (previewEl) previewEl.value = result && result.url ? result.url : '';

      if (insertBtn) insertBtn.disabled = !(result && result.ok && result.url);

      if (!statusEl) return;

      const errs = (result && result.errors) || [];
      const warns = (result && result.warnings) || [];

      if (errs.length) {
        statusEl.textContent = '❌ ' + errs.join(' · ');
        return;
      }
      if (warns.length) {
        statusEl.textContent = '⚠️ ' + warns.join(' · ');
        return;
      }
      statusEl.textContent = (result && result.ok) ? '✅ Ссылка собрана.' : '';
    }

    function generatorGenerate() {
      try {
        updateGeneratorVisibility();
        updateGeneratorSummary();
      } catch (e) {}
      const res = buildLinkFromGenerator();
      renderGeneratorResult(res);
    }

    function generatorInsert() {
      const previewEl = $('outbounds-gen-preview');
      const input = $('outbounds-url');
      if (!previewEl || !input) return;

      const url = String(previewEl.value || '').trim();
      if (!url) return;

      input.value = url;
      try { updateHintsFromUrl(url); } catch (e) {}
      try { validateAndUpdateUI(); } catch (e) {}

      try {
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (e) {}

      try {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      } catch (e) {}

      closeGeneratorModal();
      try { if (typeof showToast === 'function') showToast('Ссылка вставлена в поле.', false); } catch (e) {}
    }

    function wireGeneratorModal() {
      const modal = $('outbounds-generator-modal');
      if (!modal) return;
      if (modal.dataset && modal.dataset.xkeenGenWired === '1') return;

      // Open button
      wireButton('outbounds-build-btn', openGeneratorModal);

      // Modal buttons
      wireButton('outbounds-generator-close-btn', closeGeneratorModal);
      wireButton('outbounds-gen-cancel-btn', closeGeneratorModal);
      wireButton('outbounds-gen-prefill-btn', () => {
        try {
          const input = $('outbounds-url');
          const current = input ? String(input.value || '').trim() : '';
          if (!current) {
            const statusEl = $('outbounds-gen-status');
            if (statusEl) statusEl.textContent = 'Поле ссылки на странице пустое.';
            return;
          }
          const ok = prefillGeneratorFromUrl(current);
          updateGeneratorVisibility();
          if (ok) {
            // Immediately rebuild preview so user can insert right away.
            try { generatorGenerate(); } catch (e) {}
            const statusEl = $('outbounds-gen-status');
            if (statusEl) {
              const prev = String(statusEl.textContent || '').trim();
              if (!prev) statusEl.textContent = '↩️ Заполнено из поля.';
              else if (!prev.includes('Заполнено из поля')) statusEl.textContent = prev + '  ↩️ Заполнено из поля.';
            }
          } else {
            const statusEl = $('outbounds-gen-status');
            if (statusEl) statusEl.textContent = '⚠️ Не удалось распознать ссылку из поля.';
          }
        } catch (e) {}
      });
      wireButton('outbounds-gen-generate-btn', generatorGenerate);
      wireButton('outbounds-gen-insert-btn', generatorInsert);

      const onChange = () => {
        try {
          updateGeneratorVisibility();
          markGeneratorDirty();
        } catch (e) {}
      };

      ['outbounds-gen-proto','outbounds-gen-type','outbounds-gen-security'].forEach((id) => {
        const el = $(id);
        if (el) el.addEventListener('change', onChange);
      });

      Array.from(modal.querySelectorAll('input, select, textarea')).forEach((el) => {
        if (!el || el.id === 'outbounds-gen-preview') return;
        const evt = (el.tagName === 'SELECT') ? 'change' : 'input';
        el.addEventListener(evt, () => {
          try { markGeneratorDirty(); } catch (e) {}
        });
      });

      // Esc closes modal
      document.addEventListener('keydown', (e) => {
        if (!e) return;
        if (e.key !== 'Escape') return;
        try {
          const m = $('outbounds-generator-modal');
          if (m && !m.classList.contains('hidden')) closeGeneratorModal();
        } catch (e2) {}
      });

      if (modal.dataset) modal.dataset.xkeenGenWired = '1';
    }


    // --- Proxy pool (multiple links) ---

    const POOL_IDS = {
      modal: 'outbounds-pool-modal',
      open: 'outbounds-pool-btn',
      close: 'outbounds-pool-close-btn',
      cancel: 'outbounds-pool-cancel-btn',
      input: 'outbounds-pool-input',
      add: 'outbounds-pool-add-btn',
      clear: 'outbounds-pool-clear-btn',
      tbody: 'outbounds-pool-tbody',
      save: 'outbounds-pool-save-btn',
      replace: 'outbounds-pool-replace',
      status: 'outbounds-pool-status',
      existing: 'outbounds-pool-existing',
      summary: 'outbounds-pool-summary',
      empty: 'outbounds-pool-empty',
    };

    let _poolEntries = [];

    const POOL_RESERVED = new Set([
      'direct','block','dns',
      'freedom','blackhole','reject','bypass',
      'api','xray-api','metrics',
    ]);

    function poolShow(show) {
      const modal = $(POOL_IDS.modal);
      if (!modal) return;
      try {
        if (show) modal.classList.remove('hidden');
        else modal.classList.add('hidden');
      } catch (e) {}
      try { syncXkeenBodyScrollLock(!!show); } catch (e) {}
    }

    function poolSetStatus(msg, isErr) {
      const el = $(POOL_IDS.status);
      if (!el) return;
      try {
        el.textContent = String(msg || '');
        el.style.color = isErr ? 'var(--danger, #ef4444)' : '';
      } catch (e) {}
    }


    function poolResetDraft() {
      _poolEntries = [];
      try {
        const input = $(POOL_IDS.input);
        if (input) input.value = '';
      } catch (e) {}
      try {
        const replace = $(POOL_IDS.replace);
        if (replace) replace.checked = false;
      } catch (e) {}
      poolSetStatus('', false);
      try { poolRenderTable(); } catch (e) {}
    }

    function poolSyncUiState() {
      const summary = $(POOL_IDS.summary);
      const empty = $(POOL_IDS.empty);
      const saveBtn = $(POOL_IDS.save);
      let ready = 0;
      let total = 0;
      try {
        total = Array.isArray(_poolEntries) ? _poolEntries.length : 0;
        ready = _poolEntries.filter((e) => String((e && e.url) || '').trim()).length;
      } catch (e) {}
      try {
        if (summary) {
          summary.textContent = `${total} строк · ${ready} tag`;
        }
      } catch (e) {}
      try {
        if (empty) empty.style.display = total ? 'none' : 'block';
      } catch (e) {}
      try {
        if (saveBtn) saveBtn.disabled = !ready;
      } catch (e) {}
    }

    function poolSanitizeTag(tag) {
      let t = String(tag || '').trim();
      // Remove whitespace and unsafe chars (keep a-zA-Z0-9._:-)
      t = t.replace(/\s+/g, '_').replace(/[^A-Za-z0-9._:-]+/g, '_');
      t = t.replace(/^_+/, '').replace(/_+$/, '');
      return t;
    }

    function poolSuggestTagFromUrl(url, fallbackIdx) {
      const raw = String(url || '').trim();
      if (!raw) return 'p' + String(fallbackIdx || 1);

      // 1) Prefer #fragment
      try {
        const hashIdx = raw.indexOf('#');
        if (hashIdx >= 0 && hashIdx < raw.length - 1) {
          const frag = safeDecodeURIComponent(raw.slice(hashIdx + 1));
          const t1 = poolSanitizeTag(frag);
          if (t1) return t1;
        }
      } catch (e) {}

      // 2) Try host
      try {
        const u = new URL(raw);
        const host = (u.hostname || '').toString();
        const port = (u.port || '').toString();
        const base = host + (port ? ('_' + port) : '');
        const t2 = poolSanitizeTag(base);
        if (t2) return t2;
      } catch (e) {}

      return 'p' + String(fallbackIdx || 1);
    }

    function poolEnsureUniqueTag(tag, existingSet) {
      let t = String(tag || '').trim();
      if (!t) t = 'p1';
      if (!existingSet) existingSet = new Set();
      const base = t;
      let k = 2;
      while (existingSet.has(t) || POOL_RESERVED.has(String(t).toLowerCase())) {
        t = base + '-' + String(k++);
      }
      return t;
    }

    function poolParseLines(text) {
      const lines = String(text || '').split(/\r?\n/).map((s) => String(s || '').trim()).filter(Boolean);
      const parsed = [];

      lines.forEach((line, idx) => {
        let tag = '';
        let url = '';

        // Formats:
        //  - tag | url
        //  - tag = url
        //  - url
        // Important: raw vmess/vless links may contain '=' inside the URL,
        // so treat '=' as a tag separator only when it appears before the scheme.
        const pipeIdx = line.indexOf('|');
        const eqIdx = line.indexOf('=');
        const schemeIdx = line.indexOf('://');

        if (pipeIdx > 0 && (schemeIdx === -1 || pipeIdx < schemeIdx)) {
          tag = line.slice(0, pipeIdx).trim();
          url = line.slice(pipeIdx + 1).trim();
        } else if (eqIdx > 0 && (schemeIdx === -1 || eqIdx < schemeIdx)) {
          const left = line.slice(0, eqIdx).trim();
          const right = line.slice(eqIdx + 1).trim();
          if (right.includes('://')) {
            tag = left;
            url = right;
          } else {
            url = line;
          }
        } else {
          url = line;
        }

        if (!url) return;

        const explicitTag = !!poolSanitizeTag(tag);
        tag = poolSanitizeTag(tag);
        if (!tag) tag = poolSuggestTagFromUrl(url, idx + 1);

        parsed.push({ tag, url, explicitTag });
      });

      return parsed;
    }

    function poolRenderTable() {
      const tbody = $(POOL_IDS.tbody);
      if (!tbody) return;
      tbody.innerHTML = '';

      _poolEntries.forEach((ent, idx) => {
        const tr = document.createElement('tr');
        tr.dataset.idx = String(idx);

        const tdTag = document.createElement('td');
        tdTag.style.padding = '8px';
        const inTag = document.createElement('input');
        inTag.type = 'text';
        inTag.value = String(ent.tag || '');
        inTag.className = 'xray-log-filter';
        inTag.style.width = '100%';
        inTag.addEventListener('change', () => {
          const v = poolSanitizeTag(inTag.value);
          _poolEntries[idx].tag = v;
          inTag.value = v;
          poolSyncUiState();
        });
        tdTag.appendChild(inTag);

        const tdUrl = document.createElement('td');
        tdUrl.style.padding = '8px';
        const inUrl = document.createElement('input');
        inUrl.type = 'text';
        inUrl.value = String(ent.url || '');
        inUrl.className = 'xray-log-filter';
        inUrl.style.width = '100%';
        inUrl.addEventListener('change', () => {
          _poolEntries[idx].url = String(inUrl.value || '').trim();
          poolSyncUiState();
        });
        tdUrl.appendChild(inUrl);

        const tdAct = document.createElement('td');
        tdAct.style.padding = '8px';
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'btn-secondary xk-pool-delete-btn';
        del.textContent = '✕';
        del.title = 'Удалить';
        del.setAttribute('aria-label', 'Удалить строку');
        del.addEventListener('click', () => {
          _poolEntries.splice(idx, 1);
          poolRenderTable();
        });
        tdAct.appendChild(del);

        tr.appendChild(tdTag);
        tr.appendChild(tdUrl);
        tr.appendChild(tdAct);
        tbody.appendChild(tr);
      });

      poolSyncUiState();
    }

    function poolCollectEntries() {
      // Ensure clean + unique tags
      const out = [];
      const used = new Set();
      for (let i = 0; i < _poolEntries.length; i++) {
        const e = _poolEntries[i] || {};
        const url = String(e.url || '').trim();
        if (!url) continue;
        let tag = poolSanitizeTag(e.tag || '');
        if (!tag) tag = poolSuggestTagFromUrl(url, i + 1);
        tag = poolEnsureUniqueTag(tag, used);
        used.add(tag);
        if (POOL_RESERVED.has(String(tag).toLowerCase())) continue;
        out.push({ tag, url });
      }
      return out;
    }

    async function poolRefreshExistingTagsHint() {
      const hint = $(POOL_IDS.existing);
      if (!hint) return;
      hint.textContent = '';
      let url = '/api/xray/outbound-tags';
      const f = getActiveFragment();
      if (f) url += '?file=' + encodeURIComponent(String(f));
      try {
        const res = await fetch(url, { cache: 'no-store' });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || !data.ok || !Array.isArray(data.tags)) return;
        const tags = data.tags.map((t) => String(t || '').trim()).filter(Boolean);
        if (!tags.length) return;
        const show = tags.slice(0, 10).join(', ') + (tags.length > 10 ? ` … (+${tags.length - 10})` : '');
        hint.textContent = 'Существующие теги: ' + show;
      } catch (e) {}
    }

    async function poolSave() {
      poolSetStatus('', false);
      const entries = poolCollectEntries();
      if (!entries.length) {
        poolSetStatus('Список пустой.', true);
        return;
      }

      // Final validation (reserved + duplicates)
      const seen = new Set();
      for (const e of entries) {
        const t = String(e.tag || '').trim();
        if (!t) {
          poolSetStatus('У одной из строк пустой tag.', true);
          return;
        }
        if (POOL_RESERVED.has(t.toLowerCase())) {
          poolSetStatus('Tag зарезервирован: ' + t, true);
          return;
        }
        if (seen.has(t)) {
          poolSetStatus('Дубликат tag: ' + t, true);
          return;
        }
        seen.add(t);
      }

      const replaceCb = $(POOL_IDS.replace);
      const replacePool = !!(replaceCb && replaceCb.checked);

      let apiUrl = '/api/xray/outbounds/proxies';
      const f = getActiveFragment();
      if (f) apiUrl += '?file=' + encodeURIComponent(String(f));

      poolSetStatus('Сохраняю…', false);
      const restart = shouldRestartAfterSave();

      try {
        const requestUrl = apiUrl + (restart ? (apiUrl.indexOf('?') === -1 ? '?async=1' : '&async=1') : '');
        const res = await fetch(requestUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entries,
            restart,
            replace_pool: replacePool,
            write_raw: true,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data || data.ok === false) {
          const err = (data && (data.error || data.message)) ? String(data.error || data.message) : 'Ошибка сохранения.';
          poolSetStatus(err, true);
          try { toastXkeen(err, 'error'); } catch (e) {}
          return;
        }

        const jobId = (data && (data.restart_job_id || data.job_id || data.restartJobId))
          ? String(data.restart_job_id || data.job_id || data.restartJobId)
          : '';

        let msg = 'Пул прокси сохранён' + (data.restarted ? ' и перезапущен.' : '.');

        if (restart && jobId) {
          poolSetStatus('Пул прокси сохранён. Перезапуск xkeen...', false);
          const result = await streamRestartJob(jobId, 'xkeen -restart (job)...\n');
          const ok = !!(result && result.ok);
          if (ok) {
            msg = 'Пул прокси сохранён и xkeen перезапущен.';
            poolSetStatus('✅ ' + msg, false);
            try { toastXkeen(msg, 'success'); } catch (e) {}
          } else {
            const err = (result && (result.error || result.message)) ? String(result.error || result.message) : '';
            const exitCode = (result && typeof result.exit_code === 'number') ? result.exit_code : null;
            const detail = err
              ? ('Ошибка: ' + err)
              : (exitCode !== null ? ('Ошибка (exit_code=' + exitCode + ')') : '');
            const restartLog = getRestartLogApi();
            if (detail && restartLog && typeof restartLog.append === 'function') {
              try { restartLog.append('\n' + detail + '\n'); } catch (e) {}
            }
            msg = 'Пул прокси сохранён, но перезапуск xkeen завершился с ошибкой.';
            poolSetStatus(msg, true);
            try { toastXkeen(msg, 'error'); } catch (e2) {}
          }
        } else {
          poolSetStatus('✅ ' + msg, false);
          try { toastXkeen(msg, 'success'); } catch (e) {}
        }

        // Refresh outbounds state on page
        try { await load(); } catch (e) {}
        poolShow(false);
      } catch (e) {
        poolSetStatus('Ошибка сети: ' + String(e || ''), true);
      }
    }

    function poolOpen() {
      poolResetDraft();
      poolShow(true);
      try { poolRefreshExistingTagsHint(); } catch (e) {}
      try { poolRenderTable(); } catch (e) {}
      try {
        const input = $(POOL_IDS.input);
        if (input) input.focus();
      } catch (e) {}
    }

    function poolClose() {
      poolShow(false);
    }

    function wirePoolModal() {
      const modal = $(POOL_IDS.modal);
      if (!modal) return;
      if (modal.dataset && modal.dataset.xkWired === '1') return;

      wireButton(POOL_IDS.open, poolOpen);
      wireButton(POOL_IDS.close, poolClose);
      wireButton(POOL_IDS.cancel, poolClose);

      wireButton(POOL_IDS.clear, () => {
        poolResetDraft();
      });

      wireButton(POOL_IDS.add, () => {
        const input = $(POOL_IDS.input);
        const text = input ? String(input.value || '') : '';
        const add = poolParseLines(text);
        if (!add.length) {
          poolSetStatus('Не нашёл строк со ссылками.', true);
          return;
        }
        // Merge into state (explicit tag -> update existing, auto tag -> keep unique)
        const byTag = new Map();
        _poolEntries.forEach((e) => {
          const t = String((e && e.tag) || '').trim();
          if (t) byTag.set(t, { tag: t, url: String((e && e.url) || '') });
        });

        const used = new Set(Array.from(byTag.keys()));
        add.forEach((e, idx) => {
          let t = poolSanitizeTag(e && e.tag);
          const url = String((e && e.url) || '').trim();
          const explicitTag = !!(e && e.explicitTag);
          if (!t) t = poolSuggestTagFromUrl(url, idx + 1);

          if (!explicitTag && used.has(t)) {
            t = poolEnsureUniqueTag(t, used);
          }

          used.add(t);
          byTag.set(t, { tag: t, url });
        });

        _poolEntries = Array.from(byTag.values());
        poolRenderTable();
        poolSetStatus(`Добавлено/обновлено: ${add.length}. Итог строк: ${_poolEntries.length}.`, false);

        try {
          if (input) {
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
          }
        } catch (e) {}
      });

      wireButton(POOL_IDS.save, poolSave);
      try { poolSyncUiState(); } catch (e) {}

      // Esc closes modal
      document.addEventListener('keydown', (e) => {
        if (!e) return;
        if (e.key !== 'Escape') return;
        try {
          const m = $(POOL_IDS.modal);
          if (m && !m.classList.contains('hidden')) poolClose();
        } catch (e2) {}
      });

      if (modal.dataset) modal.dataset.xkWired = '1';
    }

    // --- Xray subscriptions (auto-updated generated outbounds) ---

    const SUB_IDS = {
      open: 'outbounds-subscriptions-btn',
      modal: 'outbounds-subscriptions-modal',
      close: 'outbounds-subscriptions-close-btn',
      cancel: 'outbounds-subscriptions-cancel-btn',
      form: 'outbounds-subscriptions-form',
      id: 'outbounds-subscriptions-id',
      name: 'outbounds-subscriptions-name',
      nameNote: 'outbounds-subscriptions-name-note',
      tag: 'outbounds-subscriptions-tag',
      tagNote: 'outbounds-subscriptions-tag-note',
      url: 'outbounds-subscriptions-url',
      urlNote: 'outbounds-subscriptions-url-note',
      nameFilter: 'outbounds-subscriptions-name-filter',
      nameFilterNote: 'outbounds-subscriptions-name-filter-note',
      typeFilter: 'outbounds-subscriptions-type-filter',
      typeFilterNote: 'outbounds-subscriptions-type-filter-note',
      transportFilter: 'outbounds-subscriptions-transport-filter',
      transportFilterNote: 'outbounds-subscriptions-transport-filter-note',
      routingMode: 'outbounds-subscriptions-routing-mode',
      routingAutoRule: 'outbounds-subscriptions-routing-auto-rule',
      routingBalancers: 'outbounds-subscriptions-routing-balancers',
      routingBalancersNote: 'outbounds-subscriptions-routing-balancers-note',
      excludedKeys: 'outbounds-subscriptions-excluded-keys',
      interval: 'outbounds-subscriptions-interval',
      intervalNote: 'outbounds-subscriptions-interval-note',
      intervalApply: 'outbounds-subscriptions-interval-apply-btn',
      enabled: 'outbounds-subscriptions-enabled',
      ping: 'outbounds-subscriptions-ping',
      refreshNow: 'outbounds-subscriptions-refresh-now',
      save: 'outbounds-subscriptions-save-btn',
      reset: 'outbounds-subscriptions-reset-btn',
      preview: 'outbounds-subscriptions-preview-btn',
      refreshDue: 'outbounds-subscriptions-refresh-due-btn',
      tbody: 'outbounds-subscriptions-tbody',
      empty: 'outbounds-subscriptions-empty',
      diagnostics: 'outbounds-subscriptions-diagnostics',
      diagnosticsTitle: 'outbounds-subscriptions-diagnostics-title',
      diagnosticsPills: 'outbounds-subscriptions-diagnostics-pills',
      diagnosticsBody: 'outbounds-subscriptions-diagnostics-body',
      status: 'outbounds-subscriptions-status',
      summary: 'outbounds-subscriptions-summary',
      nodesPanel: 'outbounds-subscriptions-nodes-panel',
      nodesCaption: 'outbounds-subscriptions-nodes-caption',
      nodesSummary: 'outbounds-subscriptions-nodes-summary',
      nodesPingAll: 'outbounds-subscriptions-nodes-pingall',
      nodesShowHidden: 'outbounds-subscriptions-nodes-show-hidden',
      nodesList: 'outbounds-subscriptions-nodes-list',
      nodesEmpty: 'outbounds-subscriptions-nodes-empty',
    };

    let _subscriptions = [];
    let _subscriptionRoutingBalancers = [];
    let _subscriptionEditId = '';
    let _subscriptionNodePingState = Object.create(null);
    let _subscriptionPingAllBusy = false;
    let _subscriptionPreview = null;
    let _subscriptionShowHidden = false;
    let _subscriptionBaseline = null;
    let _subscriptionPreviewBusy = false;
    let _subscriptionSaveBusy = false;
    const SUB_DEFAULT_INTERVAL_HOURS = 24;
    const SUB_RESERVED_TAGS = new Set([
      'direct',
      'block',
      'dns',
      'freedom',
      'blackhole',
      'reject',
      'bypass',
      'api',
      'xray-api',
      'metrics',
    ]);

    function subsFindById(subId) {
      const target = subsCleanId(subId);
      if (!target) return null;
      return _subscriptions.find((item) => subsCleanId(item && item.id) === target) || null;
    }

    function subsCleanId(value) {
      let raw = String(value || '').trim().toLowerCase();
      raw = raw.replace(/[^a-z0-9_.-]+/g, '-');
      raw = raw.replace(/-{2,}/g, '-').replace(/^[-._]+|[-._]+$/g, '');
      if (!raw) raw = 'sub';
      if (/^\d/.test(raw)) raw = 'sub-' + raw;
      return raw.slice(0, 40).replace(/^[-._]+|[-._]+$/g, '') || 'sub';
    }

    function subsUniqueId(base, existing) {
      const used = new Set((Array.isArray(existing) ? existing : []).map((item) => String(item || '')));
      const candidate = subsCleanId(base);
      if (!used.has(candidate)) return candidate;
      const root = candidate.slice(0, 34).replace(/^[-._]+|[-._]+$/g, '') || 'sub';
      let idx = 2;
      while (true) {
        const nextId = `${root}-${idx}`;
        if (!used.has(nextId)) return nextId;
        idx += 1;
      }
    }

    function subsDefaultIdFromUrl(url) {
      try {
        const parsed = new URL(String(url || '').trim());
        return subsCleanId(parsed.hostname || 'subscription');
      } catch (e) {}
      return subsCleanId('subscription');
    }

    function subsCleanTagPrefix(value, fallback) {
      let raw = String(value || '').trim();
      if (!raw) raw = String(fallback || '').trim();
      raw = raw.replace(/\s+/g, '_');
      raw = raw.replace(/[^A-Za-z0-9_.:-]+/g, '_');
      raw = raw.replace(/^[_.:-]+|[_.:-]+$/g, '');
      if (!raw) raw = String(fallback || 'sub').trim() || 'sub';
      if (SUB_RESERVED_TAGS.has(raw.toLowerCase())) raw += '_sub';
      return raw.slice(0, 32).replace(/^[_.:-]+|[_.:-]+$/g, '') || 'sub';
    }

    function subsNormalizeBalancerTags(value) {
      const items = Array.isArray(value) ? value : [];
      const known = new Set((_subscriptionRoutingBalancers || []).map((item) => String(item && item.tag || '').trim()).filter(Boolean));
      const seen = new Set();
      return items
        .map((item) => String(item || '').trim())
        .filter((tag) => !!tag && known.has(tag) && !seen.has(tag) && seen.add(tag));
    }

    function subsSelectedBalancerTags() {
      const root = $(SUB_IDS.routingBalancers);
      if (!root || !root.querySelectorAll) return [];
      const values = Array.from(root.querySelectorAll('input[type="checkbox"][data-balancer-tag]:checked'))
        .map((input) => String(input && input.getAttribute('data-balancer-tag') || '').trim());
      return subsNormalizeBalancerTags(values);
    }

    function subsSetSelectedBalancerTags(value) {
      const selected = new Set(subsNormalizeBalancerTags(value));
      const root = $(SUB_IDS.routingBalancers);
      if (!root || !root.querySelectorAll) return;
      Array.from(root.querySelectorAll('input[type="checkbox"][data-balancer-tag]')).forEach((input) => {
        const tag = String(input && input.getAttribute('data-balancer-tag') || '').trim();
        try { input.checked = selected.has(tag); } catch (e) {}
      });
    }

    function subsRenderRoutingBalancers(selectedTags) {
      const root = $(SUB_IDS.routingBalancers);
      const note = $(SUB_IDS.routingBalancersNote);
      if (!root) return;
      const selected = new Set(subsNormalizeBalancerTags(selectedTags));
      const items = Array.isArray(_subscriptionRoutingBalancers) ? _subscriptionRoutingBalancers.slice() : [];
      if (!items.length) {
        root.innerHTML = '<div class="xk-sub-balancers-empty">В routing.balancers пока нет готовых selector-пулов. Можно оставить только общий leastPing pool.</div>';
        if (note) {
          note.textContent = 'Чекбоксы появятся, когда в 05_routing.json будут настроены balancers[].tag.';
          note.hidden = false;
        }
        return;
      }
      root.innerHTML = items.map((item) => {
        const tag = String(item && item.tag || '').trim();
        const strategy = String(item && item.strategy_type || '').trim();
        const fallback = String(item && item.fallback_tag || '').trim();
        const selectorCount = Number(item && item.selector_count || 0);
        const autoManaged = !!(item && item.auto_managed);
        const title = [
          strategy ? `strategy: ${strategy}` : '',
          fallback ? `fallback: ${fallback}` : '',
          selectorCount > 0 ? `selector: ${selectorCount}` : 'selector пуст',
        ].filter(Boolean).join(' · ');
        const meta = [
          strategy || 'balancer',
          fallback ? `fallback ${fallback}` : '',
          selectorCount > 0 ? `${selectorCount} selector` : '',
          autoManaged ? 'auto pool' : '',
        ].filter(Boolean).join(' · ');
        return `
          <label class="xk-sub-check xk-sub-balancer-check" title="${escapeHtml(title)}" data-tooltip="${escapeHtml(title)}">
            <input type="checkbox" data-balancer-tag="${escapeHtml(tag)}" ${selected.has(tag) ? 'checked' : ''}>
            <span class="xk-sub-balancer-copy">
              <span class="xk-sub-balancer-tag">${escapeHtml(tag)}</span>
              <span class="xk-sub-balancer-meta">${escapeHtml(meta)}</span>
            </span>
          </label>
        `;
      }).join('');
      if (note) {
        note.textContent = 'Отметь balancer-ы, в чьи selector-ы нужно автоматически добавлять tag prefix этой подписки.';
        note.hidden = false;
      }
    }

    function subsReadFormState() {
      return {
        id: String(($(SUB_IDS.id) && $(SUB_IDS.id).value) || _subscriptionEditId || '').trim(),
        name: String(($(SUB_IDS.name) && $(SUB_IDS.name).value) || '').trim(),
        tag: String(($(SUB_IDS.tag) && $(SUB_IDS.tag).value) || '').trim(),
        url: String(($(SUB_IDS.url) && $(SUB_IDS.url).value) || '').trim(),
        name_filter: String(($(SUB_IDS.nameFilter) && $(SUB_IDS.nameFilter).value) || '').trim(),
        type_filter: String(($(SUB_IDS.typeFilter) && $(SUB_IDS.typeFilter).value) || '').trim(),
        transport_filter: String(($(SUB_IDS.transportFilter) && $(SUB_IDS.transportFilter).value) || '').trim(),
        routing_mode: String(($(SUB_IDS.routingMode) && $(SUB_IDS.routingMode).value) || 'safe-fallback').trim() || 'safe-fallback',
        routing_auto_rule: !!($(SUB_IDS.routingAutoRule) && $(SUB_IDS.routingAutoRule).checked),
        routing_balancer_tags: subsSelectedBalancerTags(),
        excluded_node_keys: subsGetExcludedKeysValue().slice().sort(),
        interval_raw: String(($(SUB_IDS.interval) && $(SUB_IDS.interval).value) || '').trim(),
        enabled: !!($(SUB_IDS.enabled) && $(SUB_IDS.enabled).checked),
        ping_enabled: !!($(SUB_IDS.ping) && $(SUB_IDS.ping).checked),
      };
    }

    function subsResolveDraftDefaults(formState) {
      const state = (formState && typeof formState === 'object') ? formState : subsReadFormState();
      const rawId = String(state.id || '').trim();
      let subId = '';
      let existing = null;
      if (rawId) {
        subId = subsCleanId(rawId);
        existing = subsFindById(subId);
      } else {
        const existingIds = _subscriptions.map((item) => String(item && item.id || '')).filter(Boolean);
        subId = subsUniqueId(state.tag || state.name || subsDefaultIdFromUrl(state.url), existingIds);
      }
      const base = existing && typeof existing === 'object' ? existing : {};
      const tag = subsCleanTagPrefix(state.tag || base.tag || subId, subId);
      const name = String(state.name || base.name || tag).trim() || tag;
      return {
        subId,
        tag,
        name,
        base,
        existing,
        keepsSavedName: !state.name && !!String(base.name || '').trim(),
        keepsSavedTag: !state.tag && !!String(base.tag || '').trim(),
        normalizesTag: !!state.tag && String(state.tag || '').trim() !== tag,
      };
    }

    function subsDraftSnapshot(formState) {
      const state = (formState && typeof formState === 'object') ? formState : subsReadFormState();
      return {
        id: String(state.id || '').trim(),
        name: String(state.name || '').trim(),
        tag: String(state.tag || '').trim(),
        url: String(state.url || '').trim(),
        name_filter: String(state.name_filter || '').trim(),
        type_filter: String(state.type_filter || '').trim(),
        transport_filter: String(state.transport_filter || '').trim(),
        routing_mode: String(state.routing_mode || 'safe-fallback').trim() || 'safe-fallback',
        routing_auto_rule: !!state.routing_auto_rule,
        routing_balancer_tags: subsNormalizeBalancerTags(state.routing_balancer_tags),
        excluded_node_keys: (Array.isArray(state.excluded_node_keys) ? state.excluded_node_keys : []).map((item) => String(item || '').trim()).filter(Boolean).sort(),
        interval_raw: String(state.interval_raw || '').trim(),
        enabled: !!state.enabled,
        ping_enabled: !!state.ping_enabled,
        preview_active: !!_subscriptionPreview,
      };
    }

    function subsCaptureBaseline(formState) {
      _subscriptionBaseline = subsDraftSnapshot(formState);
      return _subscriptionBaseline;
    }

    function subsHasDirtyDraft(formState) {
      if (!_subscriptionBaseline) return false;
      return JSON.stringify(subsDraftSnapshot(formState)) !== JSON.stringify(_subscriptionBaseline);
    }

    function subsSetFieldInvalid(inputId, invalid) {
      const el = $(inputId);
      if (!el) return;
      try { el.classList.toggle('is-invalid', !!invalid); } catch (e) {}
      try { el.setAttribute('aria-invalid', invalid ? 'true' : 'false'); } catch (e2) {}
    }

    function subsSetFieldNote(noteId, message, kind) {
      const el = $(noteId);
      if (!el) return;
      const text = String(message || '').trim();
      const tone = String(kind || '').trim().toLowerCase();
      try { el.textContent = text; } catch (e) {}
      try { el.hidden = !text; } catch (e2) {}
      try {
        el.classList.toggle('is-error', tone === 'error');
        el.classList.toggle('is-auto', tone === 'auto');
        el.classList.toggle('is-info', tone === 'info');
      } catch (e3) {}
    }

    function subsValidateRegex(raw, label) {
      const text = String(raw || '').trim();
      if (!text) return '';
      try {
        new RegExp(text, 'i');
        return '';
      } catch (e) {
        return `Некорректный regex для ${label}: ${String((e && e.message) || e || 'ошибка')}`;
      }
    }

    function subsValidateFormState(formState) {
      const state = (formState && typeof formState === 'object') ? formState : subsReadFormState();
      const errors = {
        name: '',
        tag: '',
        url: '',
        interval: '',
        nameFilter: subsValidateRegex(state.name_filter, 'фильтра имени'),
        typeFilter: subsValidateRegex(state.type_filter, 'фильтра типа'),
        transportFilter: subsValidateRegex(state.transport_filter, 'фильтра транспорта'),
      };

      if (!state.url) {
        errors.url = 'URL обязателен.';
      } else {
        try {
          const parsed = new URL(state.url);
          if (!/^https?:$/i.test(String(parsed.protocol || '')) || !String(parsed.hostname || '').trim()) {
            throw new Error('bad-protocol');
          }
        } catch (e) {
          errors.url = 'Укажи корректный HTTP(S) URL.';
        }
      }

      const intervalRaw = String(state.interval_raw || '').trim();
      if (intervalRaw) {
        const intervalValue = Number(intervalRaw);
        if (!Number.isFinite(intervalValue) || !Number.isInteger(intervalValue) || intervalValue < 1 || intervalValue > 168) {
          errors.interval = 'Укажи целое число от 1 до 168 часов.';
        }
      }

      const fields = ['url', 'interval', 'nameFilter', 'typeFilter', 'transportFilter'];
      return {
        errors,
        valid: fields.every((key) => !errors[key]),
      };
    }

    function subsFirstValidationError(validation) {
      const errors = validation && validation.errors ? validation.errors : {};
      return String(
        errors.url
        || errors.interval
        || errors.nameFilter
        || errors.typeFilter
        || errors.transportFilter
        || ''
      ).trim();
    }

    function subsCurrentIntervalHours(formState) {
      const state = (formState && typeof formState === 'object') ? formState : subsReadFormState();
      const raw = String(state.interval_raw || '').trim();
      if (!raw) return SUB_DEFAULT_INTERVAL_HOURS;
      const value = Number(raw);
      if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > 168) return null;
      return value;
    }

    function subsProviderIntervalHours(formState) {
      const state = (formState && typeof formState === 'object') ? formState : subsReadFormState();
      const currentUrl = String(state.url || '').trim();
      const previewUrl = String((_subscriptionPreview && _subscriptionPreview.url) || '').trim();
      if (_subscriptionPreview && currentUrl && currentUrl === previewUrl) {
        const previewHours = Number(_subscriptionPreview.profileUpdateIntervalHours || 0);
        if (Number.isFinite(previewHours) && previewHours > 0) return previewHours;
      }
      const currentId = String(state.id || _subscriptionEditId || '').trim();
      if (!currentId) return 0;
      const saved = subsFindById(currentId);
      if (!saved) return 0;
      const savedUrl = String(saved.url || '').trim();
      if (currentUrl && savedUrl && currentUrl !== savedUrl) return 0;
      const savedHours = Number(saved.profile_update_interval_hours || 0);
      return Number.isFinite(savedHours) && savedHours > 0 ? savedHours : 0;
    }

    function subsSyncIntervalRecommendation(formState, validation) {
      const state = (formState && typeof formState === 'object') ? formState : subsReadFormState();
      const currentInterval = subsCurrentIntervalHours(state);
      const providerHours = subsProviderIntervalHours(state);
      const applyBtn = $(SUB_IDS.intervalApply);
      const canApply = providerHours > 0 && (!Number.isFinite(currentInterval) || currentInterval !== providerHours);

      if (applyBtn) {
        applyBtn.hidden = !canApply;
        applyBtn.disabled = !canApply;
        applyBtn.textContent = canApply ? `${providerHours} ч` : '';
        try {
          if (canApply) {
            applyBtn.setAttribute('data-hours', String(providerHours));
            const tooltip = `Принять рекомендацию провайдера: обновлять подписку каждые ${providerHours} ч.`;
            applyBtn.setAttribute('title', tooltip);
            applyBtn.setAttribute('data-tooltip', tooltip);
            applyBtn.setAttribute('aria-label', tooltip);
            applyBtn.classList.add('is-provider');
          } else {
            applyBtn.removeAttribute('data-hours');
            applyBtn.removeAttribute('title');
            applyBtn.removeAttribute('data-tooltip');
            applyBtn.removeAttribute('aria-label');
            applyBtn.classList.remove('is-provider');
          }
        } catch (e) {}
      }

      let noteText = '';
      let noteKind = '';
      if (validation && validation.errors && validation.errors.interval) {
        noteText = validation.errors.interval;
        noteKind = 'error';
      } else if (providerHours > 0) {
        if (Number.isFinite(currentInterval) && currentInterval === providerHours) {
          noteText = `Рекомендовано: ${providerHours} ч`;
          noteKind = 'info';
        }
      } else if (!state.interval_raw) {
        noteText = `По умолчанию: ${SUB_DEFAULT_INTERVAL_HOURS} ч`;
        noteKind = 'info';
      }

      subsSetFieldNote(SUB_IDS.intervalNote, noteText, noteKind);
    }

    function subsNameNote(formState, resolved) {
      const state = formState || subsReadFormState();
      const info = resolved || subsResolveDraftDefaults(state);
      if (state.name) return { text: '', kind: '' };
      if (info.keepsSavedName) {
        return { text: `Пустое поле сохранит текущее имя: ${info.name}.`, kind: 'info' };
      }
      if (!state.url && !state.tag) {
        return { text: 'Оставь поле пустым, и имя появится после ввода URL.', kind: 'auto' };
      }
      return { text: `Авто: ${info.name}.`, kind: 'auto' };
    }

    function subsTagNote(formState, resolved) {
      const state = formState || subsReadFormState();
      const info = resolved || subsResolveDraftDefaults(state);
      if (!state.tag) {
        if (info.keepsSavedTag) {
          return { text: `Пустое поле сохранит текущий prefix: ${info.tag}.`, kind: 'info' };
        }
        if (!state.url && !state.name) {
          return { text: 'Оставь поле пустым, и prefix появится после ввода URL.', kind: 'auto' };
        }
        return { text: `Авто: ${info.tag}.`, kind: 'auto' };
      }
      if (info.normalizesTag) {
        return { text: `После сохранения будет использован prefix: ${info.tag}.`, kind: 'info' };
      }
      return { text: '', kind: '' };
    }

    function subsSyncSubscriptionFormState() {
      const formState = subsReadFormState();
      const resolved = subsResolveDraftDefaults(formState);
      const validation = subsValidateFormState(formState);
      const dirty = subsHasDirtyDraft(formState);

      subsSetFieldInvalid(SUB_IDS.url, !!validation.errors.url);
      subsSetFieldInvalid(SUB_IDS.interval, !!validation.errors.interval);
      subsSetFieldInvalid(SUB_IDS.nameFilter, !!validation.errors.nameFilter);
      subsSetFieldInvalid(SUB_IDS.typeFilter, !!validation.errors.typeFilter);
      subsSetFieldInvalid(SUB_IDS.transportFilter, !!validation.errors.transportFilter);

      const nameNote = subsNameNote(formState, resolved);
      const tagNote = subsTagNote(formState, resolved);
      subsSetFieldNote(SUB_IDS.nameNote, nameNote.text, nameNote.kind);
      subsSetFieldNote(SUB_IDS.tagNote, tagNote.text, tagNote.kind);
      subsSetFieldNote(SUB_IDS.urlNote, validation.errors.url, validation.errors.url ? 'error' : '');
      subsSyncIntervalRecommendation(formState, validation);
      subsSetFieldNote(SUB_IDS.nameFilterNote, validation.errors.nameFilter, validation.errors.nameFilter ? 'error' : '');
      subsSetFieldNote(SUB_IDS.typeFilterNote, validation.errors.typeFilter, validation.errors.typeFilter ? 'error' : '');
      subsSetFieldNote(SUB_IDS.transportFilterNote, validation.errors.transportFilter, validation.errors.transportFilter ? 'error' : '');
      const routingModeEl = $(SUB_IDS.routingMode);
      if (routingModeEl) {
        routingModeEl.disabled = !formState.routing_auto_rule;
        try {
          routingModeEl.setAttribute(
            'data-tooltip',
            formState.routing_auto_rule
              ? 'Безопасно: leastPing-balancer и fallback синхронизируются, но явные правила на vless-reality остаются. Жёстко: auto-правила на vless-reality переезжают в balancerTag пула.'
              : 'Режим «Применение» влияет только на общий auto-managed leastPing pool. Включи «Общий pool», чтобы менять это поведение.'
          );
        } catch (e4) {}
      }

      const saveBtn = $(SUB_IDS.save);
      if (saveBtn) {
        saveBtn.disabled = !validation.valid || _subscriptionSaveBusy;
        saveBtn.classList.toggle('is-dirty', !!dirty && !saveBtn.disabled);
      }
      const previewBtn = $(SUB_IDS.preview);
      if (previewBtn) {
        previewBtn.disabled = !validation.valid || _subscriptionPreviewBusy;
        const urlValue = String(formState.url || '').trim();
        const previewMatches = !!_subscriptionPreview && String(_subscriptionPreview.url || '') === urlValue;
        const armed = !previewBtn.disabled && urlValue.length > 0 && !previewMatches;
        previewBtn.classList.toggle('is-armed', armed);
      }
      try { subsUpdateDraftBadge(formState, dirty); } catch (e) {}
      try { subsRenderDiagnostics(); } catch (e2) {}

      return { formState, resolved, validation, dirty };
    }

    function subsBuildDiscardConfirmText(opts) {
      const options = (opts && typeof opts === 'object') ? opts : {};
      const parts = [
        'Несохранённые изменения',
        String(options.message || 'В форме подписки есть несохранённые изменения. Продолжить и потерять их?').trim(),
      ];
      const details = Array.isArray(options.details)
        ? options.details.map((item) => String(item || '').trim()).filter(Boolean)
        : [String(options.details || '').trim()].filter(Boolean);
      return parts.concat(details).filter(Boolean).join('\n\n');
    }

    async function subsConfirmDiscardDraft(opts) {
      const options = (opts && typeof opts === 'object') ? opts : {};
      const formState = subsReadFormState();
      if (!subsHasDirtyDraft(formState)) return true;
      const confirmOptions = Object.assign({}, options, {
        title: 'Несохранённые изменения',
        message: String(options.message || 'В форме подписки есть несохранённые изменения. Продолжить и потерять их?'),
        details: options.details || [
          _subscriptionPreview
            ? 'Черновик предпросмотра и ручные исключения узлов не будут сохранены.'
            : 'Текущие правки формы не будут сохранены.',
        ],
      });
      let ok = false;
      try {
        ok = !!window.confirm(subsBuildDiscardConfirmText(confirmOptions));
      } catch (e) {
        ok = false;
      }
      if (ok && options.restore !== false) {
        try { subsRestoreBaseline({ focus: false }); } catch (e) {}
      }
      return ok;
    }

    function subsRestoreBaseline(options) {
      const opts = (options && typeof options === 'object') ? options : {};
      const baseline = _subscriptionBaseline && typeof _subscriptionBaseline === 'object'
        ? _subscriptionBaseline
        : null;
      const refreshNow = !!($(SUB_IDS.refreshNow) && $(SUB_IDS.refreshNow).checked);

      if (baseline && baseline.id) {
        const saved = subsFindById(baseline.id);
        if (saved) {
          subsFillForm(saved, { focus: opts.focus !== false, keepRefreshNow: true });
          try { $(SUB_IDS.refreshNow).checked = refreshNow; } catch (e) {}
          return true;
        }
      }

      _subscriptionEditId = String((baseline && baseline.id) || '').trim();
      _subscriptionPreview = null;
      _subscriptionShowHidden = false;
      try { $(SUB_IDS.id).value = _subscriptionEditId; } catch (e) {}
      try { $(SUB_IDS.name).value = String((baseline && baseline.name) || ''); } catch (e) {}
      try { $(SUB_IDS.tag).value = String((baseline && baseline.tag) || ''); } catch (e) {}
      try { $(SUB_IDS.url).value = String((baseline && baseline.url) || ''); } catch (e) {}
      try { $(SUB_IDS.nameFilter).value = String((baseline && baseline.name_filter) || ''); } catch (e) {}
      try { $(SUB_IDS.typeFilter).value = String((baseline && baseline.type_filter) || ''); } catch (e) {}
      try { $(SUB_IDS.transportFilter).value = String((baseline && baseline.transport_filter) || ''); } catch (e) {}
      subsSetExcludedKeysValue(Array.isArray(baseline && baseline.excluded_node_keys) ? baseline.excluded_node_keys : []);
      try { $(SUB_IDS.interval).value = String((baseline && baseline.interval_raw) || SUB_DEFAULT_INTERVAL_HOURS); } catch (e) {}
      try { $(SUB_IDS.enabled).checked = baseline ? !!baseline.enabled : true; } catch (e) {}
      try { $(SUB_IDS.ping).checked = baseline ? !!baseline.ping_enabled : true; } catch (e) {}
      try { $(SUB_IDS.routingMode).value = String((baseline && baseline.routing_mode) || 'safe-fallback') || 'safe-fallback'; } catch (e) {}
      try { $(SUB_IDS.routingAutoRule).checked = baseline ? baseline.routing_auto_rule !== false : true; } catch (e) {}
      try { subsRenderRoutingBalancers(baseline && baseline.routing_balancer_tags); } catch (e) {}
      try { subsSetSelectedBalancerTags(baseline && baseline.routing_balancer_tags); } catch (e) {}
      try { $(SUB_IDS.refreshNow).checked = refreshNow; } catch (e) {}
      try { if (opts.focus !== false) $(SUB_IDS.url).focus(); } catch (e) {}
      try { subsSyncSelection(); } catch (e) {}
      try { subsRenderNodeList(); } catch (e) {}
      try { subsRenderDiagnostics(); } catch (e2) {}
      try { subsSyncSubscriptionFormState(); } catch (e3) {}
      return true;
    }

    function subsBuildPayload(formState) {
      const state = (formState && typeof formState === 'object') ? formState : subsReadFormState();
      return {
        id: state.id,
        name: state.name,
        tag: state.tag,
        url: state.url,
        name_filter: state.name_filter,
        type_filter: state.type_filter,
        transport_filter: state.transport_filter,
        routing_mode: state.routing_mode,
        routing_auto_rule: !!state.routing_auto_rule,
        routing_balancer_tags: state.routing_balancer_tags.slice(),
        excluded_node_keys: state.excluded_node_keys.slice(),
        interval_hours: Number(state.interval_raw || SUB_DEFAULT_INTERVAL_HOURS),
        enabled: !!state.enabled,
        ping_enabled: !!state.ping_enabled,
      };
    }

    function subsDecorateActionButtons(modal) {
      const root = modal || $(SUB_IDS.modal);
      if (!root || !root.querySelector) return;
      try {
        const resetBtn = root.querySelector(`#${SUB_IDS.reset}`);
        if (resetBtn) {
          resetBtn.classList.add('xk-sub-head-chip');
          resetBtn.setAttribute('aria-label', String(resetBtn.getAttribute('title') || 'Очистить форму'));
          resetBtn.innerHTML = '<span class="xk-sub-head-chip-glyph" aria-hidden="true">&#8634;</span><span class="xk-visually-hidden">Очистить форму</span>';
        }
        const saveBtn = root.querySelector(`#${SUB_IDS.save}`);
        if (saveBtn) {
          saveBtn.classList.add('xk-sub-head-chip', 'is-primary');
          saveBtn.setAttribute('aria-label', String(saveBtn.getAttribute('title') || 'Сохранить настройки'));
          saveBtn.innerHTML = '<span class="xk-sub-head-chip-glyph" aria-hidden="true">&#128190;</span><span class="xk-visually-hidden">Сохранить настройки</span>';
        }
        const previewBtn = root.querySelector(`#${SUB_IDS.preview}`);
        if (previewBtn) {
          previewBtn.classList.add('xk-sub-head-chip');
          previewBtn.setAttribute('aria-label', String(previewBtn.getAttribute('title') || 'Скачать подписку'));
          previewBtn.innerHTML = '<span class="xk-sub-head-chip-glyph" aria-hidden="true">&#128065;</span><span class="xk-visually-hidden">Скачать подписку</span>';
        }
      } catch (e) {}
    }

    function subsPingAllTooltipText(sub, hasPingable) {
      if (_subscriptionPingAllBusy) {
        return 'Идёт проверка задержки для активных узлов этой подписки.';
      }
      if (!sub) {
        return 'Сначала выбери подписку в списке справа, чтобы увидеть её узлы и запустить массовую проверку задержки.';
      }
      if (hasPingable) {
        return 'Запустить проверку задержки для всех активных узлов, входящих в generated fragment.';
      }
      return 'Нет активных узлов в generated fragment. Сначала обнови подписку кнопкой ↻ в списке справа или сохрани её с флагом «Обновить сразу». Поле Tag prefix задаёт только префикс, а сами generated tags назначаются узлам автоматически после обновления подписки.';
    }

    function subsEnsureModal() {
      let modal = $(SUB_IDS.modal);
      if (modal) {
        try { subsDecorateActionButtons(modal); } catch (e0) {}
        return modal;
      }
      if (!document.body) return null;

      document.body.insertAdjacentHTML('beforeend', `
        <div id="outbounds-subscriptions-modal" class="modal hidden" data-modal-key="outbounds-subscriptions-v1" data-modal-remember="0" data-modal-nopos="1" data-modal-nodrag="1" role="dialog" aria-modal="true" aria-label="Подписки Xray">
          <div class="modal-content xk-sub-modal" data-modal-key="outbounds-subscriptions-v1-content">
            <div class="modal-header xk-sub-header">
              <div class="xk-sub-titleblock">
                <span class="modal-title">Подписки Xray</span>
                <span class="xk-sub-subtitle">Автообновление generated outbounds и observatory.</span>
                <span class="xk-sub-interval-note">Интервал: по умолчанию 24 ч; рекомендация провайдера не перезаписывает выбранное значение.</span>
              </div>
              <button type="button" class="modal-close" id="outbounds-subscriptions-close-btn" title="Закрыть" data-tooltip="Закрыть окно подписок.">×</button>
            </div>
            <div class="modal-body">
              <div class="xk-sub-brief">
                <div class="xk-sub-brief-main">
                  <div class="xk-sub-brief-title">LeastPing и generated fragments</div>
                  <div class="xk-sub-brief-text">Подписка создаёт отдельный <code>04_outbounds.&lt;tag&gt;.json</code>, использует <code>Tag prefix</code> как <code>selector</code>-префикс для leastPing и при включённом «Пинг» добавляет generated tags в <code>07_observatory.json</code>. Режим <b>Применение</b> управляет только синхронизацией routing с пулом.</div>
                </div>
                <div class="xk-sub-update-note">
                  <div class="xk-sub-update-title">Автообновление</div>
                  <div class="xk-sub-update-text">Интервал задаётся в форме ниже. <b>Обновить due</b> запускает только просроченные подписки, а <b>Обновить сразу</b> скачивает узлы и создаёт fragment после сохранения.</div>
                </div>
              </div>
              <div class="xk-sub-grid">
                <section class="xk-sub-panel xk-sub-form-panel">
                  <div class="xk-sub-panelhead xk-sub-form-head">
                    <div>
                      <div class="xk-pool-kicker">Источник</div>
                      <div class="terminal-menu-title" style="margin:0;">HTTP(S) subscription</div>
                    </div>
                  </div>
                  <form id="outbounds-subscriptions-form" class="xk-sub-form">
                    <input id="outbounds-subscriptions-id" type="hidden">
                    <input id="outbounds-subscriptions-excluded-keys" type="hidden">
                    <label class="xk-sub-span-5" data-tooltip="Короткое имя подписки в списке. Можно оставить пустым: при сохранении панель сгенерирует его автоматически.">
                      <span class="xk-pool-fieldlabel">Название</span>
                      <input id="outbounds-subscriptions-name" class="xray-log-filter" type="text" placeholder="My subscription" title="Название подписки" data-tooltip="Короткое имя подписки в списке. Если оставить поле пустым, имя будет сгенерировано автоматически при сохранении.">
                      <span id="outbounds-subscriptions-name-note" class="xk-sub-field-note" hidden></span>
                    </label>
                    <label class="xk-sub-span-4" data-tooltip="Префикс для generated outbound tags, например sub--node. Его удобно выбирать в LeastPing. Можно оставить пустым: при сохранении панель сгенерирует его автоматически.">
                      <span class="xk-pool-fieldlabel">Tag prefix</span>
                      <input id="outbounds-subscriptions-tag" class="xray-log-filter" type="text" placeholder="sub" title="Tag prefix" data-tooltip="Префикс для generated outbound tags. Используй его в selector/balancer LeastPing. Если оставить поле пустым, префикс будет сгенерирован автоматически при сохранении.">
                      <span id="outbounds-subscriptions-tag-note" class="xk-sub-field-note" hidden></span>
                    </label>
                    <label class="xk-sub-span-3 xk-sub-interval-field" data-tooltip="Локальный интервал автообновления. По умолчанию 24 часа; серверный profile-update-interval показывается как рекомендация и не перезаписывает это поле.">
                      <span class="xk-pool-fieldlabel">Обновлять, ч</span>
                      <div class="xk-sub-interval-inline">
                        <input id="outbounds-subscriptions-interval" class="xray-log-filter" type="number" min="1" max="168" step="1" value="${SUB_DEFAULT_INTERVAL_HOURS}" title="Интервал обновления" data-tooltip="Как часто панель будет обновлять подписку: от 1 до 168 часов. Рекомендация провайдера не меняет выбранное значение.">
                        <button type="button" id="outbounds-subscriptions-interval-apply-btn" class="btn-secondary btn-compact xk-sub-interval-apply" hidden></button>
                      </div>
                      <div class="xk-sub-interval-meta">
                        <span id="outbounds-subscriptions-interval-note" class="xk-sub-field-note xk-sub-interval-note-inline" hidden></span>
                      </div>
                    </label>
                    <div class="xk-sub-wide xk-sub-url-row">
                      <label class="xk-sub-url-field" data-tooltip="HTTP(S) URL подписки. Поддерживаются share-ссылки, base64 и Xray JSON outbounds.">
                        <span class="xk-pool-fieldlabel">URL</span>
                        <input id="outbounds-subscriptions-url" class="xray-log-filter" type="url" placeholder="https://..." title="URL подписки" data-tooltip="Вставь HTTP(S) URL подписки. Панель скачает nodes и создаст отдельный outbounds-фрагмент.">
                        <span id="outbounds-subscriptions-url-note" class="xk-sub-field-note" hidden></span>
                      </label>
                      <div class="xk-sub-url-action">
                        <span class="xk-pool-fieldlabel xk-sub-url-action-label" aria-hidden="true">Действия</span>
                        <div class="xk-sub-url-actions">
                          <button type="button" id="outbounds-subscriptions-preview-btn" class="btn-secondary btn-compact xk-sub-url-preview" title="Скачать подписку (предпросмотр)" data-tooltip="Скачать подписку и показать узлы в карточке справа без сохранения и без перезапуска xkeen. Используй фильтры и × у узла, чтобы исключить лишние, потом нажми «Сохранить».">Скачать подписку</button>
                          <button type="button" id="outbounds-subscriptions-reset-btn" class="btn-secondary btn-compact" title="Очистить форму" data-tooltip="Очистить форму и подготовить новую подписку.">Очистить</button>
                          <button type="submit" form="outbounds-subscriptions-form" id="outbounds-subscriptions-save-btn" class="btn-primary btn-compact" title="Сохранить настройки" data-tooltip="Сохранить настройки подписки. Если включено «Обновить сразу», фрагмент будет создан немедленно.">Сохранить</button>
                        </div>
                      </div>
                    </div>
                    <label class="xk-sub-filter-field xk-sub-span-4" data-tooltip="Regex по имени ноды из подписки. Например: Germany|Netherlands|SG. Пусто — без фильтра.">
                      <span class="xk-pool-fieldlabel">Имя</span>
                      <input id="outbounds-subscriptions-name-filter" class="xray-log-filter" type="text" placeholder="Germany|Netherlands|SG" title="Фильтр имени" data-tooltip="Оставить только ноды, чьё имя совпадает с regex. Например: Germany|Netherlands|SG.">
                      <span id="outbounds-subscriptions-name-filter-note" class="xk-sub-field-note" hidden></span>
                    </label>
                    <label class="xk-sub-filter-field xk-sub-span-4" data-tooltip="Regex по типу прокси/протоколу. Например: vless|trojan|vmess. Пусто — без фильтра.">
                      <span class="xk-pool-fieldlabel">Тип</span>
                      <input id="outbounds-subscriptions-type-filter" class="xray-log-filter" type="text" placeholder="vless|trojan|vmess" title="Фильтр типа" data-tooltip="Оставить только указанные типы нод. Например: vless|trojan|vmess|ss|hy2.">
                      <span id="outbounds-subscriptions-type-filter-note" class="xk-sub-field-note" hidden></span>
                    </label>
                    <label class="xk-sub-filter-field xk-sub-span-4" data-tooltip="Regex по транспорту. Например: ws|grpc|tcp|xhttp. Пусто — без фильтра.">
                      <span class="xk-pool-fieldlabel">Транспорт</span>
                      <input id="outbounds-subscriptions-transport-filter" class="xray-log-filter" type="text" placeholder="ws|grpc|tcp|xhttp" title="Фильтр транспорта" data-tooltip="Оставить только ноды с нужным transport/network. Например: ws|grpc|tcp|xhttp|quic.">
                      <span id="outbounds-subscriptions-transport-filter-note" class="xk-sub-field-note" hidden></span>
                    </label>
                    <div class="xk-sub-controls">
                      <div class="xk-sub-options">
                        <label class="xk-sub-check" data-tooltip="Включить плановое автообновление этой подписки."><input id="outbounds-subscriptions-enabled" type="checkbox" checked title="Автообновление" data-tooltip="Включить плановое автообновление этой подписки."><span>Авто</span></label>
                        <label class="xk-sub-check" data-tooltip="Добавлять generated tags в observatory для leastPing-проверок."><input id="outbounds-subscriptions-ping" type="checkbox" checked title="Пинг observatory" data-tooltip="Добавлять generated outbound tags в 07_observatory.json для LeastPing."><span>Пинг</span></label>
                        <label class="xk-sub-check" data-tooltip="После сохранения сразу скачать подписку и создать фрагмент."><input id="outbounds-subscriptions-refresh-now" type="checkbox" checked title="Обновить сразу" data-tooltip="Сразу скачать подписку после сохранения."><span>Обновить сразу</span></label>
                      </div>
                      <label class="xk-sub-routing-mode" for="outbounds-subscriptions-routing-mode" data-tooltip="Как панель должна подвязывать подписку к маршрутизации. Безопасно: selector/fallback leastPing синхронизируются, а явные правила на vless-reality сохраняются. Жёстко: auto-правила с outboundTag=vless-reality автоматически переводятся на общий balancerTag пула.">
                        <span class="xk-sub-inline-label">Применение</span>
                        <select id="outbounds-subscriptions-routing-mode" class="xray-log-filter" title="Режим маршрутизации подписки" data-tooltip="Безопасно: leastPing-balancer и fallback синхронизируются, но явные правила на vless-reality остаются. Жёстко: auto-правила на vless-reality переезжают в balancerTag пула.">
                          <option value="safe-fallback">Безопасно</option>
                          <option value="migrate-vless-rules">Жёстко · pool</option>
                        </select>
                      </label>
                      <label class="xk-sub-check xk-sub-auto-rule-check" data-tooltip="Добавлять tag prefix этой подписки в общий auto-managed leastPing pool и держать служебное правило xk_auto_leastPing. Выключи, если подписка должна работать только через выбранные ниже balancer-ы.">
                        <input id="outbounds-subscriptions-routing-auto-rule" type="checkbox" checked title="Общий leastPing pool" data-tooltip="Добавлять tag prefix этой подписки в общий auto-managed leastPing pool.">
                        <span>Общий pool</span>
                      </label>
                    </div>
                    <div class="xk-sub-balancers">
                      <div class="xk-sub-balancers-head">
                        <span class="xk-pool-fieldlabel">Balancer selectors</span>
                        <span id="outbounds-subscriptions-routing-balancers-note" class="xk-sub-field-note xk-sub-balancers-note" hidden></span>
                      </div>
                      <div id="outbounds-subscriptions-routing-balancers" class="xk-sub-balancers-list"></div>
                    </div>
                  </form>
                </section>

                <section class="xk-sub-panel xk-sub-list-panel">
                  <div class="xk-sub-panelhead">
                    <div>
                      <div class="xk-pool-kicker">Список</div>
                      <div class="terminal-menu-title" style="margin:0;">Сгенерированные фрагменты</div>
                    </div>
                    <div id="outbounds-subscriptions-summary" class="xk-pool-summary">0</div>
                  </div>
                  <div class="xk-sub-toolbar">
                    <button type="button" id="outbounds-subscriptions-refresh-due-btn" class="btn-secondary btn-compact" title="Обновить due" data-tooltip="Обновить все подписки, у которых уже наступило время next update.">Обновить due</button>
                  </div>
                  <div class="xk-sub-tablewrap">
                    <table class="xk-pool-table xk-sub-table">
                      <thead>
                        <tr>
                          <th>Tag</th>
                          <th>Статус</th>
                          <th>Файл</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody id="outbounds-subscriptions-tbody"></tbody>
                    </table>
                    <div id="outbounds-subscriptions-empty" class="xk-pool-empty">Подписок пока нет.</div>
                  </div>
                  <div id="outbounds-subscriptions-diagnostics" class="xk-sub-diagnostics">
                    <div class="xk-sub-diag-head">
                      <div>
                        <div class="xk-pool-kicker">Диагностика</div>
                        <div id="outbounds-subscriptions-diagnostics-title" class="terminal-menu-title" style="margin:0;">Выбери подписку</div>
                      </div>
                      <div id="outbounds-subscriptions-diagnostics-pills" class="xk-sub-diag-pills"></div>
                    </div>
                    <div id="outbounds-subscriptions-diagnostics-body" class="xk-sub-diag-body">
                      <div class="xk-sub-diag-empty">Выбери подписку справа, чтобы увидеть полный текст ошибки refresh, warnings транспорта и ошибки узлов.</div>
                    </div>
                  </div>
                  <div id="outbounds-subscriptions-status" class="modal-hint xk-sub-status"></div>
                </section>
              </div>
              <section id="outbounds-subscriptions-nodes-panel" class="xk-sub-panel xk-sub-node-panel">
                <div class="xk-sub-panelhead">
                  <div>
                    <div class="xk-pool-kicker">Узлы<span id="outbounds-subscriptions-nodes-draft" class="xk-sub-draft-badge" hidden>Черновик · нажми «Сохранить»</span></div>
                    <div class="terminal-menu-title" style="margin:0;">Серверы подписки</div>
                    <div id="outbounds-subscriptions-nodes-caption" class="xk-sub-muted">Нажми ✎ у нужной подписки, чтобы посмотреть состав и transport.</div>
                  </div>
                  <div class="xk-sub-nodes-head-actions">
                    <button type="button" id="outbounds-subscriptions-nodes-show-hidden" class="btn-secondary btn-compact xk-sub-show-hidden-btn" title="Показать скрытые узлы" data-tooltip="Показать узлы, которые сейчас скрыты фильтрами или исключены кнопкой ×. Нажми ещё раз, чтобы снова скрыть их." hidden>Показать скрытые</button>
                    <button type="button" id="outbounds-subscriptions-nodes-pingall" class="btn-secondary btn-compact xk-sub-icon-btn" title="Пинг всех узлов" data-tooltip="Запустить проверку задержки для всех активных узлов, входящих в generated fragment." aria-label="Пинг всех узлов" disabled>
                      <span class="xk-sub-icon-glyph xk-sub-pingall-glyph" aria-hidden="true">⏱</span>
                      <span class="xk-sub-pingall-spinner" aria-hidden="true"></span>
                      <span class="xk-visually-hidden">Запустить проверку задержки для всех активных узлов</span>
                    </button>
                    <div id="outbounds-subscriptions-nodes-summary" class="xk-pool-summary">0</div>
                  </div>
                </div>
                <div id="outbounds-subscriptions-nodes-list" class="xk-sub-node-list"></div>
                <div id="outbounds-subscriptions-nodes-empty" class="xk-pool-empty">Список узлов появится после обновления подписки.</div>
              </section>
            </div>
            <div class="modal-actions xk-pool-footer">
              <div></div>
              <div class="xk-pool-footer-actions">
                <button type="button" id="outbounds-subscriptions-cancel-btn" class="btn-compact" title="Закрыть" data-tooltip="Закрыть окно подписок.">Закрыть</button>
              </div>
            </div>
          </div>
        </div>
      `);

      modal = $(SUB_IDS.modal);
      try {
        if (modal && modal.dataset) {
          delete modal.dataset.modalRemember;
          delete modal.dataset.modalNopos;
          delete modal.dataset.modalNodrag;
        }
      } catch (e) {}
      try { subsDecorateActionButtons(modal); } catch (e2) {}
      try { subsRenderRoutingBalancers([]); } catch (e3) {}
      return modal;
    }

    function subsSyncModalLayout() {
      const modal = $(SUB_IDS.modal);
      const content = modal && modal.querySelector ? modal.querySelector('.modal-content') : null;
      if (!modal || !content) return;

      let viewportWidth = 0;
      try {
        viewportWidth = Math.max(
          Number(window.innerWidth || 0),
          Number(document.documentElement && document.documentElement.clientWidth ? document.documentElement.clientWidth : 0)
        );
      } catch (e0) {}

      let width = 0;
      try {
        width = Number(content.getBoundingClientRect ? content.getBoundingClientRect().width : 0);
      } catch (e) {}
      if (!Number.isFinite(width) || width <= 0) {
        try { width = Number(content.offsetWidth || 0); } catch (e2) {}
      }
      const isUserSized = !!(content.dataset && content.dataset.xkDragged === '1');
      const maxReadableWidth = viewportWidth > 0
        ? Math.max(760, Math.min(1080, viewportWidth - 20))
        : 1080;
      const maxViewportWidth = viewportWidth > 0
        ? Math.max(760, viewportWidth - 20)
        : maxReadableWidth;
      const clampWidth = isUserSized ? maxViewportWidth : maxReadableWidth;
      if (width > clampWidth + 1) {
        try {
          content.style.width = `${Math.round(clampWidth)}px`;
          content.style.maxWidth = `${Math.round(clampWidth)}px`;
        } catch (e3) {}
        if (viewportWidth > 0) {
          try {
            const currentLeft = Number.parseFloat(content.style.left || '');
            if (Number.isFinite(currentLeft)) {
              const maxLeft = Math.max(10, viewportWidth - clampWidth - 10);
              if (currentLeft > maxLeft) content.style.left = `${Math.round(maxLeft)}px`;
            }
          } catch (e4) {}
        }
        width = clampWidth;
      }
      const compact = width > 0 ? width < 900 : false;
      const narrow = width > 0 ? width < 720 : false;
      try {
        content.classList.toggle('xk-sub-modal-compact', compact);
        content.classList.toggle('xk-sub-modal-narrow', narrow);
      } catch (e5) {}
    }

    function subsShow(show) {
      const modal = subsEnsureModal();
      if (!modal) return;
      try {
        if (show) modal.classList.remove('hidden');
        else modal.classList.add('hidden');
      } catch (e) {}
      if (show) {
        const apply = () => {
          try { subsSyncModalLayout(); } catch (e2) {}
        };
        try {
          requestAnimationFrame(() => requestAnimationFrame(apply));
        } catch (e3) {
          apply();
        }
      }
      try { syncXkeenBodyScrollLock(!!show); } catch (e2) {}
    }

    function subsSetStatus(msg, isErr, isOk) {
      const el = $(SUB_IDS.status);
      if (!el) return;
      try {
        el.textContent = String(msg || '');
        el.classList.toggle('is-error', !!isErr);
        el.classList.toggle('is-success', !isErr && !!isOk);
      } catch (e) {}
    }

    function subsFormatTime(ts) {
      const n = Number(ts || 0);
      if (!Number.isFinite(n) || n <= 0) return '—';
      try {
        return new Date(n * 1000).toLocaleString();
      } catch (e) {
        return String(Math.round(n));
      }
    }

    function subsFormatClockTime(ts) {
      const n = Number(ts || 0);
      if (!Number.isFinite(n) || n <= 0) return '—';
      try {
        return new Date(n * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      } catch (e) {
        return subsFormatTime(ts);
      }
    }

    function subsNodePingStateKey(subId, nodeKey) {
      return String(subId || '') + '::' + String(nodeKey || '');
    }

    function subsNodeLatencyMap(sub) {
      const raw = sub && typeof sub === 'object' ? sub.node_latency : null;
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    }

    function subsNodeLatencyEntry(sub, nodeKey) {
      const key = String(nodeKey || '').trim();
      if (!key) return null;
      const map = subsNodeLatencyMap(sub);
      const entry = map[key];
      return entry && typeof entry === 'object' ? entry : null;
    }

    function subsNodeLatencyTone(entry, pending, canPing) {
      if (pending) return 'is-pending';
      if (!canPing) return 'is-unavailable';
      const hasDelay = !!(entry && entry.delay_ms != null && entry.delay_ms !== '');
      const delay = hasDelay ? Number(entry.delay_ms) : NaN;
      const status = String(entry && entry.status || '').trim().toLowerCase();
      if (status === 'error') return 'is-error';
      if (Number.isFinite(delay) && delay >= 0) {
        if (delay <= 250) return 'is-fast';
        if (delay <= 700) return 'is-mid';
        return 'is-slow';
      }
      return 'is-idle';
    }

    function subsNodeLatencyLabel(entry, pending, canPing) {
      if (pending) return '…';
      if (!canPing) return 'n/a';
      const hasDelay = !!(entry && entry.delay_ms != null && entry.delay_ms !== '');
      const delay = hasDelay ? Number(entry.delay_ms) : NaN;
      if (Number.isFinite(delay) && delay >= 0) return `${Math.round(delay)} ms`;
      const status = String(entry && entry.status || '').trim().toLowerCase();
      if (status === 'error') return 'fail';
      return '—';
    }

    function subsNodeLatencyTooltip(entry, pending, canPing) {
      if (pending) return 'Проверяю задержку узла через текущий generated fragment…';
      if (!canPing) return 'Узел сейчас не входит в generated fragment, поэтому проверка задержки недоступна.';
      const parts = [];
      const hasDelay = !!(entry && entry.delay_ms != null && entry.delay_ms !== '');
      const delay = hasDelay ? Number(entry.delay_ms) : NaN;
      const checkedAt = Number(entry && entry.checked_at);
      const status = String(entry && entry.status || '').trim().toLowerCase();
      const error = String(entry && entry.error || '').trim();
      const probeUrl = String(entry && entry.probe_url || '').trim();
      if (Number.isFinite(delay) && delay >= 0) {
        parts.push(`Последняя задержка: ${Math.round(delay)} ms`);
      } else if (status === 'error' && error) {
        parts.push(`Последняя проверка: ${error}`);
      } else {
        parts.push('Пока нет данных по задержке.');
      }
      if (Number.isFinite(checkedAt) && checkedAt > 0) {
        parts.push(`Проверено: ${subsFormatTime(checkedAt)}`);
      }
      if (probeUrl) {
        parts.push(`Probe URL: ${probeUrl}`);
      }
      const history = Array.isArray(entry && entry.history) ? entry.history : [];
      if (history.length) {
        const rows = history.slice(0, 5).map((item) => {
          const rowDelay = Number(item && item.delay_ms);
          const rowStatus = String(item && item.status || '').trim().toLowerCase();
          const rowError = String(item && item.error || '').trim();
          const rowChecked = subsFormatClockTime(item && item.checked_at);
          const rowValue = Number.isFinite(rowDelay) && rowDelay >= 0
            ? `${Math.round(rowDelay)} ms`
            : (rowStatus === 'error' && rowError ? rowError : rowStatus || '—');
          return `${rowChecked} · ${rowValue}`;
        });
        parts.push(`История:\n${rows.join('\n')}`);
      } else {
        parts.push('Нажми кнопку рядом, чтобы выполнить проверку.');
      }
      return parts.join('\n');
    }

    function subsShortUrl(url) {
      const raw = String(url || '');
      if (!raw) return '';
      try {
        const u = new URL(raw);
        const path = String(u.pathname || '').replace(/\/+$/g, '');
        return u.hostname + (path ? path.slice(0, 28) : '');
      } catch (e) {}
      return raw.length > 42 ? raw.slice(0, 39) + '…' : raw;
    }

    function subsGeneratedFilePath(file) {
      const name = String(file || '').trim();
      if (!name) return '';
      const dir = String(_fragmentDir || '/opt/etc/xray/configs').replace(/\/+$/g, '');
      return dir + '/' + name;
    }

    function subsParseExcludedKeys(raw) {
      const text = String(raw || '').trim();
      if (!text) return [];
      try {
        const parsed = JSON.parse(text);
        return Array.isArray(parsed)
          ? Array.from(new Set(parsed.map((item) => String(item || '').trim()).filter(Boolean)))
          : [];
      } catch (e) {
        return [];
      }
    }

    function subsGetExcludedKeysValue() {
      try {
        return subsParseExcludedKeys($(SUB_IDS.excludedKeys).value);
      } catch (e) {
        return [];
      }
    }

    function subsSetExcludedKeysValue(items) {
      const values = Array.from(new Set((Array.isArray(items) ? items : []).map((item) => String(item || '').trim()).filter(Boolean)));
      try { $(SUB_IDS.excludedKeys).value = JSON.stringify(values); } catch (e) {}
      return values;
    }

    function subsCompilePreviewRegex(id) {
      const el = $(id);
      if (!el) return null;
      const raw = String(el.value || '').trim();
      try { el.classList.remove('is-invalid'); } catch (e) {}
      if (!raw) return null;
      try {
        return new RegExp(raw, 'i');
      } catch (e) {
        try { el.classList.add('is-invalid'); } catch (e2) {}
        return null;
      }
    }

    function subsSafeRegExp(raw) {
      const text = String(raw || '').trim();
      if (!text) return null;
      try {
        return new RegExp(text, 'i');
      } catch (e) {
        return null;
      }
    }

    function subsCurrentDraftFor(sub) {
      const s = sub && typeof sub === 'object' ? sub : {};
      const currentId = String(_subscriptionEditId || '');
      const subId = String(s.id || '');
      // Match by id when both are non-empty. Also treat the preview/draft case
      // (both ids empty + an active preview) as "current" so the form's live
      // filters and the hidden excluded-keys input drive what's rendered.
      const isCurrent = currentId === subId && (currentId !== '' || !!_subscriptionPreview);
      return {
        nameFilter: isCurrent ? String(($(SUB_IDS.nameFilter) && $(SUB_IDS.nameFilter).value) || '').trim() : String(s.name_filter || '').trim(),
        typeFilter: isCurrent ? String(($(SUB_IDS.typeFilter) && $(SUB_IDS.typeFilter).value) || '').trim() : String(s.type_filter || '').trim(),
        transportFilter: isCurrent ? String(($(SUB_IDS.transportFilter) && $(SUB_IDS.transportFilter).value) || '').trim() : String(s.transport_filter || '').trim(),
        excludedKeys: isCurrent ? subsGetExcludedKeysValue() : (Array.isArray(s.excluded_node_keys) ? s.excluded_node_keys.map((item) => String(item || '').trim()).filter(Boolean) : []),
      };
    }

    function subsProtocolFilterText(protocol) {
      const value = String(protocol || '').trim().toLowerCase();
      if (value === 'ss') return 'ss shadowsocks';
      if (value === 'shadowsocks') return 'ss shadowsocks';
      if (value === 'hy2' || value === 'hysteria2' || value === 'hysteria') return 'hy2 hysteria2 hysteria';
      return value;
    }

    function subsTransportFilterText(transport, protocol) {
      const items = [String(transport || '').trim().toLowerCase()];
      const proto = String(protocol || '').trim().toLowerCase();
      if (proto === 'hy2' || proto === 'hysteria2' || proto === 'hysteria') {
        items.push('quic');
        items.push('udp');
      }
      return Array.from(new Set(items.filter(Boolean))).join(' ');
    }

    function subsDeprecatedTransportNote(transport, enabled) {
      const value = String(transport || '').trim().toLowerCase();
      if (value !== 'grpc') return '';
      if (enabled) {
        return 'Xray считает gRPC transport устаревшим и рекомендует XHTTP (stream-up H2).';
      }
      return 'Если этот узел войдёт в generated fragment, Xray предупредит, что gRPC transport устарел, и порекомендует XHTTP.';
    }

    function subsSyncSelection() {
      const tbody = $(SUB_IDS.tbody);
      if (!tbody) return;
      Array.from(tbody.querySelectorAll('tr[data-sub-id]')).forEach((row) => {
        row.classList.toggle('is-selected', String(row.getAttribute('data-sub-id') || '') === String(_subscriptionEditId || ''));
      });
    }

    function subsNodeReasonCodes(node, draft, compiled) {
      const reasons = [];
      const excluded = new Set(Array.isArray(draft && draft.excludedKeys) ? draft.excludedKeys : []);
      const key = String(node && node.key ? node.key : '').trim();
      const name = String(node && node.name ? node.name : '').trim();
      const protocol = String(node && node.protocol ? node.protocol : '').trim().toLowerCase();
      const transport = String(node && node.transport ? node.transport : '').trim().toLowerCase();
      if (key && excluded.has(key)) reasons.push('manual');
      if (compiled && compiled.name && !compiled.name.test(name)) reasons.push('name');
      if (compiled && compiled.type && !compiled.type.test(subsProtocolFilterText(protocol))) reasons.push('type');
      if (compiled && compiled.transport && !compiled.transport.test(subsTransportFilterText(transport, protocol))) reasons.push('transport');
      return reasons;
    }

    function subsNodeReasonLabel(reasons) {
      const list = Array.isArray(reasons) ? reasons : [];
      if (!list.length) return 'включён';
      if (list.includes('manual')) return 'исключён вручную';
      if (list.includes('transport')) return 'скрыт фильтром transport';
      if (list.includes('type')) return 'скрыт фильтром type';
      if (list.includes('name')) return 'скрыт фильтром имени';
      return 'скрыт фильтром';
    }

    function subsFilterSummary(sub) {
      const s = sub && typeof sub === 'object' ? sub : {};
      const parts = [];
      const nameFilter = String(s.name_filter || '').trim();
      const typeFilter = String(s.type_filter || '').trim();
      const transportFilter = String(s.transport_filter || '').trim();
      if (nameFilter) parts.push('имя~' + nameFilter);
      if (typeFilter) parts.push('тип~' + typeFilter);
      if (transportFilter) parts.push('transport~' + transportFilter);
      return parts.join(' · ');
    }

    function subsIntervalSummary(sub) {
      const s = sub && typeof sub === 'object' ? sub : {};
      const interval = Number(s.interval_hours || SUB_DEFAULT_INTERVAL_HOURS);
      const profileInterval = Number(s.profile_update_interval_hours || 0);
      const safeInterval = Number.isFinite(interval) && interval > 0 ? interval : SUB_DEFAULT_INTERVAL_HOURS;
      const parts = [`каждые ${safeInterval} ч`];
      if (Number.isFinite(profileInterval) && profileInterval > 0 && profileInterval !== safeInterval) {
        parts.push(`провайдер советует ${profileInterval} ч`);
      }
      return parts.join(' · ');
    }

    function subsTimestamp(value) {
      const ts = Number(value || 0);
      return Number.isFinite(ts) && ts > 0 ? ts : 0;
    }

    function subsLastUpdateTs(sub) {
      const s = sub && typeof sub === 'object' ? sub : {};
      return subsTimestamp(s.last_update_ts || s.updated_ts);
    }

    function subsNowTs() {
      return Math.floor(Date.now() / 1000);
    }

    function subsIsDue(sub, nowTs) {
      const s = sub && typeof sub === 'object' ? sub : {};
      if (s.enabled === false) return false;
      const nextTs = subsTimestamp(s.next_update_ts);
      const currentTs = subsTimestamp(nowTs) || subsNowTs();
      return nextTs > 0 && nextTs <= currentTs;
    }

    function subsRelativeUpdateLabel(ts, nowTs) {
      const stamp = subsTimestamp(ts);
      const currentTs = subsTimestamp(nowTs) || subsNowTs();
      if (!stamp || !currentTs) return '';
      const delta = Math.max(0, currentTs - stamp);
      if (delta < 45) return 'обновлено только что';
      if (delta < 3600) return `обновлено ${Math.max(1, Math.floor(delta / 60))} мин назад`;
      if (delta < 86400) return `обновлено ${Math.max(1, Math.floor(delta / 3600))} ч назад`;
      return `обновлено ${Math.max(1, Math.floor(delta / 86400))} д назад`;
    }

    function subsOperationalRank(sub, nowTs) {
      const s = sub && typeof sub === 'object' ? sub : {};
      const hasError = s.last_ok === false;
      const due = subsIsDue(s, nowTs);
      const lastUpdateTs = subsLastUpdateTs(s);
      if (hasError && due) return 0;
      if (hasError) return 1;
      if (due) return 2;
      if (lastUpdateTs <= 0) return 3;
      return 4;
    }

    function subsCompareSubscriptions(a, b, nowTs) {
      const rankDiff = subsOperationalRank(a, nowTs) - subsOperationalRank(b, nowTs);
      if (rankDiff) return rankDiff;

      const aDue = subsIsDue(a, nowTs);
      const bDue = subsIsDue(b, nowTs);
      if (aDue || bDue) {
        const aNext = subsTimestamp(a && a.next_update_ts) || Number.MAX_SAFE_INTEGER;
        const bNext = subsTimestamp(b && b.next_update_ts) || Number.MAX_SAFE_INTEGER;
        if (aNext !== bNext) return aNext - bNext;
      }

      const updatedDiff = subsLastUpdateTs(b) - subsLastUpdateTs(a);
      if (updatedDiff) return updatedDiff;

      const aLabel = String((a && (a.tag || a.name || a.id)) || '').trim();
      const bLabel = String((b && (b.tag || b.name || b.id)) || '').trim();
      return aLabel.localeCompare(bLabel, 'ru');
    }

    function subsSortSubscriptions(items) {
      const list = Array.isArray(items) ? items.slice() : [];
      const nowTs = subsNowTs();
      return list.sort((a, b) => subsCompareSubscriptions(a, b, nowTs));
    }

    function subsBuildStatusBadges(sub, nowTs) {
      const s = sub && typeof sub === 'object' ? sub : {};
      const currentTs = subsTimestamp(nowTs) || subsNowTs();
      const badges = [];
      const lastUpdateTs = subsLastUpdateTs(s);
      const filteredOutCount = Number(s.last_filtered_out_count || 0);
      const due = subsIsDue(s, currentTs);
      const errorText = String(s.last_error || '').trim();

      if (s.last_ok === false) {
        badges.push({
          label: 'ошибка',
          tone: 'error',
          title: errorText || 'Последнее обновление завершилось ошибкой.',
        });
      }
      if (due) {
        badges.push({
          label: 'due',
          tone: 'due',
          title: s.next_update_ts
            ? `Срок обновления наступил: ${subsFormatTime(s.next_update_ts)}.`
            : 'Срок обновления наступил.',
        });
      }
      if (lastUpdateTs > 0) {
        badges.push({
          label: subsRelativeUpdateLabel(lastUpdateTs, currentTs),
          tone: 'updated',
          title: `Последнее обновление: ${subsFormatTime(lastUpdateTs)}.`,
        });
      }
      if (Number.isFinite(filteredOutCount) && filteredOutCount > 0) {
        badges.push({
          label: `скрыто ${filteredOutCount}`,
          tone: 'filtered',
          title: `Фильтрами скрыто ${filteredOutCount} узл.`,
        });
      }
      return badges;
    }

    function subsStringList(value) {
      if (Array.isArray(value)) {
        return value.map((item) => String(item || '').trim()).filter(Boolean);
      }
      const text = String(value || '').trim();
      return text ? [text] : [];
    }

    function subsFormatResultErrors(items) {
      return (Array.isArray(items) ? items : [])
        .map((item) => {
          if (typeof item === 'string') return String(item || '').trim();
          if (!item || typeof item !== 'object') return '';
          const idx = Number(item.idx);
          const tag = String(item.tag || '').trim();
          const message = String(item.error || item.message || '').trim();
          const parts = [];
          if (Number.isFinite(idx) && idx >= 0) parts.push(`#${idx + 1}`);
          if (tag) parts.push(tag);
          const prefix = parts.join(' · ');
          if (prefix && message) return `${prefix}: ${message}`;
          return prefix || message;
        })
        .filter(Boolean);
    }

    function subsActiveDiagnosticsTarget() {
      if (_subscriptionPreview) {
        const formState = subsReadFormState();
        const resolved = subsResolveDraftDefaults(formState);
        return {
          __xkDiagnosticsKind: 'preview',
          id: String(formState.id || _subscriptionEditId || '').trim(),
          name: resolved.name || 'Черновик',
          tag: resolved.tag || '',
          url: String(formState.url || '').trim(),
          name_filter: String(formState.name_filter || '').trim(),
          type_filter: String(formState.type_filter || '').trim(),
          transport_filter: String(formState.transport_filter || '').trim(),
          excluded_node_keys: Array.isArray(formState.excluded_node_keys) ? formState.excluded_node_keys.slice() : [],
          interval_hours: subsCurrentIntervalHours(formState) || SUB_DEFAULT_INTERVAL_HOURS,
          profile_update_interval_hours: Number(_subscriptionPreview.profileUpdateIntervalHours || 0),
          last_count: Array.isArray(_subscriptionPreview.nodes) ? _subscriptionPreview.nodes.length : 0,
          last_source_count: Number(_subscriptionPreview.sourceCount || 0),
          last_filtered_out_count: Number(_subscriptionPreview.filteredOutCount || 0),
          last_warnings: Array.isArray(_subscriptionPreview.warnings) ? _subscriptionPreview.warnings.slice() : [],
          last_errors: Array.isArray(_subscriptionPreview.errors) ? _subscriptionPreview.errors.slice() : [],
          preview_ts: Number(_subscriptionPreview.ts || 0),
        };
      }
      return subsFindById(_subscriptionEditId);
    }

    function subsDiagnosticsSnapshot(sub) {
      const s = sub && typeof sub === 'object' ? sub : {};
      const kind = String(s.__xkDiagnosticsKind || 'saved').trim() || 'saved';
      const warnings = subsStringList(s.last_warnings);
      const errors = subsFormatResultErrors(s.last_errors);
      const refreshError = String(s.last_error || '').trim();
      const title = String(s.name || s.tag || s.id || (kind === 'preview' ? 'Черновик' : 'Подписка')).trim() || 'Подписка';
      const pills = [];
      if (refreshError || s.last_ok === false) pills.push({ label: 'refresh error', tone: 'error', title: refreshError || 'Последнее обновление завершилось ошибкой.' });
      if (warnings.length) pills.push({ label: `${warnings.length} warning`, tone: 'warning', title: warnings[0] });
      if (errors.length) pills.push({ label: `${errors.length} parse`, tone: 'error-list', title: errors[0] });

      return {
        kind,
        title,
        pills,
        warnings,
        errors,
        refreshError,
      };
    }

    function subsRenderDiagnostics() {
      const root = $(SUB_IDS.diagnostics);
      const titleEl = $(SUB_IDS.diagnosticsTitle);
      const pillsEl = $(SUB_IDS.diagnosticsPills);
      const bodyEl = $(SUB_IDS.diagnosticsBody);
      if (!root || !titleEl || !pillsEl || !bodyEl) return;

      const target = subsActiveDiagnosticsTarget();
      if (!target) {
        titleEl.textContent = 'Выбери подписку';
        pillsEl.innerHTML = '';
        bodyEl.innerHTML = '<div class="xk-sub-diag-empty">Выбери подписку справа, чтобы увидеть полный текст ошибки refresh, warnings транспорта и ошибки узлов.</div>';
        return;
      }

      const snapshot = subsDiagnosticsSnapshot(target);
      const title = snapshot.kind === 'preview'
        ? `${snapshot.title} · черновик`
        : snapshot.title;
      titleEl.textContent = title;
      try {
        titleEl.setAttribute('data-tooltip', title);
        titleEl.setAttribute('title', title);
      } catch (e) {}

      pillsEl.innerHTML = snapshot.pills.map((pill) => {
        const label = escapeHtml(String(pill && pill.label ? pill.label : ''));
        const tone = escapeHtml(String(pill && pill.tone ? pill.tone : 'neutral'));
        const tooltip = escapeHtml(String(pill && pill.title ? pill.title : label));
        return `<span class="xk-sub-diag-pill is-${tone}" title="${tooltip}" data-tooltip="${tooltip}">${label}</span>`;
      }).join('');

      const groups = [];

      if (snapshot.refreshError) {
        groups.push(
          `<div class="xk-sub-diag-group is-error"><div class="xk-sub-diag-label">Ошибка refresh</div><pre class="xk-sub-diag-pre">${escapeHtml(snapshot.refreshError)}</pre></div>`
        );
      }
      if (snapshot.warnings.length) {
        groups.push(
          `<div class="xk-sub-diag-group is-warning"><div class="xk-sub-diag-label">Warnings</div><ul class="xk-sub-diag-list">${snapshot.warnings.map((line) => `<li>${escapeHtml(String(line || ''))}</li>`).join('')}</ul></div>`
        );
      }
      if (snapshot.errors.length) {
        groups.push(
          `<div class="xk-sub-diag-group is-error-list"><div class="xk-sub-diag-label">Ошибки узлов</div><ul class="xk-sub-diag-list">${snapshot.errors.map((line) => `<li>${escapeHtml(String(line || ''))}</li>`).join('')}</ul></div>`
        );
      }
      if (!snapshot.refreshError && !snapshot.warnings.length && !snapshot.errors.length) {
        groups.push(
          '<div class="xk-sub-diag-empty">Последнее обновление прошло без ошибок и дополнительных предупреждений.</div>'
        );
      }

      bodyEl.innerHTML = groups.join('');
    }

    function subsResetForm() {
      _subscriptionEditId = '';
      _subscriptionPreview = null;
      _subscriptionShowHidden = false;
      try { $(SUB_IDS.id).value = ''; } catch (e) {}
      try { $(SUB_IDS.name).value = ''; } catch (e) {}
      try { $(SUB_IDS.tag).value = ''; } catch (e) {}
      try { $(SUB_IDS.url).value = ''; } catch (e) {}
      try { $(SUB_IDS.nameFilter).value = ''; } catch (e) {}
      try { $(SUB_IDS.typeFilter).value = ''; } catch (e) {}
      try { $(SUB_IDS.transportFilter).value = ''; } catch (e) {}
      subsSetExcludedKeysValue([]);
      try { $(SUB_IDS.interval).value = String(SUB_DEFAULT_INTERVAL_HOURS); } catch (e) {}
      try { $(SUB_IDS.enabled).checked = true; } catch (e) {}
      try { $(SUB_IDS.ping).checked = true; } catch (e) {}
      try { $(SUB_IDS.routingMode).value = 'safe-fallback'; } catch (e) {}
      try { $(SUB_IDS.routingAutoRule).checked = true; } catch (e) {}
      try { subsRenderRoutingBalancers([]); } catch (e) {}
      try { subsSetSelectedBalancerTags([]); } catch (e) {}
      try { $(SUB_IDS.refreshNow).checked = true; } catch (e) {}
      try { subsSyncSelection(); } catch (e2) {}
      try { subsRenderNodeList(); } catch (e2) {}
      try { subsRenderDiagnostics(); } catch (e3) {}
      try { subsCaptureBaseline(); } catch (e4) {}
      try { subsSyncSubscriptionFormState(); } catch (e5) {}
    }

    function subsFillForm(sub, options) {
      const s = sub && typeof sub === 'object' ? sub : {};
      const opts = options && typeof options === 'object' ? options : {};
      const nextId = String(s.id || '');
      if (opts.keepPreview !== true) {
        _subscriptionPreview = null;
      }
      if (nextId !== String(_subscriptionEditId || '') || opts.keepPreview !== true) {
        _subscriptionShowHidden = false;
      }
      _subscriptionEditId = nextId;
      try { $(SUB_IDS.id).value = _subscriptionEditId; } catch (e) {}
      try { $(SUB_IDS.name).value = String(s.name || ''); } catch (e) {}
      try { $(SUB_IDS.tag).value = String(s.tag || ''); } catch (e) {}
      try { $(SUB_IDS.url).value = String(s.url || ''); } catch (e) {}
      try { $(SUB_IDS.nameFilter).value = String(s.name_filter || ''); } catch (e) {}
      try { $(SUB_IDS.typeFilter).value = String(s.type_filter || ''); } catch (e) {}
      try { $(SUB_IDS.transportFilter).value = String(s.transport_filter || ''); } catch (e) {}
      subsSetExcludedKeysValue(Array.isArray(s.excluded_node_keys) ? s.excluded_node_keys : []);
      try { $(SUB_IDS.interval).value = String(s.interval_hours || SUB_DEFAULT_INTERVAL_HOURS); } catch (e) {}
      try { $(SUB_IDS.enabled).checked = s.enabled !== false; } catch (e) {}
      try { $(SUB_IDS.ping).checked = s.ping_enabled !== false; } catch (e) {}
      try { $(SUB_IDS.routingMode).value = String(s.routing_mode || 'safe-fallback') || 'safe-fallback'; } catch (e) {}
      try { $(SUB_IDS.routingAutoRule).checked = s.routing_auto_rule !== false; } catch (e) {}
      try { subsRenderRoutingBalancers(s.routing_balancer_tags); } catch (e) {}
      try { subsSetSelectedBalancerTags(s.routing_balancer_tags); } catch (e) {}
      try { $(SUB_IDS.refreshNow).checked = opts.keepRefreshNow === true ? !!($(SUB_IDS.refreshNow) && $(SUB_IDS.refreshNow).checked) : false; } catch (e) {}
      try { if (opts.focus !== false) $(SUB_IDS.url).focus(); } catch (e) {}
      try { subsSyncSelection(); } catch (e2) {}
      try { subsRenderNodeList(); } catch (e2) {}
      try { subsRenderDiagnostics(); } catch (e3) {}
      try { subsCaptureBaseline(); } catch (e4) {}
      try { subsSyncSubscriptionFormState(); } catch (e5) {}
    }

    function subsRender() {
      const tbody = $(SUB_IDS.tbody);
      const empty = $(SUB_IDS.empty);
      const summary = $(SUB_IDS.summary);
      if (!tbody) return;
      const items = subsSortSubscriptions(_subscriptions);
      const nowTs = subsNowTs();
      tbody.innerHTML = '';

      items.forEach((sub) => {
        const tr = document.createElement('tr');
        try {
          tr.setAttribute('data-sub-id', String(sub && sub.id ? sub.id : ''));
          tr.classList.toggle('is-selected', String(sub && sub.id ? sub.id : '') === String(_subscriptionEditId || ''));
        } catch (e0) {}
        const ok = sub && sub.last_ok === true;
        const bad = sub && sub.last_ok === false;
        const due = subsIsDue(sub, nowTs);
        const count = Number(sub && sub.last_count ? sub.last_count : 0);
        const rawSourceCount = Number(sub && sub.last_source_count ? sub.last_source_count : 0);
        const sourceCount = Number.isFinite(rawSourceCount) && rawSourceCount > 0 ? rawSourceCount : count;
        const filteredOutCount = Number(sub && sub.last_filtered_out_count ? sub.last_filtered_out_count : 0);
        const lastUpdateTs = subsLastUpdateTs(sub);
        const statusText = ok
          ? (`OK · ${count}` + (sourceCount > count ? ` из ${sourceCount}` : ''))
          : (bad ? 'Ошибка обновления' : (lastUpdateTs > 0 ? 'Обновление без ошибок' : 'Ожидает обновления'));
        const next = subsFormatTime(sub && sub.next_update_ts);
        const title = escapeHtml(String(sub && sub.name ? sub.name : sub && sub.id ? sub.id : ''));
        const tag = escapeHtml(String(sub && sub.tag ? sub.tag : ''));
        const url = escapeHtml(subsShortUrl(sub && sub.url));
        const filterText = escapeHtml(subsFilterSummary(sub));
        const fileRaw = String(sub && sub.output_file ? sub.output_file : '');
        const file = escapeHtml(fileRaw);
        const filePath = escapeHtml(subsGeneratedFilePath(fileRaw));
        const id = escapeHtml(String(sub && sub.id ? sub.id : ''));
        const metaBits = [];
        if (title) metaBits.push(title);
        if (url) metaBits.push(url);
        if (filterText) metaBits.push(filterText);
        const nextBits = [due ? 'next: due' : ('next: ' + next), subsIntervalSummary(sub)];
        const badges = subsBuildStatusBadges(sub, nowTs);
        const badgesHtml = badges.map((badge) => {
          const label = escapeHtml(String(badge && badge.label ? badge.label : ''));
          const tone = escapeHtml(String(badge && badge.tone ? badge.tone : 'muted'));
          const tooltip = escapeHtml(String(badge && badge.title ? badge.title : label));
          return `<span class="xk-sub-badge is-${tone}" title="${tooltip}" data-tooltip="${tooltip}">${label}</span>`;
        }).join('');
        tr.innerHTML = `
          <td>
            <div class="xk-sub-main">${tag || id}</div>
            ${badgesHtml ? `<div class="xk-sub-badges">${badgesHtml}</div>` : ''}
            <div class="xk-sub-muted">${metaBits.join(' · ')}</div>
          </td>
          <td>
            <div class="${bad ? 'xk-sub-bad' : (ok ? 'xk-sub-ok' : 'xk-sub-muted')}">${statusText}</div>
            <div class="xk-sub-muted">${escapeHtml(nextBits.join(' · '))}</div>
          </td>
          <td class="xk-sub-file-cell">
            <button
              type="button"
              class="xk-sub-file-link"
              data-file="${file}"
              title="${filePath || file}"
              data-tooltip="Открыть generated outbounds-фрагмент этой подписки."
              aria-label="Открыть generated outbounds-фрагмент"
            >
              <span class="xk-sub-file-badge">JSON</span>
              <code>${file || '—'}</code>
            </button>
          </td>
          <td class="xk-sub-row-actions">
            <button
              type="button"
              class="btn-secondary btn-compact xk-sub-list-action xk-sub-list-action-refresh xk-sub-refresh"
              data-id="${id}"
              title="Обновить"
              data-tooltip="Скачать подписку сейчас и перегенерировать outbounds-фрагмент."
              aria-label="Обновить подписку"
            >
              <span class="xk-sub-icon-glyph" aria-hidden="true">&#8635;</span>
              <span class="xk-visually-hidden">Обновить</span>
            </button>
            <button
              type="button"
              class="btn-danger btn-compact xk-sub-list-action xk-sub-list-action-delete xk-sub-delete"
              data-id="${id}"
              title="Удалить"
              data-tooltip="Удалить подписку и generated-фрагмент."
              aria-label="Удалить подписку"
            >
              <span class="xk-sub-icon-glyph" aria-hidden="true">&#215;</span>
              <span class="xk-visually-hidden">Удалить</span>
            </button>
          </td>
        `;
        tbody.appendChild(tr);
      });

      try { if (empty) empty.style.display = items.length ? 'none' : 'block'; } catch (e) {}
      try { if (summary) summary.textContent = String(items.length) + ' шт.'; } catch (e) {}

      Array.from(tbody.querySelectorAll('.xk-sub-file-link')).forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          subsOpenGeneratedFragment(btn.getAttribute('data-file') || '');
        });
      });
      Array.from(tbody.querySelectorAll('.xk-sub-refresh')).forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          subsRefresh(btn.getAttribute('data-id') || '');
        });
      });
      Array.from(tbody.querySelectorAll('.xk-sub-delete')).forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          subsDelete(btn.getAttribute('data-id') || '');
        });
      });

      Array.from(tbody.querySelectorAll('tr[data-sub-id]')).forEach((row) => {
        row.addEventListener('click', async (e) => {
          const target = e && e.target ? e.target : null;
          if (target && target.closest && target.closest('button')) return;
          const id = row.getAttribute('data-sub-id') || '';
          const sub = _subscriptions.find((item) => String(item && item.id || '') === id);
          const isCurrent = id === String(_subscriptionEditId || '');
          const ok = await subsConfirmDiscardDraft({
            message: isCurrent
              ? 'Вернуть сохранённую версию этой подписки и потерять текущий черновик?'
              : 'Открыть другую подписку и потерять текущий черновик?',
            okText: isCurrent ? 'Вернуть' : 'Открыть',
            cancelText: 'Остаться',
            restore: false,
          });
          if (!ok) return;
          if (sub) subsFillForm(sub, { focus: false, keepRefreshNow: true });
        });
      });

      try { subsRenderNodeList(); } catch (e) {}
      try { subsRenderDiagnostics(); } catch (e2) {}
    }

    function subsRenderNodeList() {
      const panel = $(SUB_IDS.nodesPanel);
      const caption = $(SUB_IDS.nodesCaption);
      const summary = $(SUB_IDS.nodesSummary);
      const listEl = $(SUB_IDS.nodesList);
      const empty = $(SUB_IDS.nodesEmpty);
      const showHiddenBtn = $(SUB_IDS.nodesShowHidden);
      if (!panel || !caption || !summary || !listEl || !empty) return;

      const subId = String(_subscriptionEditId || '').trim();
      const savedSub = _subscriptions.find((item) => String(item && item.id || '') === subId) || null;
      const preview = _subscriptionPreview;
      const isPreview = !!preview;
      const sub = savedSub
        || (isPreview ? { id: '', name: 'Черновик', tag: String(preview.tagPrefix || ''), last_nodes: preview.nodes } : null);
      if (!sub) {
        listEl.innerHTML = '';
        empty.textContent = 'Нажми «Скачать подписку» в форме слева, чтобы скачать узлы без сохранения, или выбери существующую подписку справа.';
        empty.style.display = 'block';
        summary.textContent = '0';
        caption.textContent = 'Выбери подписку или нажми «Скачать подписку».';
        if (showHiddenBtn) showHiddenBtn.hidden = true;
        return;
      }

      const nodes = isPreview ? preview.nodes : (Array.isArray(sub.last_nodes) ? sub.last_nodes : []);
      const draft = subsCurrentDraftFor(sub);
      const compiled = {
        name: subId === String(_subscriptionEditId || '') ? subsCompilePreviewRegex(SUB_IDS.nameFilter) : subsSafeRegExp(draft.nameFilter),
        type: subId === String(_subscriptionEditId || '') ? subsCompilePreviewRegex(SUB_IDS.typeFilter) : subsSafeRegExp(draft.typeFilter),
        transport: subId === String(_subscriptionEditId || '') ? subsCompilePreviewRegex(SUB_IDS.transportFilter) : subsSafeRegExp(draft.transportFilter),
      };
      const rows = [];
      let enabledCount = 0;
      let hiddenCount = 0;
      const showHidden = !!_subscriptionShowHidden;
      const excluded = new Set(Array.isArray(draft.excludedKeys) ? draft.excludedKeys : []);

      nodes.forEach((node) => {
        const reasons = subsNodeReasonCodes(node, draft, compiled);
        const enabled = reasons.length === 0;
        if (enabled) enabledCount += 1;
        else hiddenCount += 1;
        if (!enabled && !showHidden) return;
        const key = escapeHtml(String(node && node.key ? node.key : ''));
        const name = escapeHtml(String(node && node.name ? node.name : 'node'));
        const protocol = escapeHtml(String(node && node.protocol ? node.protocol : ''));
        const transport = escapeHtml(String(node && node.transport ? node.transport : ''));
        const security = escapeHtml(String(node && node.security ? node.security : ''));
        const host = escapeHtml(String(node && node.host ? node.host : ''));
        const port = escapeHtml(String(node && (node.port || node.port === 0) ? node.port : ''));
        const detail = escapeHtml(String(node && node.detail ? node.detail : ''));
        const deprecatedTransportNote = subsDeprecatedTransportNote(node && node.transport, enabled);
        const deprecatedTransportNoteHtml = escapeHtml(deprecatedTransportNote);
        const endpoint = [host, port].filter(Boolean).join(':');
        const connectionSummary = [endpoint, detail].filter(Boolean).join(' · ');
        const connectionSummaryHtml = escapeHtml(connectionSummary);
        const reasonLabel = escapeHtml(subsNodeReasonLabel(reasons));
        const manualExcluded = !!(node && node.key && excluded.has(String(node.key)));
        const nodeTag = String(node && node.tag ? node.tag : '').trim();
        const canPing = !!nodeTag && !isPreview;
        const pingStateKey = subsNodePingStateKey(subId, String(node && node.key ? node.key : ''));
        const pingBusy = !!_subscriptionNodePingState[pingStateKey];
        const latencyEntry = subsNodeLatencyEntry(sub, String(node && node.key ? node.key : ''));
        const latencyLabel = escapeHtml(subsNodeLatencyLabel(latencyEntry, pingBusy, canPing));
        const latencyTooltip = escapeHtml(subsNodeLatencyTooltip(latencyEntry, pingBusy, canPing));
        const latencyClass = subsNodeLatencyTone(latencyEntry, pingBusy, canPing);
        const toggleTitle = manualExcluded ? 'Вернуть узел' : 'Исключить узел';
        const toggleTooltip = manualExcluded
          ? 'Вернуть этот узел в generated fragment. Изменение применится после сохранения подписки.'
          : 'Исключить этот узел из generated fragment. Изменение применится после сохранения подписки.';
        const toggleClass = manualExcluded
          ? 'btn-secondary btn-compact xk-sub-node-toggle xk-sub-node-toggle-restore'
          : 'btn-danger btn-compact xk-sub-node-toggle';
        const toggleIcon = manualExcluded ? '↺' : '×';
        rows.push(`
          <div class="xk-sub-node-item ${enabled ? 'is-enabled' : 'is-disabled'}" data-node-key="${key}">
            <div class="xk-sub-node-main">
              <div class="xk-sub-node-name">${name}</div>
              <div class="xk-sub-node-meta">
                ${protocol ? `<span class="xk-sub-node-pill">${protocol}</span>` : ''}
                ${transport ? `<span class="xk-sub-node-pill xk-sub-node-pill-transport">${transport}</span>` : ''}
                ${security ? `<span class="xk-sub-node-pill xk-sub-node-pill-security">${security}</span>` : ''}
                ${deprecatedTransportNote ? `<span class="xk-sub-node-pill xk-sub-node-pill-warning" data-tooltip="${deprecatedTransportNoteHtml}">deprecated</span>` : ''}
              </div>
              ${connectionSummary ? `<div class="xk-sub-node-detail" data-tooltip="${connectionSummaryHtml}">${connectionSummaryHtml}</div>` : ''}
            </div>
            <div class="xk-sub-node-side">
              <div class="xk-sub-node-latency ${latencyClass}" data-tooltip="${latencyTooltip}">${latencyLabel}</div>
              <div class="xk-sub-node-state ${enabled ? 'is-enabled' : 'is-disabled'}">${reasonLabel}</div>
              <div class="xk-sub-node-actions">
                <button type="button" class="btn-secondary btn-compact xk-sub-node-ping ${pingBusy ? 'is-busy' : ''}" data-node-key="${key}" data-node-tag="${escapeHtml(nodeTag)}" title="Проверить задержку" data-tooltip="${escapeHtml(canPing ? 'Проверить задержку узла через текущий generated fragment.' : 'Этот узел сейчас не входит в generated fragment, поэтому проверка недоступна.')}" aria-label="Проверить задержку" ${canPing ? '' : 'disabled'}>
                  <span class="xk-sub-icon-glyph" aria-hidden="true">⏱</span>
                </button>
                <button type="button" class="${toggleClass}" data-node-key="${key}" data-node-action="${manualExcluded ? 'include' : 'exclude'}" title="${escapeHtml(toggleTitle)}" data-tooltip="${escapeHtml(toggleTooltip)}" aria-label="${escapeHtml(toggleTitle)}">
                  ${toggleIcon}
                </button>
              </div>
            </div>
          </div>
        `);
      });

      summary.textContent = `${enabledCount}/${nodes.length}`;
      const captionHidden = hiddenCount
        ? (showHidden ? ` · показано скрытых ${hiddenCount}` : ` · скрыто ${hiddenCount}`)
        : '';
      caption.textContent = isPreview
        ? `Черновик · включено ${enabledCount}${captionHidden} · нажми «Сохранить», чтобы применить.`
        : `${String(sub.name || sub.tag || sub.id || 'Подписка')} · включено ${enabledCount}${captionHidden}`;

      if (showHiddenBtn) {
        if (hiddenCount > 0) {
          showHiddenBtn.hidden = false;
          showHiddenBtn.textContent = showHidden
            ? `Скрыть исключённые (${hiddenCount})`
            : `Показать скрытые (${hiddenCount})`;
          showHiddenBtn.classList.toggle('is-active', showHidden);
          showHiddenBtn.setAttribute(
            'aria-pressed',
            showHidden ? 'true' : 'false'
          );
        } else {
          showHiddenBtn.hidden = true;
          showHiddenBtn.classList.remove('is-active');
          showHiddenBtn.removeAttribute('aria-pressed');
        }
      }

      listEl.innerHTML = rows.join('');
      if (!nodes.length) {
        empty.textContent = 'Список узлов появится после обновления этой подписки.';
      } else if (enabledCount === 0 && hiddenCount > 0 && !showHidden) {
        empty.textContent = `Все ${hiddenCount} узлов скрыты фильтрами или исключены вручную. Нажми «Показать скрытые», чтобы вернуть их.`;
      } else {
        empty.textContent = 'Нет совпадений по текущим фильтрам.';
      }
      empty.style.display = rows.length ? 'none' : 'block';

      try { subsUpdatePingAllBtnState(); } catch (e) {}

      Array.from(listEl.querySelectorAll('.xk-sub-node-toggle')).forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          const nodeKey = String(btn.getAttribute('data-node-key') || '').trim();
          if (!nodeKey) return;
          const next = new Set(subsGetExcludedKeysValue());
          if (next.has(nodeKey)) next.delete(nodeKey);
          else next.add(nodeKey);
          subsSetExcludedKeysValue(Array.from(next));
          subsRenderNodeList();
          try { subsSyncSubscriptionFormState(); } catch (e2) {}
          subsSetStatus('Список узлов обновлён. Сохрани подписку, чтобы применить изменения к generated fragment.', false, true);
        });
      });
      Array.from(listEl.querySelectorAll('.xk-sub-node-ping')).forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (btn.disabled) return;
          const nodeKey = String(btn.getAttribute('data-node-key') || '').trim();
          if (!nodeKey) return;
          await subsProbeNode(subId, nodeKey);
        });
      });
    }

    async function subsProbeNode(subId, nodeKey) {
      const sid = String(subId || '').trim();
      const key = String(nodeKey || '').trim();
      if (!sid || !key) return false;
      const pendingKey = subsNodePingStateKey(sid, key);
      if (_subscriptionNodePingState[pendingKey]) return false;
      _subscriptionNodePingState[pendingKey] = true;
      try { subsRenderNodeList(); } catch (e) {}
      subsSetStatus('Проверяю задержку узла…', false);
      try {
        const res = await fetch(`/api/xray/subscriptions/${encodeURIComponent(sid)}/nodes/ping`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ node_key: key }),
        });
        const data = await res.json().catch(() => ({}));
        const sub = _subscriptions.find((item) => String(item && item.id || '') === sid);
        if (sub && data && data.entry) {
          const map = subsNodeLatencyMap(sub);
          map[key] = data.entry;
          sub.node_latency = map;
        }
        if (!res.ok || !data || data.ok === false) {
          const msg = String((data && (data.error || data.message)) || 'Не удалось проверить задержку узла.');
          subsSetStatus(msg, true);
          try { toastXkeen(msg, 'error'); } catch (e2) {}
          return false;
        }
        const delay = Number(data.delay_ms || (data.entry && data.entry.delay_ms));
        const msg = Number.isFinite(delay) && delay >= 0
          ? `Задержка узла: ${Math.round(delay)} ms.`
          : 'Проверка узла завершена.';
        subsSetStatus(msg, false, true);
        return true;
      } catch (e) {
        const msg = 'Ошибка проверки задержки: ' + String(e && e.message ? e.message : e);
        subsSetStatus(msg, true);
        try { toastXkeen(msg, 'error'); } catch (e2) {}
        return false;
      } finally {
        delete _subscriptionNodePingState[pendingKey];
        try { subsRenderNodeList(); } catch (e3) {}
      }
    }

    function subsUpdatePingAllBtnState() {
      const btn = $(SUB_IDS.nodesPingAll);
      if (!btn) return;
      const subId = String(_subscriptionEditId || '').trim();
      const sub = subId
        ? _subscriptions.find((item) => String(item && item.id || '') === subId) || null
        : null;
      const hasPingable = !!(sub && Array.isArray(sub.last_nodes) && sub.last_nodes.some((n) => n && n.tag));
      const tooltip = subsPingAllTooltipText(sub, hasPingable);
      const busyTooltip = 'Идёт проверка задержки для активных узлов этой подписки.';
      btn.setAttribute('data-tooltip', tooltip);
      btn.setAttribute('title', tooltip);
      btn.setAttribute('aria-label', hasPingable ? 'Пинг всех узлов' : 'Пинг всех узлов: нужна подготовка подписки');
      if (_subscriptionPingAllBusy) {
        btn.classList.add('is-busy');
        btn.setAttribute('data-tooltip', busyTooltip);
        btn.setAttribute('title', busyTooltip);
        btn.setAttribute('aria-label', 'Идёт проверка задержки для всех активных узлов');
        btn.setAttribute('aria-busy', 'true');
        btn.disabled = true;
        return;
      }
      btn.classList.remove('is-busy');
      btn.removeAttribute('aria-busy');
      btn.disabled = false;
    }

    async function subsProbeAllNodes() {
      if (_subscriptionPingAllBusy) return false;
      const subId = String(_subscriptionEditId || '').trim();
      if (!subId) {
        subsSetStatus('Сначала выбери подписку в списке справа, чтобы запустить массовую проверку задержки.', false);
        return false;
      }
      const sub = _subscriptions.find((item) => String(item && item.id || '') === subId) || null;
      if (!sub) {
        subsSetStatus('Подписка не найдена. Обнови список подписок и попробуй снова.', true);
        return false;
      }

      const nodes = Array.isArray(sub.last_nodes) ? sub.last_nodes : [];
      const draft = subsCurrentDraftFor(sub);
      const compiled = {
        name: subsCompilePreviewRegex(SUB_IDS.nameFilter),
        type: subsCompilePreviewRegex(SUB_IDS.typeFilter),
        transport: subsCompilePreviewRegex(SUB_IDS.transportFilter),
      };
      const hasPingableNodes = nodes.some((node) => node && node.tag);
      const targets = nodes.filter((node) => {
        if (!node || !node.key || !node.tag) return false;
        return subsNodeReasonCodes(node, draft, compiled).length === 0;
      });
      if (targets.length === 0) {
        const msg = hasPingableNodes
          ? 'Нет активных узлов для проверки задержки по текущим фильтрам. Сними фильтры по имени, типу или транспорту, либо верни исключённые узлы.'
          : subsPingAllTooltipText(sub, false);
        subsSetStatus(msg, false);
        return false;
      }

      _subscriptionPingAllBusy = true;
      const pendingStateKeys = targets
        .map((node) => subsNodePingStateKey(subId, String(node && node.key ? node.key : '')))
        .filter(Boolean);
      pendingStateKeys.forEach((key) => {
        _subscriptionNodePingState[key] = true;
      });
      subsUpdatePingAllBtnState();
      try { subsRenderNodeList(); } catch (e) {}
      subsSetStatus(`Проверяю задержку: ${targets.length} узлов…`, false);

      try {
        const res = await fetch(`/api/xray/subscriptions/${encodeURIComponent(subId)}/nodes/ping-bulk`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            node_keys: targets.map((node) => String(node && node.key ? node.key : '')).filter(Boolean),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data) {
          throw new Error(String((data && (data.error || data.message)) || ('HTTP ' + res.status)));
        }

        const sub2 = _subscriptions.find((item) => String(item && item.id || '') === subId);
        if (sub2 && Array.isArray(data.results)) {
          const map = subsNodeLatencyMap(sub2);
          data.results.forEach((item) => {
            const key = String(item && item.node_key || '').trim();
            if (!key || !item || !item.entry) return;
            map[key] = item.entry;
          });
          sub2.node_latency = map;
        }

        const ok = Number(data.ok_count || 0);
        const failed = Number(data.failed_count || 0);
        const total = Number(data.requested || targets.length);
        if (failed <= 0) {
          subsSetStatus(`Проверено узлов: ${ok}.`, false, true);
        } else {
          subsSetStatus(`Проверено ${ok} из ${total}, ошибок: ${failed}.`, true);
        }
        return failed <= 0;
      } catch (e) {
        const msg = 'Ошибка массовой проверки задержки: ' + String(e && e.message ? e.message : e);
        subsSetStatus(msg, true);
        try { toastXkeen(msg, 'error'); } catch (e2) {}
        return false;
      } finally {
        pendingStateKeys.forEach((key) => {
          delete _subscriptionNodePingState[key];
        });
        _subscriptionPingAllBusy = false;
        subsUpdatePingAllBtnState();
        try { subsRenderNodeList(); } catch (e) {}
      }
    }

    async function subsOpenGeneratedFragment(file) {
      const name = String(file || '').trim();
      if (!name) return false;

      async function commitOpen() {
        applyActiveFragment(name, _fragmentDir, _fragmentItems);
        try { await load(); } catch (e) {}
        subsShow(false);
        const opened = openXkeenJsonEditor('outbounds');
        if (opened == null) {
          try { toastXkeen('JSON-редактор не загружен.', 'error'); } catch (e) {}
          return false;
        }
        return true;
      }

      subsSetStatus('Открываю фрагмент: ' + name, false);
      try { await refreshFragmentsList({ notify: false }); } catch (e) {}

      const prev = getActiveFragment();
      if (prev && prev !== name) {
        return guardFragmentSwitch(name, prev, {
          onCancel: () => restoreFragmentSelection($(IDS.fragmentSelect), prev, _fragmentDir, _fragmentItems),
          commit: commitOpen,
        });
      }
      return commitOpen();
    }

    async function subsSyncOutboundsViewAfterMutation(options) {
      const opts = (options && typeof options === 'object') ? options : {};
      const prevActive = baseName(opts.prevActive || getActiveFragment() || '');
      const touchedFiles = new Set(
        (Array.isArray(opts.touchedFiles) ? opts.touchedFiles : [opts.touchedFile])
          .map((value) => baseName(value))
          .filter(Boolean)
      );

      try { await refreshFragmentsList({ notify: false }); } catch (e) {}

      const nextActive = baseName(getActiveFragment() || '');
      const selectionChanged = !!(prevActive && prevActive !== nextActive);
      const activeTouched = !!(nextActive && touchedFiles.has(nextActive));
      const removedActive = !!(prevActive && touchedFiles.has(prevActive) && prevActive !== nextActive);

      if (!selectionChanged && !activeTouched && !removedActive) return false;

      try {
        await load();
        return true;
      } catch (e) {}
      return false;
    }

    function getActiveRoutingFragmentName() {
      try {
        const sel = document.getElementById('routing-fragment-select');
        if (sel && sel.value) return baseName(sel.value);
      } catch (e) {}
      try {
        const code = document.getElementById('routing-file-code');
        if (code && code.textContent) return baseName(code.textContent);
      } catch (e2) {}
      return '';
    }

    async function subsSyncRoutingViewAfterMutation(options) {
      const opts = (options && typeof options === 'object') ? options : {};
      const routingChanged = !!opts.routingChanged;
      const observatoryChanged = !!opts.observatoryChanged;
      if (!routingChanged && !observatoryChanged) return false;

      const routingApi = getRoutingApi();
      if (!routingApi || typeof routingApi.load !== 'function') return false;

      const activeRoutingFile = baseName(getActiveRoutingFragmentName() || '');
      const touchedRoutingFile = baseName(opts.routingFile || '');
      const observatoryFile = baseName(opts.observatoryFile || '07_observatory.json');
      const routingTouched = !!(routingChanged && (!touchedRoutingFile || !activeRoutingFile || touchedRoutingFile === activeRoutingFile));
      const observatoryTouched = !!(observatoryChanged && observatoryFile && activeRoutingFile === observatoryFile);
      if (!routingTouched && !observatoryTouched) {
        return false;
      }

      let routingDirty = false;
      try {
        const dirtyApi = getXkeenConfigDirtyApi();
        routingDirty = !!(dirtyApi && typeof dirtyApi.isDirty === 'function' && dirtyApi.isDirty('routing'));
      } catch (e) {}

      if (routingDirty) {
        try {
          toastXkeen('Routing обновлён на диске после изменения подписки, но редактор не перезагружен из-за несохранённых правок.', 'warning');
        } catch (e) {}
        return false;
      }

      try {
        await routingApi.load();
        return true;
      } catch (e) {}
      return false;
    }

    async function subsLoad() {
      try {
        const res = await fetch('/api/xray/subscriptions', { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data || data.ok === false) {
          throw new Error(String((data && (data.error || data.message)) || ('HTTP ' + res.status)));
        }
        _subscriptions = Array.isArray(data.subscriptions) ? data.subscriptions : [];
        _subscriptionRoutingBalancers = Array.isArray(data.routing_balancers) ? data.routing_balancers : [];
        try {
          _subscriptionOutputFiles = new Set(_subscriptions.map((sub) => baseName(sub && sub.output_file)).filter(Boolean));
          _subscriptionOutputFilesTs = Date.now();
        } catch (e2) {}
        const active = _subscriptions.find((sub) => String(sub && sub.id || '') === String(_subscriptionEditId || '')) || null;
        if (active) subsFillForm(active, { focus: false, keepRefreshNow: true });
        else if (_subscriptionEditId) subsResetForm();
        else {
          try { subsRenderRoutingBalancers(subsSelectedBalancerTags()); } catch (e4) {}
        }
        subsRender();
        try { subsSyncSubscriptionFormState(); } catch (e3) {}
        return true;
      } catch (e) {
        subsSetStatus('Ошибка загрузки: ' + String(e && e.message ? e.message : e), true);
        return false;
      }
    }

    function subsClearPreview(silent) {
      if (!_subscriptionPreview) {
        try { subsSyncSubscriptionFormState(); } catch (e) {}
        return;
      }
      _subscriptionPreview = null;
      try { subsRenderNodeList(); } catch (e) {}
      try { subsRenderDiagnostics(); } catch (e2) {}
      try { subsSyncSubscriptionFormState(); } catch (e3) {}
      if (!silent) {
        try { subsSetStatus('', false); } catch (e) {}
      }
    }

    function subsUpdateDraftBadge(formState, dirty) {
      const badge = document.getElementById('outbounds-subscriptions-nodes-draft');
      if (!badge) return;
      const state = (formState && typeof formState === 'object') ? formState : subsReadFormState();
      const active = typeof dirty === 'boolean' ? dirty : subsHasDirtyDraft(state);
      badge.hidden = !active;
      badge.textContent = _subscriptionPreview
        ? 'Черновик · нажми «Сохранить»'
        : 'Есть правки · нажми «Сохранить»';
    }

    async function subsPreview() {
      const sync = subsSyncSubscriptionFormState();
      const validationMsg = subsFirstValidationError(sync.validation);
      if (!sync.validation.valid) {
        subsSetStatus(validationMsg || 'Проверь форму подписки.', true);
        return false;
      }
      const formState = sync.formState;
      const payload = {
        url: formState.url,
        tag: formState.tag,
        name: formState.name,
        name_filter: formState.name_filter,
        type_filter: formState.type_filter,
        transport_filter: formState.transport_filter,
        excluded_node_keys: formState.excluded_node_keys.slice(),
      };
      _subscriptionPreviewBusy = true;
      subsSyncSubscriptionFormState();
      try {
        subsSetStatus('Скачиваю предпросмотр…', false);
        const res = await fetch('/api/xray/subscriptions/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data || data.ok === false) {
          throw new Error(String((data && (data.error || data.message)) || ('HTTP ' + res.status)));
        }
        _subscriptionPreview = {
          url: formState.url,
          nodes: Array.isArray(data.nodes) ? data.nodes : [],
          sourceCount: Number(data.source_count || 0),
          filteredOutCount: Number(data.filtered_out_count || 0),
          warnings: Array.isArray(data.warnings) ? data.warnings : [],
          errors: Array.isArray(data.errors) ? data.errors : [],
          profileUpdateIntervalHours: Number(data.profile_update_interval_hours || 0),
          tagPrefix: String(data.tag_prefix || payload.tag || ''),
          ts: Date.now(),
        };
        subsRenderNodeList();
        subsRenderDiagnostics();
        subsSyncSubscriptionFormState();
        const nodeCount = _subscriptionPreview.nodes.length;
        const okCount = Number(data.count || 0);
        const filteredNote = _subscriptionPreview.filteredOutCount > 0
          ? ` · скрыто фильтрами ${_subscriptionPreview.filteredOutCount}`
          : '';
        subsSetStatus(`Черновик: ${okCount} из ${nodeCount} узлов${filteredNote}. Подписка не сохранена — нажми «Сохранить», чтобы применить.`, false, true);
        if (_subscriptionPreview.warnings.length) {
          try { toastXkeen(_subscriptionPreview.warnings.join(' '), 'warning'); } catch (e) {}
        }
        return true;
      } catch (err) {
        const msg = 'Ошибка предпросмотра: ' + String(err && err.message ? err.message : err);
        subsSetStatus(msg, true);
        try { toastXkeen(msg, 'error'); } catch (e) {}
        return false;
      } finally {
        _subscriptionPreviewBusy = false;
        try { subsSyncSubscriptionFormState(); } catch (e) {}
      }
    }

    async function subsRefresh(id, options) {
      const subId = String(id || '').trim();
      if (!subId) return false;
      const opts = (options && typeof options === 'object') ? options : {};
      if (opts.skipDraftConfirm !== true) {
        const ok = await subsConfirmDiscardDraft({
          message: 'Обновить подписку и потерять текущий черновик формы?',
          okText: 'Обновить',
          cancelText: 'Остаться',
        });
        if (!ok) return false;
      }
      const prevActive = getActiveFragment();
      subsSetStatus('Обновляю подписку…', false);
      const restart = shouldRestartAfterSave();
      try {
        const res = await fetch('/api/xray/subscriptions/' + encodeURIComponent(subId) + '/refresh?restart=' + (restart ? '1' : '0'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data || data.ok === false) {
          const err = String((data && (data.error || data.message)) || ('HTTP ' + res.status));
          throw new Error(err);
        }
        const changed = !!(data.changed || data.observatory_changed);
        data.changed = changed;
        const sourceCount = Number(data.source_count || data.count || 0);
        const filteredOutCount = Number(data.filtered_out_count || 0);
        const warningList = Array.isArray(data.warnings) ? data.warnings.map((item) => String(item || '').trim()).filter(Boolean) : [];
        const filterNote = filteredOutCount > 0 && sourceCount > 0
          ? ` · по фильтру ${Number(data.count || 0)} из ${sourceCount}`
          : '';
        const manualBalancers = Array.isArray(data.routing_manual_balancer_tags)
          ? data.routing_manual_balancer_tags.map((item) => String(item || '').trim()).filter(Boolean)
          : [];
        const routingParts = data.routing_changed
          ? [
              data.routing_balancer_tag
                ? `leastPing → ${String(data.routing_balancer_tag || 'proxy')} (${Number(data.routing_selector_count || 0)} tag)`
                : '',
              manualBalancers.length ? `balancers → ${manualBalancers.join(', ')}` : '',
            ].filter(Boolean)
          : [];
        const routingNote = routingParts.length ? (' · ' + routingParts.join(' · ')) : '';
        const routingModeNote = data.routing_mode === 'migrate-vless-rules'
          ? (Number(data.routing_migrated_rules || 0) > 0
            ? ` · strict: ${Number(data.routing_migrated_rules || 0)} rule → pool`
            : ' · strict mode')
          : (Number(data.routing_reverted_rules || 0) > 0
            ? ` · safe: ${Number(data.routing_reverted_rules || 0)} rule ← vless`
            : '');
        const msg = `Готово: ${Number(data.count || 0)} outbound` + filterNote + (data.changed ? ' · файл обновлён' : ' · без изменений');
        const fileNote = data.output_file ? (' · ' + String(data.output_file)) : '';
        subsSetStatus(msg + fileNote + routingNote + routingModeNote + (warningList.length ? ` В· warning: ${warningList[0]}` : ''), false, true);
        const warningStatusNote = warningList.length ? ' | warning: ' + warningList[0] : '';
        if (warningStatusNote) {
          subsSetStatus(msg + fileNote + routingNote + routingModeNote + warningStatusNote, false, true);
        }
        if (warningList.length) {
          try { toastXkeen(warningList.join(' '), 'warning'); } catch (eWarn) {}
        }
        if (!changed) {
          try { toastXkeen('Подписка проверена: изменений нет.', 'info'); } catch (e4) {}
        } else if (!data.restarted) {
          const restartNote = restart ? ' Перезапуск xkeen не выполнялся.' : ' Авто-перезапуск xkeen выключен.';
          const routeToast = data.routing_changed ? ' leastPing и routing тоже синхронизированы.' : '';
          const modeToast = data.routing_mode === 'migrate-vless-rules'
            ? ' Включён жёсткий режим pool.'
            : '';
          try { toastXkeen('Подписка Xray обновлена.' + routeToast + modeToast + restartNote, 'success'); } catch (e5) {}
        }
        await subsSyncOutboundsViewAfterMutation({
          prevActive,
          touchedFiles: changed && data.output_file ? [data.output_file] : [],
        });
        await subsSyncRoutingViewAfterMutation({
          routingChanged: !!data.routing_changed,
          routingFile: data.routing_file,
          observatoryChanged: !!data.observatory_changed,
          observatoryFile: '07_observatory.json',
        });
        try { await refreshRestartLog(); } catch (e3) {}
        await subsLoad();
        return true;
      } catch (e) {
        const msg = 'Ошибка обновления: ' + String(e && e.message ? e.message : e);
        subsSetStatus(msg, true);
        try { toastXkeen(msg, 'error'); } catch (e2) {}
        await subsLoad();
        return false;
      }
    }

    async function subsRefreshDue() {
      const ok = await subsConfirmDiscardDraft({
        message: 'Обновить due-подписки и потерять текущий черновик формы?',
        okText: 'Обновить due',
        cancelText: 'Остаться',
      });
      if (!ok) return false;
      subsSetStatus('Проверяю due-подписки…', false);
      const prevActive = getActiveFragment();
      const restart = shouldRestartAfterSave();
      try {
        const res = await fetch('/api/xray/subscriptions/refresh-due?restart=' + (restart ? '1' : '0'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data || data.ok === false) {
          throw new Error(String((data && (data.error || data.message)) || ('HTTP ' + res.status)));
        }
        const results = Array.isArray(data.results) ? data.results : [];
        const msg = `Due обновлены: ${Number(data.ok_count || 0)} / ${Number(data.updated || 0)}`;
        subsSetStatus(msg, false, true);
        await subsSyncOutboundsViewAfterMutation({
          prevActive,
          touchedFiles: results
            .filter((item) => !!(item && item.changed && item.output_file))
            .map((item) => item.output_file),
        });
        await subsSyncRoutingViewAfterMutation({
          routingChanged: results.some((item) => !!(item && item.routing_changed)),
          routingFile: results
            .map((item) => item && item.routing_file)
            .find((value) => !!String(value || '').trim()),
          observatoryChanged: results.some((item) => !!(item && item.observatory_changed)),
          observatoryFile: '07_observatory.json',
        });
        try { await refreshRestartLog(); } catch (e2) {}
        const changedCount = results.filter((item) => !!(item && (item.changed || item.observatory_changed || item.routing_changed))).length;
        const restartedCount = results.filter((item) => !!(item && item.restarted)).length;
        if (!changedCount) {
          const idleMsg = Number(data.updated || 0) > 0
            ? 'Due-подписки проверены: изменений нет.'
            : 'Due-подписки: обновлять пока нечего.';
          try { toastXkeen(idleMsg, 'info'); } catch (e3) {}
        } else if (!restartedCount) {
          const restartNote = restart ? ' Перезапуск xkeen не выполнялся.' : ' Авто-перезапуск xkeen выключен.';
          try { toastXkeen(`Подписки Xray обновлены: ${changedCount}.` + restartNote, 'success'); } catch (e4) {}
        }
        await subsLoad();
        return true;
      } catch (e) {
        subsSetStatus('Ошибка: ' + String(e && e.message ? e.message : e), true);
        await subsLoad();
        return false;
      }
    }

    async function subsSave(e) {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      const sync = subsSyncSubscriptionFormState();
      const validationMsg = subsFirstValidationError(sync.validation);
      if (!sync.validation.valid) {
        subsSetStatus(validationMsg || 'Проверь форму подписки.', true);
        return false;
      }
      const payload = subsBuildPayload(sync.formState);

      _subscriptionSaveBusy = true;
      subsSyncSubscriptionFormState();
      subsSetStatus('Сохраняю…', false);
      try {
        const res = await fetch('/api/xray/subscriptions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data || data.ok === false) {
          throw new Error(String((data && (data.error || data.message)) || ('HTTP ' + res.status)));
        }
        const sub = data.subscription || {};
        const rawId = String(sub.id || payload.id || '').trim();
        const id = rawId ? subsCleanId(rawId) : '';
        _subscriptionPreview = null;
        if (id) {
          _subscriptionEditId = id;
          try { $(SUB_IDS.id).value = id; } catch (e2) {}
        }
        subsSetStatus('Сохранено.', false, true);
        await subsLoad();
        if ($(SUB_IDS.refreshNow) && $(SUB_IDS.refreshNow).checked && id) {
          await subsRefresh(id, { skipDraftConfirm: true });
        } else {
          try { toastXkeen('Подписка сохранена', 'success'); } catch (e3) {}
        }
        return true;
      } catch (err) {
        const msg = 'Ошибка сохранения: ' + String(err && err.message ? err.message : err);
        subsSetStatus(msg, true);
        try { toastXkeen(msg, 'error'); } catch (e4) {}
        return false;
      } finally {
        _subscriptionSaveBusy = false;
        try { subsSyncSubscriptionFormState(); } catch (e5) {}
      }
    }

    async function subsDelete(id) {
      const subId = String(id || '').trim();
      if (!subId) return false;
      const prevActive = getActiveFragment();
      try {
        if (!window.confirm('Удалить подписку и сгенерированный outbounds-файл?')) return false;
      } catch (e) {}
      const ok = await subsConfirmDiscardDraft({
        message: 'Удалить подписку и потерять текущий черновик формы?',
        okText: 'Продолжить',
        cancelText: 'Остаться',
      });
      if (!ok) return false;
      const restart = shouldRestartAfterSave();
      subsSetStatus('Удаляю…', false);
      try {
        const res = await fetch('/api/xray/subscriptions/' + encodeURIComponent(subId) + '?restart=' + (restart ? '1' : '0'), {
          method: 'DELETE',
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data || data.ok === false) {
          throw new Error(String((data && (data.error || data.message)) || ('HTTP ' + res.status)));
        }
        subsSetStatus('Удалено.', false, true);
        if (_subscriptionEditId === subId) subsResetForm();
        await subsSyncOutboundsViewAfterMutation({
          prevActive,
          touchedFiles: [data && data.deleted && data.deleted.output_file],
        });
        await subsSyncRoutingViewAfterMutation({
          routingChanged: !!(data && data.routing_changed),
          routingFile: data && data.routing_file,
          observatoryChanged: !!(data && data.observatory_changed),
          observatoryFile: '07_observatory.json',
        });
        await subsLoad();
        return true;
      } catch (err) {
        subsSetStatus('Ошибка удаления: ' + String(err && err.message ? err.message : err), true);
        await subsLoad();
        return false;
      }
    }

    async function subsOpen() {
      subsEnsureModal();
      if (!_subscriptionBaseline) {
        try { subsResetForm(); } catch (e) {}
      }
      subsShow(true);
      subsSetStatus('', false);
      await subsLoad();
      try { subsSyncSubscriptionFormState(); } catch (e) {}
      try { $(SUB_IDS.url).focus(); } catch (e) {}
    }

    async function subsClose() {
      const ok = await subsConfirmDiscardDraft({
        message: 'Закрыть окно подписок и потерять текущий черновик?',
        okText: 'Закрыть',
        cancelText: 'Остаться',
      });
      if (!ok) return false;
      subsShow(false);
      return true;
    }

    function wireSubscriptionsModal() {
      const openBtn = $(SUB_IDS.open);
      if (!openBtn) return;
      if (openBtn.dataset && openBtn.dataset.xkSubWired === '1') return;

      openBtn.addEventListener('click', (e) => {
        e.preventDefault();
        void subsOpen();
      });
      if (openBtn.dataset) openBtn.dataset.xkSubWired = '1';

      const modal = subsEnsureModal();
      if (!modal || (modal.dataset && modal.dataset.xkWired === '1')) return;

      wireButton(SUB_IDS.close, () => { void subsClose(); });
      wireButton(SUB_IDS.cancel, () => { void subsClose(); });
      wireButton(SUB_IDS.reset, async () => {
        const ok = await subsConfirmDiscardDraft({
          message: 'Очистить форму подписки и потерять текущий черновик?',
          okText: 'Очистить',
          cancelText: 'Остаться',
          restore: false,
        });
        if (!ok) return;
        subsResetForm();
        subsSetStatus('', false);
      });
      wireButton(SUB_IDS.refreshDue, () => { void subsRefreshDue(); });
      wireButton(SUB_IDS.preview, () => { void subsPreview(); });
      wireButton(SUB_IDS.nodesPingAll, () => {
        void subsProbeAllNodes();
      });
      wireButton(SUB_IDS.nodesShowHidden, () => {
        _subscriptionShowHidden = !_subscriptionShowHidden;
        try { subsRenderNodeList(); } catch (e) {}
      });

      const form = $(SUB_IDS.form);
      if (form) {
        form.addEventListener('submit', subsSave);
      }
      [
        {
          id: SUB_IDS.url,
          event: 'input',
          clearPreview: (el) => _subscriptionPreview && String(el.value || '').trim() !== String(_subscriptionPreview.url || ''),
        },
        {
          id: SUB_IDS.name,
          event: 'input',
          clearPreview: () => !!_subscriptionPreview,
        },
        {
          id: SUB_IDS.tag,
          event: 'input',
          clearPreview: () => !!_subscriptionPreview,
        },
        {
          id: SUB_IDS.interval,
          event: 'input',
        },
        {
          id: SUB_IDS.enabled,
          event: 'change',
        },
        {
          id: SUB_IDS.ping,
          event: 'change',
        },
        {
          id: SUB_IDS.routingMode,
          event: 'change',
        },
        {
          id: SUB_IDS.routingAutoRule,
          event: 'change',
        },
      ].forEach((binding) => {
        const el = $(binding.id);
        if (!el || (el.dataset && el.dataset.xkSubFieldBound === '1')) return;
        el.addEventListener(binding.event, () => {
          if (binding.clearPreview && binding.clearPreview(el)) {
            subsClearPreview(true);
          }
          try { subsSyncSubscriptionFormState(); } catch (e) {}
        });
        if (el.dataset) el.dataset.xkSubFieldBound = '1';
      });
      const balancersRoot = $(SUB_IDS.routingBalancers);
      if (balancersRoot && (!balancersRoot.dataset || balancersRoot.dataset.xkSubBalancersBound !== '1')) {
        balancersRoot.addEventListener('change', (event) => {
          const target = event && event.target ? event.target : null;
          if (!target || String(target.type || '').toLowerCase() !== 'checkbox') return;
          try { subsSyncSubscriptionFormState(); } catch (e) {}
        });
        if (balancersRoot.dataset) balancersRoot.dataset.xkSubBalancersBound = '1';
      }
      [SUB_IDS.nameFilter, SUB_IDS.typeFilter, SUB_IDS.transportFilter].forEach((id) => {
        const el = $(id);
        if (!el || (el.dataset && el.dataset.xkSubFilterBound === '1')) return;
        el.addEventListener('input', () => {
          try { subsSyncSubscriptionFormState(); } catch (e) {}
          try { subsRenderNodeList(); } catch (e) {}
        });
        if (el.dataset) el.dataset.xkSubFilterBound = '1';
      });
      const intervalApplyBtn = $(SUB_IDS.intervalApply);
      if (intervalApplyBtn && !(intervalApplyBtn.dataset && intervalApplyBtn.dataset.xkSubApplyBound === '1')) {
        intervalApplyBtn.addEventListener('click', (e) => {
          e.preventDefault();
          const hours = Number(intervalApplyBtn.getAttribute('data-hours') || 0);
          if (!Number.isFinite(hours) || hours <= 0) return;
          try { $(SUB_IDS.interval).value = String(hours); } catch (e2) {}
          try { subsSyncSubscriptionFormState(); } catch (e3) {}
          subsSetStatus(`Интервал обновления установлен по рекомендации провайдера: ${hours} ч.`, false, true);
        });
        if (intervalApplyBtn.dataset) intervalApplyBtn.dataset.xkSubApplyBound = '1';
      }
      if (!(modal.dataset && modal.dataset.xkSubResizeBound === '1')) {
        window.addEventListener('resize', () => {
          const m = $(SUB_IDS.modal);
          if (!m || m.classList.contains('hidden')) return;
          try { subsSyncModalLayout(); } catch (e) {}
        });
        try {
          const content = modal.querySelector ? modal.querySelector('.modal-content') : null;
          if (content && typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver(() => {
              try { subsSyncModalLayout(); } catch (e) {}
            });
            ro.observe(content);
          }
        } catch (e2) {}
        if (modal.dataset) modal.dataset.xkSubResizeBound = '1';
      }

      modal.addEventListener('click', (e) => {
        try { if (e && e.target === modal) void subsClose(); } catch (e2) {}
      });

      document.addEventListener('keydown', (e) => {
        if (!e || e.key !== 'Escape') return;
        const m = $(SUB_IDS.modal);
        if (m && !m.classList.contains('hidden')) void subsClose();
      });

      if (modal.dataset) modal.dataset.xkWired = '1';
    }


    function init() {
      const hasAny =
        $('outbounds-body') ||
        $('outbounds-save-btn') ||
        $('outbounds-url');

      if (!hasAny) return;
      if (inited) return;
      inited = true;

      try { syncShellState(_fragmentDir, _fragmentItems); } catch (e) {}
      try {
        publishLifecycleState({
          currentValue: String(getCurrentUrl() || ''),
          savedValue: String(_savedUrl || ''),
          initialized: false,
          loading: false,
          saving: false,
        }, 'outbounds-init');
      } catch (e) {}

      setCollapsedFromStorage();
      wireHeader('outbounds-header', toggleCard);

      // Fragment selector
      refreshFragmentsList();

      // Buttons
      bindConfigAction('outbounds-save-btn', save);
      bindConfigAction('outbounds-normalize-btn', normalizeCurrentUrl);
      bindConfigAction('outbounds-backup-btn', backup, { kind: 'backup' });
      bindConfigAction('outbounds-restore-auto-btn', () => {
        try {
          const backupsApi = getBackupsApi();
          if (backupsApi && typeof backupsApi.restoreAuto === 'function') {
            backupsApi.restoreAuto('outbounds', { confirmed: true });
          } else {
            if (typeof showToast === 'function') showToast('Модуль бэкапов не загружен.', true);
          }
        } catch (e) {}
      }, { kind: 'restoreAuto' });
      bindConfigAction('outbounds-open-editor-btn', () => {
        try {
          if (openXkeenJsonEditor('outbounds') != null) {
            return;
          } else {
            if (typeof showToast === 'function') showToast('Модуль JSON-редактора не загружен.', true);
          }
        } catch (e) {}
      }, { kind: 'openEditor' });

      // Initial load
      wireHints();
      wireGeneratorModal();
      wirePoolModal();
      wireSubscriptionsModal();
      wireButton(OUTBOUND_NODE_IDS.pingAll, () => {
        outboundsProbeAllNodes();
      });
      load();
    }

    return {
      init,
      onShow,
      load,
      save,
      backup,
      toggleCard,
    };
  })();
})();
export function getOutboundsApi() {
  try {
    if (outboundsModuleApi && typeof outboundsModuleApi.init === 'function') return outboundsModuleApi;
  } catch (error) {
    return null;
  }
  return null;
}

function callOutboundsApi(method, ...args) {
  const api = getOutboundsApi();
  if (!api || typeof api[method] !== 'function') return null;
  return api[method](...args);
}

export function initOutbounds(...args) {
  return callOutboundsApi('init', ...args);
}

export function loadOutbounds(...args) {
  return callOutboundsApi('load', ...args);
}

export function onShowOutbounds(...args) {
  return callOutboundsApi('onShow', ...args);
}

export function saveOutbounds(...args) {
  return callOutboundsApi('save', ...args);
}

export function backupOutbounds(...args) {
  return callOutboundsApi('backup', ...args);
}

export function toggleOutboundsCard(...args) {
  return callOutboundsApi('toggleCard', ...args);
}

export const outboundsApi = Object.freeze({
  get: getOutboundsApi,
  init: initOutbounds,
  load: loadOutbounds,
  onShow: onShowOutbounds,
  save: saveOutbounds,
  backup: backupOutbounds,
  toggleCard: toggleOutboundsCard,
});
