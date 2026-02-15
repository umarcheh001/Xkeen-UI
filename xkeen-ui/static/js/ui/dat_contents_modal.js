(() => {
  'use strict';

  // DAT content viewer modal (GeoSite / GeoIP)
  // Public API:
  //   XKeen.ui.datContents.open('geosite'|'geoip', {intent?:'inrouting'}?)
  //   XKeen.ui.datContents.close()

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.ui = XK.ui || {};
  XK.ui.datContents = XK.ui.datContents || {};

  const UI = XK.ui.datContents;

  const IDS = {
    modal: 'routing-dat-contents-modal',
    title: 'routing-dat-contents-title',
    kindBadge: 'routing-dat-contents-kind',
    path: 'routing-dat-contents-path',
    reload: 'routing-dat-contents-reload-btn',
    install: 'routing-dat-contents-install-geodat-btn',
    close: 'routing-dat-contents-close-btn',
    ok: 'routing-dat-contents-ok-btn',

    search: 'routing-dat-contents-search',
    tagsStatus: 'routing-dat-contents-tags-status',
    tagsList: 'routing-dat-contents-tags-list',

    selTag: 'routing-dat-contents-selected-tag',
    copySel: 'routing-dat-contents-copy-selected-btn',
    itemsStatus: 'routing-dat-contents-items-status',
    itemsList: 'routing-dat-contents-items-list',
    pagerPrev: 'routing-dat-contents-prev-btn',
    pagerNext: 'routing-dat-contents-next-btn',
    pagerInfo: 'routing-dat-contents-page-info',

    // PR3: add selected geosite:TAG / geoip:TAG into routing.rules
    routingBar: 'routing-dat-contents-routingbar',
    targetRule: 'routing-dat-contents-target-rule',
    targetOutbound: 'routing-dat-contents-target-outbound',
    inRouting: 'routing-dat-contents-inrouting-btn',
    routingStatus: 'routing-dat-contents-routing-status',

    // PR5: used indicator
    usedBadge: 'routing-dat-contents-used-badge',
  };

  const DAT_IDS = {
    geosite: { dir: 'routing-dat-geosite-dir', name: 'routing-dat-geosite-name' },
    geoip: { dir: 'routing-dat-geoip-dir', name: 'routing-dat-geoip-name' },
  };

  const LIMIT = 200;

  let _wired = false;
  let _kind = 'geosite';
  let _path = '';
  let _tags = []; // [{tag,count}]
let _usedTags = new Set(); // lowercase tags currently used in routing.rules
  let _selectedTag = '';
  let _offset = 0;
  let _total = null; // number|null (if backend does not return total)
  let _pageSize = 0;
  let _openOpts = null; // last open() options

  function routingApi() {
    try {
      return (window.XKeen && window.XKeen.features && window.XKeen.features.routingCards) ? window.XKeen.features.routingCards : null;
    } catch (e) {
      return null;
    }
  }

  function notify(msg, isError) {
    try {
      if (typeof toast === 'function') toast(String(msg || ''), !!isError);
    } catch (e) {}
  }

  function setRoutingStatus(msg, isError) {
    const s = el(IDS.routingStatus);
    if (!s) return;
    s.textContent = String(msg || '');
    s.style.color = isError ? '#fca5a5' : '';
  }

  function syncRoutingOutboundVisibility() {
    const sel = el(IDS.targetRule);
    const out = el(IDS.targetOutbound);
    if (!sel || !out) return;
    const isNew = String(sel.value || '') === 'new';
    out.style.display = isNew ? '' : 'none';
  }

  function refreshRoutingTargets() {
    const bar = el(IDS.routingBar);
    const sel = el(IDS.targetRule);
    const out = el(IDS.targetOutbound);
    const btn = el(IDS.inRouting);
    const api = routingApi();

    if (!bar || !sel || !out || !btn) return;

    // Hide the whole bar if routing feature is not present.
    if (!api || typeof api.getDatRoutingTargets !== 'function') {
      bar.style.display = 'none';
      return;
    }
    bar.style.display = '';

    let data = null;
    try { data = api.getDatRoutingTargets(); } catch (e) { data = null; }
    const rules = (data && Array.isArray(data.rules)) ? data.rules : [];
    const outbounds = (data && Array.isArray(data.outbounds)) ? data.outbounds : [];

    const prevSel = String(sel.value || 'new');
    sel.innerHTML = '';
    const optNew = document.createElement('option');
    optNew.value = 'new';
    optNew.textContent = '➕ Новое правило';
    sel.appendChild(optNew);
    rules.forEach((r) => {
      const o = document.createElement('option');
      o.value = String(r.idx);
      const title = r && r.title ? String(r.title) : 'rule';
      o.textContent = `#${Number(r.idx) + 1} — ${title}`;
      sel.appendChild(o);
    });
    // Restore selection if possible.
    if ([...sel.options].some((o) => o.value === prevSel)) sel.value = prevSel;
    else sel.value = 'new';

    const prevOut = String(out.value || '');
    out.innerHTML = '';
    outbounds.forEach((v) => {
      const o = document.createElement('option');
      o.value = String(v);
      o.textContent = String(v);
      out.appendChild(o);
    });
    if ([...out.options].some((o) => o.value === prevOut)) out.value = prevOut;
    else if (out.options.length) out.value = out.options[0].value;

    syncRoutingOutboundVisibility();
    // Button enabled only when a tag is selected.
    btn.disabled = !_selectedTag;
  }



  function refreshUsedTags() {
    const api = routingApi();
    _usedTags = new Set();
    if (!api || typeof api.getUsedDatTags !== 'function') return;
    try {
      const res = api.getUsedDatTags(_kind, _path);
      const tags = res && Array.isArray(res.tags) ? res.tags : [];
      tags.forEach((t) => {
        if (t == null) return;
        _usedTags.add(String(t).toLowerCase());
      });
    } catch (e) {}
  }

  function addSelectedToRouting() {
    const api = routingApi();
    if (!api || typeof api.applyDatSelector !== 'function') {
      notify('Routing: модуль не готов.', true);
      return;
    }
    if (!_selectedTag) return;

    const sel = el(IDS.targetRule);
    const out = el(IDS.targetOutbound);
    const target = sel ? String(sel.value || 'new') : 'new';
    const isNew = target === 'new';
    const ruleIdx = isNew ? null : Number(target);
    const outboundTag = out ? String(out.value || '') : '';

    const res = api.applyDatSelector({
      kind: _kind,
      tag: _selectedTag,
      datPath: _path,
      mode: isNew ? 'new' : 'existing',
      ruleIdx,
      outboundTag,
    });

    if (!res || res.ok !== true) {
      const msg = (res && (res.error || res.message)) ? (res.error || res.message) : 'Не удалось добавить в правило';
      setRoutingStatus(msg, true);
      notify('Routing: ' + msg, true);
      return;
    }

    const action = res.created ? 'Создано правило' : (res.added ? 'Добавлено в правило' : 'Без изменений');
    const idx = Number(res.idx);
    setRoutingStatus(`${action} #${idx + 1}`, false);
    notify(`${action}: #${idx + 1}`, false);
    try { refreshUsedTags(); } catch (e) {}
    try { renderTags(); } catch (e) {}
    try { setSelectedTagHeader(); } catch (e) {}
    // Update list (new rule could have been created)
    try { refreshRoutingTargets(); } catch (e) {}
  }

  function el(id) {
    return document.getElementById(id);
  }

  function normalizePath(dir, name) {
    const d = String(dir || '').trim().replace(/\/+$/g, '');
    const n = String(name || '').trim().replace(/^\/+/, '');
    if (!d) return '/' + n;
    if (!n) return d;
    return d + '/' + n;
  }

  function currentDatPath(kind) {
    const map = DAT_IDS[kind] || DAT_IDS.geosite;
    const dirEl = el(map.dir);
    const nameEl = el(map.name);
    const dir = dirEl ? dirEl.value : '';
    const name = nameEl ? nameEl.value : '';
    return normalizePath(dir, name);
  }

  function setText(id, value) {
    const e = el(id);
    if (e) e.textContent = value == null ? '' : String(value);
  }

  function setDisabled(id, v) {
    const e = el(id);
    if (e) e.disabled = !!v;
  }

  function show(id, visible) {
    const e = el(id);
    if (!e) return;
    e.style.display = visible ? '' : 'none';
  }

  function clearList(id) {
    const list = el(id);
    if (!list) return;
    list.innerHTML = '';
  }

  async function copyText(text) {
    const t = String(text || '');
    if (!t) return false;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(t);
        return true;
      }
    } catch (e) {}
    try {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.style.position = 'fixed';
      ta.style.left = '-1000px';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch (e2) {
      return false;
    }
  }

  function kindLabel(kind) {
    return kind === 'geoip' ? 'GeoIP' : 'GeoSite';
  }

  function _basename(p) {
    const s = String(p || '').trim().replace(/\\/g, '/');
    if (!s) return '';
    const a = s.split('/');
    return a[a.length - 1] || '';
  }

  // Build selector in the same style as routing rules.
  // We prefer ext:<file>.dat:<tag> when the DAT path is known, because on Keenetic
  // users often keep custom names like geosite_v2fly.dat / geoip_zkeenip.dat.
  function selectorPrefix(kind, path) {
    const base = _basename(path);
    if (base) return 'ext:' + base + ':';
    return kind === 'geoip' ? 'geoip:' : 'geosite:';
  }

  function selectorFor(kind, tag, path) {
    return selectorPrefix(kind, path) + String(tag || '');
  }

  function setTagsStatus(msg, isErr) {
    const s = el(IDS.tagsStatus);
    if (!s) return;
    s.textContent = msg ? String(msg) : '';
    s.classList.toggle('error', !!isErr);
  }

  function setItemsStatus(msg, isErr) {
    const s = el(IDS.itemsStatus);
    if (!s) return;
    s.textContent = msg ? String(msg) : '';
    s.classList.toggle('error', !!isErr);
  }

  function filterTags(q) {
    const s = String(q || '').trim().toLowerCase();
    if (!s) return _tags;
    return _tags.filter((t) => String(t.tag || '').toLowerCase().includes(s));
  }

  function renderTags() {
    const list = el(IDS.tagsList);
    if (!list) return;

    const q = (el(IDS.search) && el(IDS.search).value) || '';
    const items = filterTags(q);
    list.innerHTML = '';

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'dat-contents-empty';
      empty.textContent = _tags.length ? 'Ничего не найдено.' : 'Нет данных.';
      list.appendChild(empty);
      return;
    }

    items.slice(0, 1500).forEach((it) => {
      const row = document.createElement('div');
      row.className = 'dat-tag-row' + (it.tag === _selectedTag ? ' is-active' : '');

      const left = document.createElement('button');
      left.type = 'button';
      left.className = 'dat-tag-main btn-secondary';
      left.setAttribute('data-tooltip', 'Открыть содержимое тега');
      left.textContent = String(it.tag || '');
      const isUsed = _usedTags && _usedTags.has(String(it.tag || '').toLowerCase());
      if (isUsed) row.classList.add('is-used');
      const used = document.createElement('span');
      used.className = 'dat-tag-used' + (isUsed ? ' is-on' : '');
      used.textContent = '';
      used.setAttribute('data-tooltip', isUsed ? 'Используется в routing' : 'Не используется');

      const count = document.createElement('span');
      count.className = 'dat-tag-count';
      count.textContent = (it.count != null) ? String(it.count) : '—';
      if (it.count != null) {
        count.setAttribute('data-tooltip', _kind === 'geoip' ? 'Количество подсетей в теге' : 'Количество доменов в теге');
      }

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'dat-tag-copy btn-secondary';
      copyBtn.textContent = '⧉';
      copyBtn.setAttribute('aria-label', 'Copy');
      copyBtn.setAttribute('data-tooltip', 'Скопировать ' + selectorFor(_kind, it.tag, _path));

      left.addEventListener('click', () => {
        selectTag(String(it.tag || ''));
      });
      copyBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const s = selectorFor(_kind, it.tag, _path);
        const ok = await copyText(s);
        if (typeof toast === 'function') toast(ok ? ('Скопировано: ' + s) : 'Не удалось скопировать', !ok);
      });

      row.appendChild(left);
      row.appendChild(used);
      row.appendChild(count);
      row.appendChild(copyBtn);
      list.appendChild(row);
    });

    if (items.length > 1500) {
      const more = document.createElement('div');
      more.className = 'dat-contents-empty';
      more.textContent = 'Показаны первые 1500 тегов. Уточните поиск.';
      list.appendChild(more);
    }
  }

  function renderPager() {
    const hasTag = !!_selectedTag;
    const prev = el(IDS.pagerPrev);
    const next = el(IDS.pagerNext);

    if (!hasTag) {
      setDisabled(IDS.pagerPrev, true);
      setDisabled(IDS.pagerNext, true);
      setText(IDS.pagerInfo, '');
      return;
    }

    const o = Number(_offset || 0);
    const hasTotal = (typeof _total === 'number') && Number.isFinite(_total);
    const t = hasTotal ? Number(_total) : 0;
    const from = (o + 1);
    const to = Math.max(o, o + Math.max(0, Number(_pageSize || 0)));
    setText(IDS.pagerInfo, hasTotal ? (`${Math.min(t, from)}-${Math.min(t, to)} из ${t}`) : (`${from}-${to}`));
    if (prev) prev.disabled = (o <= 0);
    if (next) next.disabled = hasTotal ? (o + LIMIT >= t) : (_pageSize < LIMIT);
  }

  function renderItems(items) {
    const list = el(IDS.itemsList);
    if (!list) return;
    list.innerHTML = '';
    if (!items || !items.length) {
      const empty = document.createElement('div');
      empty.className = 'dat-contents-empty';
      empty.textContent = _selectedTag ? 'Пусто.' : 'Выберите тег слева.';
      list.appendChild(empty);
      return;
    }

    items.forEach((it) => {
      const row = document.createElement('div');
      row.className = 'dat-item-row';

      const t = document.createElement('span');
      t.className = 'dat-item-type';
      // Accept multiple backend formats: {t,v}, {type,value}, or plain string.
      const type = (it && (it.t || it.type)) ? (it.t || it.type) : '';
      t.textContent = type ? String(type) : '';

      const v = document.createElement('span');
      v.className = 'dat-item-value';
      const val = (it && (it.v != null || it.value != null)) ? (it.v != null ? it.v : it.value) : (typeof it === 'string' ? it : '');
      v.textContent = val != null ? String(val) : '';

      row.appendChild(t);
      row.appendChild(v);
      list.appendChild(row);
    });
  }

  function setSelectedTagHeader() {
    const tagEl = el(IDS.selTag);
    const used = !!(_selectedTag && _usedTags && _usedTags.has(String(_selectedTag).toLowerCase()));
    if (tagEl) tagEl.textContent = _selectedTag ? String(_selectedTag) : '—';

    const ub = el(IDS.usedBadge);
    if (ub) {
      ub.classList.toggle('is-on', used);
      ub.setAttribute('data-tooltip', used ? 'Тег используется в routing.rules' : 'Тег не используется в routing.rules');
    }

    const btn = el(IDS.copySel);
    if (btn) {
      const can = !!_selectedTag;
      btn.disabled = !can;
      btn.setAttribute('data-tooltip', can ? ('Скопировать ' + selectorFor(_kind, _selectedTag, _path)) : 'Выберите тег');
    }

    // PR3: enable "➕" only when tag is selected and routing feature is present.
    const addBtn = el(IDS.inRouting);
    if (addBtn) {
      const api = routingApi();
      const okApi = !!(api && typeof api.applyDatSelector === 'function');
      const canAdd = !!_selectedTag && okApi;
      addBtn.disabled = !canAdd;
      addBtn.setAttribute('data-tooltip', canAdd
        ? ('Добавить ' + selectorFor(_kind, _selectedTag, _path) + ' в routing.rules')
        : (_selectedTag ? 'Модуль routing не готов' : 'Выберите тег'));
    }
  }

  async function loadTags() {
    setDisabled(IDS.reload, true);
    setTagsStatus('Загрузка тегов…', false);
    clearList(IDS.tagsList);
    _tags = [];
    _selectedTag = '';
    _offset = 0;
    _total = null;
    _pageSize = 0;
    try { refreshUsedTags(); } catch (e) {}
    setSelectedTagHeader();
    setRoutingStatus('', false);
    try { refreshRoutingTargets(); } catch (e) {}
    setItemsStatus('', false);
    renderItems([]);
    renderPager();

    try {
      const url = '/api/routing/dat/tags?kind=' + encodeURIComponent(_kind) + '&path=' + encodeURIComponent(_path);
      const res = await fetch(url, { method: 'GET' });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data || data.ok !== true) {
        const err = (data && (data.error || data.message)) || ('HTTP ' + res.status);
        const hint = (data && data.hint) ? String(data.hint) : '';
        if (hint) {
          // Server provided a friendly hint (PR4).
          if (err === 'missing_dat_file') {
            setTagsStatus(hint + ' Путь: ' + _path, true);
          } else {
            setTagsStatus(hint, true);
          }
        } else if (err === 'missing_xk_geodat') {
          setTagsStatus('Не установлен xk-geodat. Нажмите «xk-geodat» (вверху) для установки и затем обновите список тегов.', true);
        } else if (err === 'missing_dat_file') {
          setTagsStatus('DAT-файл не найден: ' + _path, true);
        } else if (err === 'xk_geodat_timeout') {
          setTagsStatus('xk-geodat не ответил вовремя. Попробуйте ещё раз.', true);
        } else {
          setTagsStatus('Ошибка: ' + String(err), true);
        }
        return;
      }

      const raw = Array.isArray(data.tags) ? data.tags : [];
      // Normalize: accept both [{tag,count}] and ["tag"]
      _tags = raw.map((it) => {
        if (typeof it === 'string') return { tag: it, count: null };
        if (!it || typeof it !== 'object') return { tag: String(it || ''), count: null };
        const tag = (it.tag != null) ? it.tag : (it.t != null ? it.t : '');
        const count = (it.count != null) ? it.count : (it.c != null ? it.c : null);
        return { tag: String(tag || ''), count: (count == null ? null : count) };
      }).filter((x) => x.tag);
      setTagsStatus(_tags.length ? ('Тегов: ' + _tags.length) : 'Теги не найдены.', false);
      renderTags();
    } catch (e) {
      setTagsStatus('Ошибка загрузки тегов.', true);
      if (typeof console !== 'undefined') console.error(e);
    } finally {
      setDisabled(IDS.reload, false);
    }
  }

  async function loadTagItems() {
    if (!_selectedTag) return;
    setDisabled(IDS.pagerPrev, true);
    setDisabled(IDS.pagerNext, true);
    setItemsStatus('Загрузка…', false);
    renderItems([]);

    try {
      const url = '/api/routing/dat/tag?kind=' + encodeURIComponent(_kind)
        + '&path=' + encodeURIComponent(_path)
        + '&tag=' + encodeURIComponent(_selectedTag)
        + '&offset=' + encodeURIComponent(String(_offset || 0))
        + '&limit=' + encodeURIComponent(String(LIMIT));
      const res = await fetch(url, { method: 'GET' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data || data.ok !== true) {
        const err = (data && (data.error || data.message)) || ('HTTP ' + res.status);
        const hint = (data && data.hint) ? String(data.hint) : '';
        if (hint) {
          setItemsStatus(hint, true);
        } else if (err === 'missing_xk_geodat') {
          setItemsStatus('Не установлен xk-geodat. Нажмите «xk-geodat» (вверху) для установки и затем попробуйте ещё раз.', true);
        } else if (err === 'missing_dat_file') {
          setItemsStatus('DAT-файл не найден: ' + _path, true);
        } else if (err === 'xk_geodat_timeout') {
          setItemsStatus('xk-geodat не ответил вовремя. Попробуйте ещё раз.', true);
        } else {
          setItemsStatus('Ошибка: ' + String(err), true);
        }
        renderPager();
        return;
      }
      const raw = Array.isArray(data.items) ? data.items : [];
      // Normalize items: accept [{t,v}] or [{type,value}] or ["..."]
      const items = raw.map((it) => {
        if (typeof it === 'string') return { t: '', v: it };
        if (!it || typeof it !== 'object') return { t: '', v: String(it || '') };
        const t = (it.t != null) ? it.t : (it.type != null ? it.type : '');
        const v = (it.v != null) ? it.v : (it.value != null ? it.value : '');
        return { t: String(t || ''), v: (v == null ? '' : String(v)) };
      });

      _pageSize = items.length;
      if (typeof data.total === 'number' && Number.isFinite(data.total)) {
        _total = Number(data.total);
      } else {
        _total = null;
      }
      setItemsStatus(items.length ? '' : 'Пусто.', false);
      renderItems(items);
      renderPager();
    } catch (e) {
      setItemsStatus('Ошибка загрузки содержимого.', true);
      if (typeof console !== 'undefined') console.error(e);
      renderPager();
    }
  }

  async function selectTag(tag) {
    _selectedTag = String(tag || '').trim();
    _offset = 0;
    setSelectedTagHeader();
    setRoutingStatus('', false);
    try { refreshRoutingTargets(); } catch (e) {}
    try { refreshUsedTags(); } catch (e) {}
    renderTags();
    await loadTagItems();
  }

  function openModal() {
    const m = el(IDS.modal);
    if (!m) return;
    m.classList.remove('hidden');
  }

  function closeModal() {
    const m = el(IDS.modal);
    if (!m) return;
    m.classList.add('hidden');
  }

  function wireOnce() {
    if (_wired) return;
    _wired = true;

    const m = el(IDS.modal);
    if (m) {
      m.addEventListener('click', (e) => {
        if (e && e.target === m) closeModal();
      });
    }

    const closeBtn = el(IDS.close);
    if (closeBtn) closeBtn.addEventListener('click', (e) => { e.preventDefault(); closeModal(); });
    const okBtn = el(IDS.ok);
    if (okBtn) okBtn.addEventListener('click', (e) => { e.preventDefault(); closeModal(); });

    const reloadBtn = el(IDS.reload);
    if (reloadBtn) reloadBtn.addEventListener('click', (e) => { e.preventDefault(); loadTags(); });

    const installBtn = el(IDS.install);
    if (installBtn) installBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      const api = routingApi();
      if (!api || typeof api.installGeodat !== 'function') {
        setTagsStatus('Модуль установки xk-geodat недоступен.', true);
        return;
      }
      const r = await api.installGeodat({ mode: 'release' });
      if (r && r.ok && r.installed) {
        await loadTags();
      }
    });


    const q = el(IDS.search);
    if (q) {
      q.addEventListener('input', () => {
        renderTags();
      });
    }

    const copyBtn = el(IDS.copySel);
    if (copyBtn) {
      copyBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        if (!_selectedTag) return;
        const s = selectorFor(_kind, _selectedTag, _path);
        const ok = await copyText(s);
        if (typeof toast === 'function') toast(ok ? ('Скопировано: ' + s) : 'Не удалось скопировать', !ok);
      });
    }

    // PR3: add to routing.rules (new or existing rule)
    const targetSel = el(IDS.targetRule);
    if (targetSel) {
      targetSel.addEventListener('change', () => {
        try { syncRoutingOutboundVisibility(); } catch (e) {}
        setRoutingStatus('', false);
      });
    }

    const addBtn = el(IDS.inRouting);
    if (addBtn) {
      addBtn.addEventListener('click', (e) => {
        e.preventDefault();
        addSelectedToRouting();
      });
    }

    const prevBtn = el(IDS.pagerPrev);
    if (prevBtn) {
      prevBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        if (!_selectedTag) return;
        _offset = Math.max(0, Number(_offset || 0) - LIMIT);
        await loadTagItems();
      });
    }

    const nextBtn = el(IDS.pagerNext);
    if (nextBtn) {
      nextBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        if (!_selectedTag) return;
        _offset = Math.max(0, Number(_offset || 0) + LIMIT);
        await loadTagItems();
      });
    }

    document.addEventListener('keydown', (e) => {
      try {
        if (!e || e.key !== 'Escape') return;
        const modal = el(IDS.modal);
        if (!modal || modal.classList.contains('hidden')) return;
        closeModal();
      } catch (err) {}
    });
  }

  async function open(kind, opts) {
    wireOnce();
    _openOpts = opts || null;
    _kind = (kind === 'geoip') ? 'geoip' : 'geosite';
    _path = currentDatPath(_kind);

    // Header
    setText(IDS.title, 'DAT: ' + kindLabel(_kind) + ' — Содержимое');
    setText(IDS.kindBadge, selectorPrefix(_kind, _path));
    setText(IDS.path, _path);
    setText(IDS.selTag, '—');
    try { refreshUsedTags(); } catch (e) {}
    setSelectedTagHeader();
    setRoutingStatus('', false);
    try { refreshRoutingTargets(); } catch (e) {}

    // Reset search
    const q = el(IDS.search);
    if (q) q.value = '';

    openModal();
    await loadTags();

    // PR5: routing editor/model might become ready shortly after modal open
    // (e.g. CodeMirror initialization). Re-scan used tags and refresh markers once.
    setTimeout(() => {
      try { refreshUsedTags(); } catch (e) {}
      try { renderTags(); } catch (e) {}
      try { setSelectedTagHeader(); } catch (e) {}
    }, 450);

    // If opened via "➕ В правило" - focus rule picker for faster workflow.
    try {
      if (_openOpts && _openOpts.intent === 'inrouting') {
        const sel = el(IDS.targetRule);
        if (sel) {
          sel.value = 'new';
          syncRoutingOutboundVisibility();
          setTimeout(() => { try { sel.focus(); } catch (e) {} }, 0);
        }
      }
    } catch (e) {}
  }

  UI.open = open;
  UI.close = closeModal;
})();
