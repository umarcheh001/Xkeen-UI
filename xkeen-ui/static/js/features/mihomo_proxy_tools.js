(() => {
  'use strict';

  // Mihomo Proxy Tools (Rename / Replace) for xkeen-ui-routing2
  // - Rename proxy: updates `proxies:` name and all mentions inside `proxy-groups:`
  // - Replace proxy: replaces a single proxy block inside `proxies:` by parsing a URI or WireGuard(.conf)

  window.XKeen = window.XKeen || {};
  XKeen.features = XKeen.features || {};

  const PT = (XKeen.features.mihomoProxyTools = XKeen.features.mihomoProxyTools || {});

  const IDS = {
    btnOpen: 'mihomo-proxy-tools-btn',

    modal: 'mihomo-proxy-tools-modal',
    btnClose: 'mihomo-proxy-tools-close-btn',
    btnClose2: 'mihomo-proxy-tools-close2-btn',

    select: 'mihomo-proxy-tools-select',
    status: 'mihomo-proxy-tools-status',
    current: 'mihomo-proxy-tools-current',

    noProxiesBox: 'mihomo-proxy-tools-no-proxies',
    noProxiesText: 'mihomo-proxy-tools-no-proxies-text',
    addStaticBtn: 'mihomo-proxy-tools-add-static-btn',
    actionsWrap: 'mihomo-proxy-tools-actions',

    renameInput: 'mihomo-proxy-tools-rename-input',
    renameBtn: 'mihomo-proxy-tools-rename-btn',

    replaceType: 'mihomo-proxy-tools-replace-type',
    replaceInput: 'mihomo-proxy-tools-replace-input',
    prepareBtn: 'mihomo-proxy-tools-prepare-btn',
    replaceBtn: 'mihomo-proxy-tools-replace-btn',
    replacePreview: 'mihomo-proxy-tools-replace-preview',
  };

  let _inited = false;
  let _prepared = null; // { proxy_name, proxy_yaml }

  function $(id) {
    return document.getElementById(id);
  }

  function toastMsg(msg, isErr) {
    try {
      if (window.toast) window.toast(String(msg || ''), isErr ? 'error' : 'success');
      else if (window.showToast) window.showToast(String(msg || ''), !!isErr);
    } catch (e) {}
  }

  function setStatus(msg, isErr) {
    const el = $(IDS.status);
    if (!el) return;
    const value = String(msg || '').trim();
    el.textContent = value;
    el.classList.toggle('hidden', !value);
    el.classList.toggle('error', !!value && !!isErr);
    el.classList.toggle('success', !!value && !isErr);
  }

  function syncCurrentProxyBadge(name) {
    const el = $(IDS.current);
    if (!el) return;
    const value = String(name || '').trim();
    el.textContent = value || '— не выбран —';
    el.classList.toggle('is-empty', !value);
  }

  function setNoProxiesUi(show, msg) {
    const box = $(IDS.noProxiesBox);
    const txt = $(IDS.noProxiesText);
    const wrap = $(IDS.actionsWrap);

    if (txt) txt.textContent = String(msg || '');
    if (show) syncCurrentProxyBadge('');
    if (box) {
      box.classList.toggle('hidden', !show);
      try { box.style.display = show ? 'block' : 'none'; } catch (e) {}
    }
    if (wrap) {
      wrap.classList.toggle('hidden', !!show);
      try { wrap.style.display = show ? 'none' : 'block'; } catch (e) {}
    }

    // Disable actions defensively (do NOT touch "replace" confirm button state when enabling)
    const dis = !!show;
    const ids = [IDS.select, IDS.renameInput, IDS.renameBtn, IDS.replaceType, IDS.replaceInput, IDS.prepareBtn];
    for (const id of ids) {
      const el = $(id);
      if (el) el.disabled = dis;
    }
    if (dis) {
      const rb = $(IDS.replaceBtn);
      if (rb) rb.disabled = true;
    }
  }

  function getEditorText() {
    try {
      if (typeof window.getMihomoEditorText === 'function') return String(window.getMihomoEditorText() || '');
    } catch (e) {}
    const ta = document.getElementById('mihomo-editor');
    return ta ? String(ta.value || '') : '';
  }

  function setEditorText(text) {
    try {
      if (typeof window.setMihomoEditorText === 'function') {
        window.setMihomoEditorText(String(text ?? ''));
        return;
      }
    } catch (e) {}
    const ta = document.getElementById('mihomo-editor');
    if (ta) ta.value = String(text ?? '');
  }

  function refreshEditor() {
    try {
      if (window.XKeen && XKeen.features && XKeen.features.mihomoPanel && typeof XKeen.features.mihomoPanel.refreshEditor === 'function') {
        XKeen.features.mihomoPanel.refreshEditor();
      }
    } catch (e) {}
    try {
      // best-effort CodeMirror refresh
      const cm = (window.XKeen && XKeen.state) ? XKeen.state.mihomoEditor : null;
      if (cm && cm.refresh) cm.refresh();
    } catch (e2) {}
  }

  function showModal(open) {
    const m = $(IDS.modal);
    if (!m) return;
    if (open) {
      m.classList.remove('hidden');
      try { m.style.display = 'flex'; } catch (e) {}
      try { m.setAttribute('aria-hidden', 'false'); } catch (e2) {}
      try { onOpen(); } catch (e3) { console.error(e3); }
    } else {
      m.classList.add('hidden');
      try { m.style.display = 'none'; } catch (e) {}
      try { m.setAttribute('aria-hidden', 'true'); } catch (e2) {}
      clearTransientUi();
    }
  }

  function clearTransientUi() {
    _prepared = null;
    const prev = $(IDS.replacePreview);
    if (prev) prev.value = '';
    const btn = $(IDS.replaceBtn);
    if (btn) btn.disabled = true;
    setStatus('', false);
  }

  function wireButton(id, fn) {
    const el = $(id);
    if (!el) return;
    if (el.dataset && el.dataset.xkWired === '1') return;
    el.addEventListener('click', (e) => {
      e.preventDefault();
      try { fn(e); } catch (err) { console.error(err); }
    });
    if (el.dataset) el.dataset.xkWired = '1';
  }

  function _stripQuotes(s) {
    const v = String(s || '').trim();
    if (!v) return '';
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
    return v;
  }

  function parseProxyNamesFromYaml(yamlText) {
    const lines = String(yamlText || '').replace(/\r\n?/g, '\n').split('\n');
    let inProxies = false;
    let baseIndent = 0;
    const out = [];

    for (let i = 0; i < lines.length; i++) {
      const ln = String(lines[i] || '');
      const mStart = ln.match(/^(\s*)proxies\s*:\s*(#.*)?$/);
      if (mStart && (mStart[1] || '').length === 0) {
        inProxies = true;
        baseIndent = (mStart[1] || '').length;
        continue;
      }
      if (!inProxies) continue;

      if (!ln.trim()) continue;

      const indent = (ln.match(/^(\s*)/) || ['', ''])[1].length;
      const ts = ln.replace(/^\s+/, '');

      // end when a new top-level key starts
      if (indent <= baseIndent && !ts.startsWith('#') && !ts.startsWith('-') && /^[A-Za-z0-9_\-]+\s*:/.test(ts)) {
        inProxies = false;
        continue;
      }

      const mName = ln.match(/^\s*-\s*name\s*:\s*(.+?)\s*(#.*)?$/);
      if (mName) {
        let raw = String(mName[1] || '').trim();
        raw = raw.replace(/\s+#.*$/, '').trim();
        const name = _stripQuotes(raw);
        if (name && out.indexOf(name) === -1) out.push(name);
      }
    }

    return out;
  }

  function hasTopLevelKey(yamlText, key) {
    const lines = String(yamlText || '').replace(/\r\n?/g, '\n').split('\n');
    const re = new RegExp('^' + String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*(#.*)?$');
    for (const ln of lines) {
      if (!ln) continue;
      if (ln.startsWith('#')) continue;
      if (/^\s+/.test(ln)) continue; // only top-level
      if (re.test(ln)) return true;
    }
    return false;
  }

  function buildProxiesTemplate(nl) {
    const eol = nl || '\n';
    return (
      'proxies:' + eol +
      '  # Добавлен шаблон статического узла. Замените на ваш реальный прокси.' + eol +
      '  - name: "static-proxy-1"' + eol +
      '    type: socks5' + eol +
      '    server: 127.0.0.1' + eol +
      '    port: 1080' + eol +
      '    udp: true' + eol + eol
    );
  }

  function insertIntoExistingEmptyProxies(yamlText) {
    const original = String(yamlText ?? '');
    const nl = original.includes('\r\n') ? '\r\n' : '\n';
    const lines = original.replace(/\r\n?/g, '\n').split('\n');

    let proxiesIdx = -1;
    let endIdx = lines.length;
    for (let i = 0; i < lines.length; i++) {
      if (/^proxies\s*:\s*(#.*)?$/.test(String(lines[i] || ''))) {
        proxiesIdx = i;
        for (let j = i + 1; j < lines.length; j++) {
          const ln = String(lines[j] || '');
          if (!ln.trim() || /^\s*#/.test(ln)) continue;
          if (!/^\s/.test(ln) && /^[A-Za-z0-9_\-]+\s*:/.test(ln)) {
            endIdx = j;
            break;
          }
        }
        break;
      }
    }

    if (proxiesIdx === -1) return { content: original, changed: false, reason: 'missing' };

    let hasNamedProxy = false;
    for (let i = proxiesIdx + 1; i < endIdx; i++) {
      if (/^\s*-\s*name\s*:\s*/.test(String(lines[i] || ''))) {
        hasNamedProxy = true;
        break;
      }
    }
    if (hasNamedProxy) return { content: original, changed: false, reason: 'non_empty' };

    const bodyLines = [
      '  # Добавлен шаблон статического узла. Замените на ваш реальный прокси.',
      '  - name: "static-proxy-1"',
      '    type: socks5',
      '    server: 127.0.0.1',
      '    port: 1080',
      '    udp: true',
      ''
    ];

    if (/^proxies\s*:\s*\[\s*\]\s*(#.*)?$/.test(String(lines[proxiesIdx] || ''))) {
      lines.splice(proxiesIdx, 1, 'proxies:', ...bodyLines);
    } else {
      lines.splice(proxiesIdx + 1, 0, ...bodyLines);
    }

    return {
      content: lines.join('\n').replace(/\n/g, nl),
      changed: true,
      inserted_name: 'static-proxy-1',
      reason: 'filled_empty_section',
    };
  }

  function insertProxiesTemplate(yamlText) {
    const original = String(yamlText ?? '');
    const nl = original.includes('\r\n') ? '\r\n' : '\n';

    if (hasTopLevelKey(original, 'proxies')) {
      const filled = insertIntoExistingEmptyProxies(original);
      if (filled && filled.changed) return filled;
      return { content: original, changed: false, reason: 'exists' };
    }

    const tpl = buildProxiesTemplate(nl);

    const reCommented = new RegExp('^\s*#\s*proxies\s*:\s*(#.*)?$', 'm');
    if (reCommented.test(original)) {
      const patched = original.replace(reCommented, tpl.trimEnd());
      return { content: patched, changed: true, inserted_name: 'static-proxy-1', reason: 'replaced_commented' };
    }

    const keys = ['proxy-providers', 'proxy-groups', 'rule-providers', 'rules'];
    let bestIdx = -1;
    for (const k of keys) {
      const re = new RegExp('^' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:', 'm');
      const m = re.exec(original);
      if (m && (bestIdx === -1 || m.index < bestIdx)) bestIdx = m.index;
    }
    if (bestIdx !== -1) {
      const before = original.slice(0, bestIdx);
      const after = original.slice(bestIdx);
      const sep = before.endsWith(nl + nl) ? '' : (before.endsWith(nl) ? nl : nl + nl);
      const patched = before + sep + tpl + after;
      return { content: patched, changed: true, inserted_name: 'static-proxy-1', reason: 'inserted_before_key' };
    }

    const sep = original.endsWith(nl) ? nl : nl + nl;
    return { content: original + sep + tpl, changed: true, inserted_name: 'static-proxy-1', reason: 'appended' };
  }

  function renderProxySelect(names, preferName) {
    const sel = $(IDS.select);
    if (!sel) return;

    const list = Array.isArray(names) ? names : [];
    sel.innerHTML = '';

    if (!list.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '— нет proxies —';
      sel.appendChild(opt);
      syncCurrentProxyBadge('');
      return;
    }

    for (const n of list) {
      const opt = document.createElement('option');
      opt.value = n;
      opt.textContent = n;
      sel.appendChild(opt);
    }

    const chosen = (preferName && list.includes(preferName)) ? preferName : list[0];
    try { sel.value = chosen; } catch (e) {}
    syncCurrentProxyBadge(chosen);
  }

  function selectedProxyName() {
    const sel = $(IDS.select);
    const v = sel ? String(sel.value || '').trim() : '';
    return v;
  }

  function yamlQuoteName(name) {
    const s = String(name ?? '');
    // quote if it contains spaces or yaml-sensitive chars
    if (!s) return '""';
    if (/^[A-Za-z0-9_\-\.]+$/.test(s)) return s;
    const esc = s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${esc}"`;
  }

  function forceProxyName(proxyYaml, name) {
    const q = yamlQuoteName(name);
    return String(proxyYaml || '').replace(/^\s*-\s*name\s*:\s*.*$/m, `- name: ${q}`);
  }

  function onOpen() {
    clearTransientUi();
    syncCurrentProxyBadge('');

    const cfg = getEditorText();
    const names = parseProxyNamesFromYaml(cfg);
    renderProxySelect(names);

    const hasProviders = hasTopLevelKey(cfg, 'proxy-providers');
    const hasProxiesKey = hasTopLevelKey(cfg, 'proxies');

    // Reset inputs
    const ren = $(IDS.renameInput);
    if (ren) ren.value = '';
    const rep = $(IDS.replaceInput);
    if (rep) rep.value = '';
    const prev = $(IDS.replacePreview);
    if (prev) prev.value = '';

    if (!names.length) {
      let msg = '';
      if (hasProviders && !hasProxiesKey) {
        msg = 'Вы используете proxy-providers (подписка). Proxy Tools работает только со статическими proxies. Хотите добавить статический узел?';
      } else if (!hasProxiesKey) {
        msg = 'Proxy Tools работает со статическими proxies, но секция proxies: не найдена. Хотите добавить статический узел?';
      } else {
        msg = 'Секция proxies: найдена, но в ней нет узлов вида "- name:". Хотите добавить пример статического узла?';
      }
      setStatus('', false);
      setNoProxiesUi(true, msg);
    } else {
      setNoProxiesUi(false, '');
      setStatus('', false);
    }
  }

  async function addStaticProxyTemplate() {
    try {
      const cfg = getEditorText();
      const out = insertProxiesTemplate(cfg);
      if (!out.changed) {
        toastMsg('Секция proxies уже есть ✅', false);
        onOpen();
        return;
      }
      setEditorText(out.content);
      refreshEditor();
      toastMsg('Добавлен шаблон proxies ✅', false);
      try { onOpen(); } catch (e2) {}
    } catch (e) {
      console.error(e);
      setStatus('Не удалось добавить шаблон proxies: ' + (e && e.message ? e.message : String(e || 'ошибка')), true);
    }
  }

  async function apiPost(url, body) {
    const http = (window.XKeen && XKeen.core && XKeen.core.http) ? XKeen.core.http : null;
    const post = http && typeof http.postJSON === 'function' ? http.postJSON : null;
    if (!post) throw new Error('XKeen.core.http.postJSON недоступен');
    const data = await post(url, body);
    if (data && data.ok === false) throw new Error(data.error || 'request failed');
    return data;
  }

  async function doRename() {
    const oldName = selectedProxyName();
    const input = $(IDS.renameInput);
    const newName = input ? String(input.value || '').trim() : '';

    if (!oldName) return setStatus('Выбери прокси для переименования.', true);
    if (!newName) return setStatus('Укажи новое имя.', true);
    if (newName === oldName) return setStatus('Новое имя совпадает со старым.', true);

    const cfg = getEditorText();
    const existing = parseProxyNamesFromYaml(cfg);
    if (existing.includes(newName)) return setStatus('Узел с таким именем уже существует.', true);
    const btn = $(IDS.renameBtn);
    if (btn) { btn.disabled = true; btn.classList.add('loading'); }

    try {
      setStatus('Переименовываю…', false);
      const data = await apiPost('/api/mihomo/patch/rename_proxy', {
        content: cfg,
        old_name: oldName,
        new_name: newName,
      });

      const patched = data && typeof data.content === 'string' ? data.content : '';
      if (!patched) throw new Error('Пустой ответ');
      setEditorText(patched);
      refreshEditor();

      // refresh select list and keep new selection
      const names = parseProxyNamesFromYaml(patched);
      renderProxySelect(names, newName);

      _prepared = null;
      const prev = $(IDS.replacePreview);
      if (prev) prev.value = '';
      const repBtn = $(IDS.replaceBtn);
      if (repBtn) repBtn.disabled = true;
      setStatus('Переименовано ✅', false);
      toastMsg('Прокси переименован ✅', false);
    } catch (e) {
      console.error(e);
      setStatus('Ошибка rename: ' + (e && e.message ? e.message : String(e || 'ошибка')), true);
    } finally {
      if (btn) { btn.disabled = false; btn.classList.remove('loading'); }
    }
  }

  async function prepareReplace() {
    const targetName = selectedProxyName();
    const modeSel = $(IDS.replaceType);
    const mode = modeSel ? String(modeSel.value || 'auto') : 'auto';

    const inp = $(IDS.replaceInput);
    const text = inp ? String(inp.value || '').trim() : '';

    const prev = $(IDS.replacePreview);
    const btnRep = $(IDS.replaceBtn);
    if (btnRep) btnRep.disabled = true;
    _prepared = null;

    if (!targetName) return setStatus('Выбери прокси для замены.', true);
    if (!text) return setStatus('Вставь ссылку или WG-конфиг.', true);

    const btn = $(IDS.prepareBtn);
    if (btn) { btn.disabled = true; btn.classList.add('loading'); }

    try {
      setStatus('Готовлю YAML…', false);

      let proxyYaml = '';
      if (mode === 'wireguard') {
        const data = await apiPost('/api/mihomo/parse/wireguard', { text: text, name: targetName });
        proxyYaml = String(data && data.proxy_yaml ? data.proxy_yaml : '');
        if (!proxyYaml) throw new Error('Не удалось распарсить WireGuard (.conf)');
      } else {
        // Auto (proxy link)
        const mi = (window.XKeen && XKeen.features && XKeen.features.mihomoImport) ? XKeen.features.mihomoImport : null;
        if (!mi || typeof mi.generateConfigForMihomo !== 'function') {
          throw new Error('mihomoImport.generateConfigForMihomo недоступен');
        }
        const out = mi.generateConfigForMihomo(text, getEditorText());
        if (!out || out.type !== 'proxy' || !out.content) {
          throw new Error('Ожидается proxy link (vless/trojan/vmess/ss/hy2), не subscription');
        }
        proxyYaml = String(out.content || '');
      }

      proxyYaml = forceProxyName(proxyYaml, targetName).trimEnd() + '\n';

      _prepared = { proxy_name: targetName, proxy_yaml: proxyYaml };

      if (prev) prev.value = proxyYaml;
      if (btnRep) btnRep.disabled = false;

      setStatus('Preview готов ✅', false);
    } catch (e) {
      console.error(e);
      setStatus('Ошибка подготовки: ' + (e && e.message ? e.message : String(e || 'ошибка')), true);
      if (prev) prev.value = '';
      if (btnRep) btnRep.disabled = true;
      _prepared = null;
    } finally {
      if (btn) { btn.disabled = false; btn.classList.remove('loading'); }
    }
  }

  async function doReplace() {
    const targetName = selectedProxyName();
    if (!targetName) return setStatus('Выбери прокси для замены.', true);
    if (!_prepared || !_prepared.proxy_yaml) return setStatus('Сначала нажми “Подготовить”.', true);

    const cfg = getEditorText();
    const btn = $(IDS.replaceBtn);
    const btnPrep = $(IDS.prepareBtn);

    if (btn) { btn.disabled = true; btn.classList.add('loading'); }
    if (btnPrep) { btnPrep.disabled = true; btnPrep.classList.add('loading'); }

    try {
      setStatus('Заменяю…', false);

      const data = await apiPost('/api/mihomo/patch/replace_proxy', {
        content: cfg,
        proxy_name: targetName,
        proxy_yaml: String(_prepared.proxy_yaml || ''),
      });

      const patched = data && typeof data.content === 'string' ? data.content : '';
      const changed = !!(data && data.changed);

      if (!patched) throw new Error('Пустой ответ');
      if (!changed) throw new Error('Прокси не найден или YAML некорректен');

      setEditorText(patched);
      refreshEditor();

      // refresh list and keep selection
      const names = parseProxyNamesFromYaml(patched);
      renderProxySelect(names, targetName);

      setStatus('Заменено ✅', false);
      toastMsg('Прокси заменён ✅', false);

      // keep preview, but clear prepared marker so user must re-prepare after edits
      _prepared = null;
      if (btn) btn.disabled = true;

      try {
        if (typeof window.updateLastActivity === 'function') {
          const fp = window.XKEEN_FILES && window.XKEEN_FILES.mihomo ? window.XKEEN_FILES.mihomo : '/opt/etc/mihomo/config.yaml';
          window.updateLastActivity('modified', 'mihomo', fp);
        }
      } catch (e2) {}
    } catch (e) {
      console.error(e);
      setStatus('Ошибка replace: ' + (e && e.message ? e.message : String(e || 'ошибка')), true);
    } finally {
      if (btn) { btn.disabled = false; btn.classList.remove('loading'); }
      if (btnPrep) { btnPrep.disabled = false; btnPrep.classList.remove('loading'); }
    }
  }

  function onSelectChange() {
    // reset prepared state and preview when user changes target
    clearTransientUi();
    syncCurrentProxyBadge(selectedProxyName());
  }

  PT.init = function init() {
    const openBtn = $(IDS.btnOpen);
    const modal = $(IDS.modal);
    if (!openBtn || !modal) return;

    if (_inited || (modal.dataset && modal.dataset.xkMihomoProxyToolsInited === '1')) return;
    _inited = true;
    if (modal.dataset) modal.dataset.xkMihomoProxyToolsInited = '1';

    wireButton(IDS.btnOpen, () => showModal(true));
    wireButton(IDS.btnClose, () => showModal(false));
    wireButton(IDS.btnClose2, () => showModal(false));

    wireButton(IDS.renameBtn, () => doRename());
    wireButton(IDS.prepareBtn, () => prepareReplace());
    wireButton(IDS.replaceBtn, () => doReplace());
    wireButton(IDS.addStaticBtn, () => addStaticProxyTemplate());

    const sel = $(IDS.select);
    if (sel && (!sel.dataset || sel.dataset.xkWired !== '1')) {
      sel.addEventListener('change', () => { try { onSelectChange(); } catch (e) {} });
      if (sel.dataset) sel.dataset.xkWired = '1';
    }

    const repInput = $(IDS.replaceInput);
    if (repInput && (!repInput.dataset || repInput.dataset.xkWired !== '1')) {
      repInput.addEventListener('input', () => { try { clearTransientUi(); syncCurrentProxyBadge(selectedProxyName()); } catch (e) {} });
      if (repInput.dataset) repInput.dataset.xkWired = '1';
    }

    const repType = $(IDS.replaceType);
    if (repType && (!repType.dataset || repType.dataset.xkWired !== '1')) {
      repType.addEventListener('change', () => { try { clearTransientUi(); syncCurrentProxyBadge(selectedProxyName()); } catch (e) {} });
      if (repType.dataset) repType.dataset.xkWired = '1';
    }

    // Close on backdrop click
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
  };
})();
