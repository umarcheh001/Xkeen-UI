import { getRoutingCardsApi } from '../features/routing_cards.js';

(() => {
  'use strict';

  // DAT content viewer modal (GeoSite / GeoIP)
  // Public API:
  //   XKeen.ui.datContents.open('geosite'|'geoip', {intent?:'inrouting'}?)
  //   XKeen.ui.datContents.close()

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
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
    searchValue: 'routing-dat-contents-search-value',
    searchItems: 'routing-dat-contents-search-items',
    searchItemsModeLocal: 'routing-dat-contents-search-items-mode-local',
    searchItemsModeServer: 'routing-dat-contents-search-items-mode-server',
    searchItemsMore: 'routing-dat-contents-search-items-more',

    // Quick IP version filter (GeoIP only)
    ipFilter: 'routing-dat-contents-ipfilter',
    ipFilterAll: 'routing-dat-contents-ipfilter-all',
    ipFilterV4: 'routing-dat-contents-ipfilter-v4',
    ipFilterV6: 'routing-dat-contents-ipfilter-v6',
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
  const FETCH_LIMIT = 500; // backend caps at 500 for /api/routing/dat/tag

  function _shortLine(v, limit) {
    let s = String(v == null ? '' : v).replace(/\r/g, '').trim();
    if (!s) return '';
    try {
      s = s.split('\n').map(x => String(x || '').trim()).filter(Boolean).slice(0, 3).join(' | ');
    } catch (e) {}
    const lim = (typeof limit === 'number' && isFinite(limit) && limit > 30) ? limit : 200;
    if (s.length > lim) s = s.slice(0, lim - 3) + '...';
    return s;
  }

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

  // Value lookup (domain/IP) across TAGS.
  // When searchValue is non-empty, we ask backend to lookup matching tags.
  // Backend caches results (keyed by DAT mtime+value), so we keep UI logic simple.
  let _lookupTimer = null;
  let _lookupToken = 0;
  let _lookupQNorm = '';
  let _lookupPending = false;
  let _lookupError = '';
  let _lookupTagsSet = null; // Set(lowercase tag) | null

  // Items list filter (search inside currently opened tag list).
  let _itemsFilterTimer = null;
  let _itemsLoaded = []; // normalized items for current page
  let _itemsStatusBase = '';
  let _itemsStatusBaseErr = false;

  // Items search mode: local (current page filter) vs server (whole tag scan).
  let _itemsSearchMode = 'local'; // 'local' | 'server'

  // Quick preset for GeoIP items filter: all/v4/v6 (UI-only).
  // v4 is server-search for '.' and v6 is server-search for ':' to avoid pagination surprises.
  let _ipQuick = 'all'; // 'all' | 'v4' | 'v6' | 'custom'
  let _itemsServerTimer = null;
  let _itemsServerToken = 0;
  let _itemsServerQNorm = '';
  let _itemsServerNextCursor = null; // number|null
  let _itemsServerViewed = 0; // how many items scanned so far (best-effort)
  let _itemsServerTotal = null; // tag total, if known
  let _itemsServerItems = []; // normalized items (matches)
  let _itemsServerMode = ''; // 'contains' | 'ipin' (backend-provided)
  let _itemsServerPending = false;
  let _itemsShowingServer = false;

  function routingApi() {
    try {
      return getRoutingCardsApi();
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

  function setItemsStatusBase(msg, isErr) {
    _itemsStatusBase = msg ? String(msg) : '';
    _itemsStatusBaseErr = !!isErr;
    setItemsStatus(_itemsStatusBase, _itemsStatusBaseErr);
  }

  function itemsQueryRaw() {
    const e = el(IDS.searchItems);
    return e ? String(e.value || '') : '';
  }

  function setItemsQuery(raw) {
    const e = el(IDS.searchItems);
    if (!e) return;
    e.value = String(raw == null ? '' : raw);
  }

  function itemsQueryNorm() {
    return String(itemsQueryRaw() || '').trim().toLowerCase();
  }

  function isItemsServerMode() {
    return String(_itemsSearchMode || 'local') === 'server';
  }

  function showItemsMoreButton(show, disabled) {
    const b = el(IDS.searchItemsMore);
    if (!b) return;
    b.style.display = show ? '' : 'none';
    b.disabled = !!disabled;
  }

  function renderItemsSearchModeButtons() {
    const bLocal = el(IDS.searchItemsModeLocal);
    const bServer = el(IDS.searchItemsModeServer);
    const isServer = isItemsServerMode();
    if (bLocal) bLocal.classList.toggle('is-active', !isServer);
    if (bServer) bServer.classList.toggle('is-active', isServer);
  }

  function syncItemsSearchInputHint() {
    const qi = el(IDS.searchItems);
    if (!qi) return;
    if (isItemsServerMode()) {
      qi.title = _kind === 'geoip'
        ? 'Поиск по всему тегу GeoIP (сервер). Если введён IP — ищем попадание IP ∈ CIDR.'
        : 'Поиск по всему тегу GeoSite (сервер)';
    } else {
      qi.title = _kind === 'geoip'
        ? 'Фильтровать открытый список подсетей (текущая страница)'
        : 'Фильтровать открытый список доменов (текущая страница)';
    }
  }

  function resetServerSearchState() {
    try { if (_itemsServerTimer) clearTimeout(_itemsServerTimer); } catch (e) {}
    _itemsServerTimer = null;
    _itemsServerToken += 1; // invalidate in-flight
    _itemsServerQNorm = '';
    _itemsServerNextCursor = null;
    _itemsServerViewed = 0;
    _itemsServerTotal = null;
    _itemsServerItems = [];
    _itemsServerMode = '';
    _itemsServerPending = false;
    _itemsShowingServer = false;
    showItemsMoreButton(false, false);
  }

  function setItemsSearchMode(mode) {
    const m = (String(mode || '').toLowerCase() === 'server') ? 'server' : 'local';
    if (_itemsSearchMode === m) return;
    _itemsSearchMode = m;
    // Switching modes should not keep stale server results.
    resetServerSearchState();
    renderItemsSearchModeButtons();
    syncItemsSearchInputHint();
    try { applyItemsFilter(); } catch (e) {}
  }

  function syncIpQuickFromQuery() {
    if (_kind !== 'geoip') {
      _ipQuick = 'custom';
      return;
    }
    const q = String(itemsQueryRaw() || '').trim();
    if (!q) _ipQuick = 'all';
    else if (q === '.') _ipQuick = 'v4';
    else if (q === ':') _ipQuick = 'v6';
    else _ipQuick = 'custom';
  }

  function renderIpQuickButtons() {
    const wrap = el(IDS.ipFilter);
    if (!wrap) return;
    const show = (_kind === 'geoip');
    wrap.style.display = show ? '' : 'none';
    if (!show) return;

    syncIpQuickFromQuery();
    const bAll = el(IDS.ipFilterAll);
    const bV4 = el(IDS.ipFilterV4);
    const bV6 = el(IDS.ipFilterV6);
    if (bAll) bAll.classList.toggle('is-active', _ipQuick === 'all');
    if (bV4) bV4.classList.toggle('is-active', _ipQuick === 'v4');
    if (bV6) bV6.classList.toggle('is-active', _ipQuick === 'v6');
  }

  function applyIpQuickFilter(mode) {
    if (_kind !== 'geoip') return;
    const m = String(mode || '').toLowerCase();
    if (m === 'v4') {
      _ipQuick = 'v4';
      setItemsSearchMode('server');
      setItemsQuery('.');
      try { applyItemsFilter(); } catch (e) {}
      renderIpQuickButtons();
      return;
    }
    if (m === 'v6') {
      _ipQuick = 'v6';
      setItemsSearchMode('server');
      setItemsQuery(':');
      try { applyItemsFilter(); } catch (e) {}
      renderIpQuickButtons();
      return;
    }

    // all
    _ipQuick = 'all';
    // Back to normal paging, no surprise “search mode”.
    setItemsSearchMode('local');
    setItemsQuery('');
    try { applyItemsFilter(); } catch (e) {}
    renderIpQuickButtons();
  }

  function serverSearchStatusLine() {
    const found = Array.isArray(_itemsServerItems) ? _itemsServerItems.length : 0;
    const viewed = Number(_itemsServerViewed || 0);
    const hasTotal = (typeof _itemsServerTotal === 'number') && isFinite(_itemsServerTotal);
    const total = hasTotal ? Number(_itemsServerTotal) : null;
    const tail = (total != null) ? (`${Math.min(total, viewed)} из ${total}`) : String(viewed);
    const end = (_itemsServerNextCursor == null && viewed > 0) ? ' • конец' : '';
    const modeLabel = (_kind === 'geoip' && String(_itemsServerMode || '') === 'ipin') ? 'IP ∈ CIDR' : 'текст';
    return `Поиск в теге (${modeLabel}): найдено ${found}, просмотрено ${tail}${end}`;
  }

  function syncPagerForItemsSearch() {
    // When server-searching inside a tag, paging buttons should not navigate pages.
    const q = itemsQueryNorm();
    const active = !!(_selectedTag && isItemsServerMode() && q);
    if (active) {
      setDisabled(IDS.pagerPrev, true);
      setDisabled(IDS.pagerNext, true);
      setText(IDS.pagerInfo, 'Поиск');
      return;
    }
    renderPager();
  }

  async function serverSearchFetch(cursor, append) {
    if (!_selectedTag) return;
    const qRaw = String(itemsQueryRaw() || '').trim();
    const qNorm = String(qRaw || '').trim().toLowerCase();
    if (!qNorm) {
      resetServerSearchState();
      setItemsStatus(_itemsStatusBase, false);
      renderItems(Array.isArray(_itemsLoaded) ? _itemsLoaded : []);
      syncPagerForItemsSearch();
      return;
    }

    // Token ensures we ignore stale responses after quick typing.
    const token = (_itemsServerToken += 1);
    _itemsServerPending = true;
    _itemsShowingServer = true;
    setItemsStatus('Поиск…', false);
    showItemsMoreButton(false, true);
    syncPagerForItemsSearch();

    try {
      const url = '/api/routing/dat/search?kind=' + encodeURIComponent(_kind)
        + '&path=' + encodeURIComponent(_path)
        + '&tag=' + encodeURIComponent(_selectedTag)
        + '&q=' + encodeURIComponent(qRaw)
        + '&cursor=' + encodeURIComponent(String(cursor || 0))
        + '&limit=' + encodeURIComponent(String(LIMIT));

      const res = await fetch(url, { method: 'GET' });
      const data = await res.json().catch(() => ({}));
      if (token !== _itemsServerToken) return;

      if (!res.ok || !data || data.ok !== true) {
        const err = (data && (data.error || data.message)) || ('HTTP ' + res.status);
        const hint = (data && data.hint) ? String(data.hint) : '';
        const details = (data && data.details) ? _shortLine(data.details, 220) : '';
        const msg = hint || ('Ошибка поиска: ' + String(err) + (details ? ('. ' + details) : ''));
        _itemsServerPending = false;
        _itemsServerItems = [];
        _itemsServerNextCursor = null;
        _itemsServerViewed = Number(cursor || 0);
        setItemsStatus(msg, true);
        renderItems([]);
        showItemsMoreButton(false, false);
        syncPagerForItemsSearch();
        return;
      }

      const raw = Array.isArray(data.items) ? data.items : [];
      const got = normalizeItems(raw);
      if (append) _itemsServerItems = (Array.isArray(_itemsServerItems) ? _itemsServerItems : []).concat(got);
      else _itemsServerItems = got;

      const nextCur = (typeof data.next_cursor === 'number' && isFinite(data.next_cursor)) ? Number(data.next_cursor) : null;
      _itemsServerNextCursor = nextCur;
      const viewed = (typeof data.viewed === 'number' && isFinite(data.viewed)) ? Number(data.viewed) : (nextCur != null ? nextCur : (Number(cursor || 0) + Number(data.scanned || 0)));
      _itemsServerViewed = viewed;
      if (typeof data.total === 'number' && isFinite(data.total)) _itemsServerTotal = Number(data.total);
      _itemsServerMode = (data && data.mode) ? String(data.mode) : '';

      _itemsServerPending = false;
      setItemsStatus(serverSearchStatusLine(), false);
      renderItems(_itemsServerItems);
      showItemsMoreButton(nextCur != null, false);
      syncPagerForItemsSearch();
    } catch (e) {
      if (token !== _itemsServerToken) return;
      _itemsServerPending = false;
      setItemsStatus('Ошибка поиска (сеть).', true);
      renderItems([]);
      showItemsMoreButton(false, false);
      syncPagerForItemsSearch();
    }
  }

  function serverSearchStart() {
    const qNorm = itemsQueryNorm();
    if (!qNorm) {
      resetServerSearchState();
      applyItemsFilter();
      return;
    }
    if (_itemsServerQNorm === qNorm && Array.isArray(_itemsServerItems) && _itemsServerItems.length) {
      // Already have results for this query.
      _itemsShowingServer = true;
      setItemsStatus(serverSearchStatusLine(), false);
      renderItems(_itemsServerItems);
      showItemsMoreButton(_itemsServerNextCursor != null, false);
      syncPagerForItemsSearch();
      return;
    }
    // Reset state and fetch from the beginning.
    resetServerSearchState();
    _itemsServerQNorm = qNorm;
    _itemsShowingServer = true;
    serverSearchFetch(0, false);
  }

  function serverSearchMore() {
    if (!_selectedTag) return;
    if (!isItemsServerMode()) return;
    const qNorm = itemsQueryNorm();
    if (!qNorm) return;
    if (_itemsServerQNorm && _itemsServerQNorm !== qNorm) return;
    const cur = _itemsServerNextCursor;
    if (cur == null) return;
    serverSearchFetch(cur, true);
  }

  function filterItemsLocal(items, qNorm) {
    const q = String(qNorm || '').trim().toLowerCase();
    if (!q) return items || [];
    const src = Array.isArray(items) ? items : [];
    return src.filter((it) => {
      try {
        const t = (it && (it.t || it.type)) ? (it.t || it.type) : '';
        const v = (it && (it.v != null || it.value != null)) ? (it.v != null ? it.v : it.value) : (typeof it === 'string' ? it : '');
        const hay = (String(t || '') + ' ' + String(v || '')).toLowerCase();
        return hay.includes(q);
      } catch (e) {
        return false;
      }
    });
  }

  function applyItemsFilter() {
    // Do not override error statuses.
    if (_itemsStatusBaseErr) {
      _itemsShowingServer = false;
      renderItems(_itemsLoaded || []);
      showItemsMoreButton(false, false);
      syncPagerForItemsSearch();
      return;
    }

    const q = itemsQueryNorm();

    // Server mode: scan the whole tag on backend and show matches.
    if (isItemsServerMode() && q) {
      _itemsShowingServer = true;
      serverSearchStart();
      try { renderIpQuickButtons(); } catch (e) {}
      return;
    }

    // Local filter: current page only.
    _itemsShowingServer = false;
    if (!q) {
      resetServerSearchState();
      setItemsStatus(_itemsStatusBase, false);
      renderItems(Array.isArray(_itemsLoaded) ? _itemsLoaded : []);
      syncPagerForItemsSearch();
      try { renderIpQuickButtons(); } catch (e) {}
      return;
    }

    const base = Array.isArray(_itemsLoaded) ? _itemsLoaded : [];
    const filtered = filterItemsLocal(base, q);
    setItemsStatus(`Фильтр: ${filtered.length} из ${base.length}`, false);
    showItemsMoreButton(false, false);
    renderItems(filtered);
    syncPagerForItemsSearch();
    try { renderIpQuickButtons(); } catch (e) {}
  }

  function filterTags(q) {
    const s = String(q || '').trim().toLowerCase();
    if (!s) return _tags;
    return _tags.filter((t) => String(t.tag || '').toLowerCase().includes(s));
  }

  function isTagUsed(tag) {
    return !!(_usedTags && _usedTags.has(String(tag || '').toLowerCase()));
  }

  function splitTagsForDisplay(items) {
    const grouped = { used: [], rest: [] };
    const src = Array.isArray(items) ? items : [];
    src.forEach((it) => {
      if (isTagUsed(it && it.tag)) grouped.used.push(it);
      else grouped.rest.push(it);
    });
    return grouped;
  }

  function valueQueryRaw() {
    const e = el(IDS.searchValue);
    return e ? String(e.value || '') : '';
  }

  function valueQueryNorm() {
    return String(valueQueryRaw() || '').trim().toLowerCase();
  }

  function isLookupActive() {
    return !!valueQueryNorm();
  }

  function normalizeItems(raw) {
    const r = Array.isArray(raw) ? raw : [];
    return r.map((it) => {
      if (typeof it === 'string') return { t: '', v: it };
      if (!it || typeof it !== 'object') return { t: '', v: String(it || '') };
      const t = (it.t != null) ? it.t : (it.type != null ? it.type : '');
      const v = (it.v != null) ? it.v : (it.value != null ? it.value : '');
      return { t: String(t || ''), v: (v == null ? '' : String(v)) };
    });
  }

  async function runLookup(valueRaw, token) {
    const qRaw = String(valueRaw || '').trim();
    const qNorm = String(qRaw || '').trim().toLowerCase();
    if (!qNorm) {
      _lookupQNorm = '';
      _lookupPending = false;
      _lookupError = '';
      _lookupTagsSet = null;
      return;
    }

    _lookupPending = true;
    _lookupError = '';
    setTagsStatus('Поиск…', false);

    try {
      const res = await fetch('/api/routing/dat/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: _kind, path: _path, value: qRaw }),
      });
      const data = await res.json().catch(() => ({}));
      if (token !== _lookupToken) return;

      if (!res.ok || !data || data.ok !== true) {
        const msg = (data && (data.error || data.message)) || ('HTTP ' + res.status);
        _lookupQNorm = qNorm;
        _lookupPending = false;
        _lookupError = String(msg || 'lookup_failed');
        _lookupTagsSet = null;
        setTagsStatus('Lookup: ' + _lookupError, true);
        renderTags();
        return;
      }

      const matches = Array.isArray(data.matches) ? data.matches : [];
      const set = new Set();
      matches.forEach((m) => {
        const t = (m && typeof m === 'object') ? (m.tag || m.t || m.name) : m;
        const s = String(t || '').trim().toLowerCase();
        if (s) set.add(s);
      });

      _lookupQNorm = qNorm;
      _lookupPending = false;
      _lookupError = '';
      _lookupTagsSet = set;

      const label = _kind === 'geoip' ? 'IP' : 'домену';
      const n = set.size;
      setTagsStatus(n ? (`Найдено тегов по ${label}: ${n}`) : (`Ничего не найдено по ${label}.`), false);
      renderTags();
    } catch (e) {
      if (token !== _lookupToken) return;
      _lookupQNorm = qNorm;
      _lookupPending = false;
      _lookupError = 'network_error';
      _lookupTagsSet = null;
      setTagsStatus('Lookup: ошибка сети.', true);
      renderTags();
    }
  }

  async function refreshItemsView() {
    if (!_selectedTag) {
      _itemsLoaded = [];
      setItemsStatusBase('', false);
      renderItems([]);
      renderPager();
      return;
    }

    // NOTE: searchValue field is used for TAG lookup, not for filtering items.
    await loadTagItems();
  }

  function buildTagRow(it) {
    const row = document.createElement('div');
    row.className = 'dat-tag-row' + (it.tag === _selectedTag ? ' is-active' : '');

    const left = document.createElement('button');
    left.type = 'button';
    left.className = 'dat-tag-main btn-secondary';
    left.setAttribute('data-tooltip', 'Открыть содержимое тега');
    left.textContent = String(it.tag || '');

    const isUsed = isTagUsed(it.tag);
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
    return row;
  }

  function appendTagGroup(list, title, items, secondary) {
    const src = Array.isArray(items) ? items : [];
    if (!list || !src.length) return;

    const head = document.createElement('div');
    head.className = 'dat-tag-group-head' + (secondary ? ' is-secondary' : '');

    const titleEl = document.createElement('div');
    titleEl.className = 'dat-tag-group-title';
    titleEl.textContent = String(title || '');

    const countEl = document.createElement('span');
    countEl.className = 'dat-tag-group-count';
    countEl.textContent = String(src.length);

    head.appendChild(titleEl);
    head.appendChild(countEl);
    list.appendChild(head);

    src.forEach((it) => {
      list.appendChild(buildTagRow(it));
    });
  }

  function renderTags() {
    const list = el(IDS.tagsList);
    if (!list) return;

    const q = (el(IDS.search) && el(IDS.search).value) || '';
    let items = filterTags(q);

    // Optional: narrow down by lookup results.
    const qvNorm = valueQueryNorm();
    if (qvNorm && _lookupQNorm === qvNorm) {
      if (_lookupError) {
        items = [];
      } else if (_lookupTagsSet instanceof Set) {
        items = items.filter((t) => _lookupTagsSet.has(String(t.tag || '').toLowerCase()));
      }
    }
    list.innerHTML = '';

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'dat-contents-empty';
      empty.textContent = _tags.length ? 'Ничего не найдено.' : 'Нет данных.';
      list.appendChild(empty);
      return;
    }

    const grouped = splitTagsForDisplay(items);
    const ordered = grouped.used.concat(grouped.rest);
    const visible = ordered.slice(0, 1500);
    const visibleGrouped = splitTagsForDisplay(visible);
    const hasUsedGroup = visibleGrouped.used.length > 0;

    if (hasUsedGroup) {
      appendTagGroup(list, 'В routing', visibleGrouped.used, false);
      appendTagGroup(list, 'Остальные', visibleGrouped.rest, true);
    } else {
      visible.forEach((it) => {
        list.appendChild(buildTagRow(it));
      });
    }

    if (ordered.length > 1500) {
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
      const q = itemsQueryNorm();
      if (!_selectedTag) empty.textContent = 'Выберите тег слева.';
      else if (_itemsShowingServer && q) empty.textContent = 'Ничего не найдено в этом теге.';
      else if (q && Array.isArray(_itemsLoaded) && _itemsLoaded.length) empty.textContent = 'Ничего не найдено на этой странице.';
      else empty.textContent = 'Пусто.';
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
    _itemsLoaded = [];
    setItemsStatusBase('', false);
    renderItems([]);
    renderPager();

    try {
      const url = '/api/routing/dat/tags?kind=' + encodeURIComponent(_kind) + '&path=' + encodeURIComponent(_path);
      const res = await fetch(url, { method: 'GET' });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data || data.ok !== true) {
        const err = (data && (data.error || data.message)) || ('HTTP ' + res.status);
        const hint = (data && data.hint) ? String(data.hint) : '';
        const details = (data && data.details) ? _shortLine(data.details, 220) : '';
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
          setTagsStatus('Ошибка: ' + String(err) + (details ? ('. ' + details) : ''), true);
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

      // If lookup field is active — refresh lookup results (DAT might have changed).
      try {
        const qvNorm = valueQueryNorm();
        if (qvNorm) {
          _lookupToken += 1;
          const token = _lookupToken;
          runLookup(valueQueryRaw(), token);
        }
      } catch (e) {}
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
    _itemsLoaded = [];
    setItemsStatusBase('Загрузка…', false);
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
        const details = (data && data.details) ? _shortLine(data.details, 220) : '';
        if (hint) {
          setItemsStatusBase(hint, true);
        } else if (err === 'missing_xk_geodat') {
          setItemsStatusBase('Не установлен xk-geodat. Нажмите «xk-geodat» (вверху) для установки и затем попробуйте ещё раз.', true);
        } else if (err === 'missing_dat_file') {
          setItemsStatusBase('DAT-файл не найден: ' + _path, true);
        } else if (err === 'xk_geodat_timeout') {
          setItemsStatusBase('xk-geodat не ответил вовремя. Попробуйте ещё раз.', true);
        } else {
          setItemsStatusBase('Ошибка: ' + String(err) + (details ? ('. ' + details) : ''), true);
        }
        renderPager();
        return;
      }
      const raw = Array.isArray(data.items) ? data.items : [];
      // Normalize items: accept [{t,v}] or [{type,value}] or ["..."]
      const items = normalizeItems(raw);

      _pageSize = items.length;
      if (typeof data.total === 'number' && Number.isFinite(data.total)) {
        _total = Number(data.total);
      } else {
        _total = null;
      }
      _itemsLoaded = items;
      setItemsStatusBase(items.length ? '' : 'Пусто.', false);
      applyItemsFilter();
      syncPagerForItemsSearch();
    } catch (e) {
      setItemsStatusBase('Ошибка загрузки содержимого.', true);
      if (typeof console !== 'undefined') console.error(e);
      renderPager();
    }
  }

  async function selectTag(tag) {
    _selectedTag = String(tag || '').trim();
    _offset = 0;
    // Reset in-list filter when switching tags.
    try { const qi = el(IDS.searchItems); if (qi) qi.value = ''; } catch (e) {}
    // Also reset server-search state (cursor/results).
    resetServerSearchState();
    renderItemsSearchModeButtons();
    syncItemsSearchInputHint();
    setSelectedTagHeader();
    setRoutingStatus('', false);
    try { refreshRoutingTargets(); } catch (e) {}
    try { refreshUsedTags(); } catch (e) {}
    renderTags();
    await refreshItemsView();
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

    const qv = el(IDS.searchValue);
    if (qv) {
      qv.addEventListener('input', () => {
        try {
          if (_lookupTimer) clearTimeout(_lookupTimer);
        } catch (e) {}

        const raw = valueQueryRaw();
        const norm = valueQueryNorm();
        _lookupToken += 1;
        const token = _lookupToken;

        if (!norm) {
          _lookupQNorm = '';
          _lookupPending = false;
          _lookupError = '';
          _lookupTagsSet = null;
          setTagsStatus(_tags.length ? ('Тегов: ' + _tags.length) : 'Теги не найдены.', false);
          renderTags();
          return;
        }

        _lookupPending = true;
        setTagsStatus('Поиск…', false);

        _lookupTimer = setTimeout(() => {
          try { runLookup(raw, token); } catch (e) {}
        }, 300);
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

    // Search inside opened items list (current tag page).
    const qi = el(IDS.searchItems);
    if (qi) {
      qi.addEventListener('input', () => {
        try { if (_itemsFilterTimer) clearTimeout(_itemsFilterTimer); } catch (e) {}
        const delay = isItemsServerMode() ? 260 : 120;
        _itemsFilterTimer = setTimeout(() => {
          try { applyItemsFilter(); } catch (e) {}
          try { renderIpQuickButtons(); } catch (e) {}
        }, delay);
      });
    }

    // Items search mode toggle.
    const bModeLocal = el(IDS.searchItemsModeLocal);
    if (bModeLocal) {
      bModeLocal.addEventListener('click', (e) => {
        e.preventDefault();
        setItemsSearchMode('local');
        try { renderIpQuickButtons(); } catch (e) {}
      });
    }
    const bModeServer = el(IDS.searchItemsModeServer);
    if (bModeServer) {
      bModeServer.addEventListener('click', (e) => {
        e.preventDefault();
        setItemsSearchMode('server');
        try { renderIpQuickButtons(); } catch (e) {}
      });
    }

    // GeoIP quick filters
    const bAll = el(IDS.ipFilterAll);
    if (bAll) bAll.addEventListener('click', (e) => { e.preventDefault(); applyIpQuickFilter('all'); });
    const bV4 = el(IDS.ipFilterV4);
    if (bV4) bV4.addEventListener('click', (e) => { e.preventDefault(); applyIpQuickFilter('v4'); });
    const bV6 = el(IDS.ipFilterV6);
    if (bV6) bV6.addEventListener('click', (e) => { e.preventDefault(); applyIpQuickFilter('v6'); });

    const bMore = el(IDS.searchItemsMore);
    if (bMore) {
      bMore.addEventListener('click', (e) => {
        e.preventDefault();
        serverSearchMore();
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
        if (isItemsServerMode() && itemsQueryNorm()) return;
        _offset = Math.max(0, Number(_offset || 0) - LIMIT);
        await refreshItemsView();
      });
    }

    const nextBtn = el(IDS.pagerNext);
    if (nextBtn) {
      nextBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        if (!_selectedTag) return;
        if (isItemsServerMode() && itemsQueryNorm()) return;
        _offset = Math.max(0, Number(_offset || 0) + LIMIT);
        await refreshItemsView();
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

    const qv = el(IDS.searchValue);
    if (qv) {
      qv.value = '';
      if (_kind === 'geoip') {
        qv.placeholder = 'Поиск по IP…';
        qv.title = 'Найти теги GeoIP, в которых содержится указанный IP';
      } else {
        qv.placeholder = 'Поиск по домену…';
        qv.title = 'Найти теги GeoSite, в которых встречается домен/URL';
      }
    }
    const qi = el(IDS.searchItems);
    if (qi) {
      qi.value = '';
      if (_kind === 'geoip') {
        qi.placeholder = 'Поиск в списке подсетей…';
        qi.title = 'Фильтровать открытый список подсетей (текущая страница)';
      } else {
        qi.placeholder = 'Поиск в списке доменов…';
        qi.title = 'Фильтровать открытый список доменов (текущая страница)';
      }
    }

    // Reset items search mode/state on modal open.
    _itemsSearchMode = 'local';
    resetServerSearchState();
    renderItemsSearchModeButtons();
    syncItemsSearchInputHint();

    // Reset lookup state (also cancels any in-flight requests from a previous open).
    try { if (_lookupTimer) clearTimeout(_lookupTimer); } catch (e) {}
    _lookupToken += 1;
    _lookupQNorm = '';
    _lookupPending = false;
    _lookupError = '';
    _lookupTagsSet = null;

    openModal();
    await loadTags();

    // PR5: routing editor/model might become ready shortly after modal open
    // (e.g. CodeMirror initialization). Re-scan used tags and refresh markers once.
    setTimeout(() => {
      try { refreshUsedTags(); } catch (e) {}
      try { renderTags(); } catch (e) {}
      try { setSelectedTagHeader(); } catch (e) {}
    }, 450);

    // If opened with intent=inrouting - focus rule picker for faster workflow.
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
