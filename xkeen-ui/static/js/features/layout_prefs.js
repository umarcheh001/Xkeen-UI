(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.features = XK.features || {};
  XK.features.layoutPrefs = XK.features.layoutPrefs || {};

  const Feature = XK.features.layoutPrefs;

  const TAB_DEFS = Object.freeze([
    { key: 'view:routing', label: 'Роутинг Xray' },
    { key: 'view:mihomo', label: 'Роутинг Mihomo' },
    { key: 'view:xkeen', label: 'Порты и Исключения' },
    { key: 'view:xray-logs', label: 'Live логи Xray' },
    { key: 'view:commands', label: 'Команды' },
    { key: 'view:files', label: 'Файлы' },
    { key: 'id:top-tab-mihomo-generator', label: 'Mihomo Генератор' },
    { key: 'id:top-tab-donate', label: '💰 Донат' },
  ]);

  function byId(id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  }

  function toast(msg, isError) {
    try {
      if (typeof window.toast === 'function') return window.toast(String(msg || ''), isError ? 'error' : 'info');
      if (typeof window.showToast === 'function') return window.showToast(String(msg || ''), isError ? 'error' : 'info');
      console.log(msg);
    } catch (e) {}
  }

  function core() {
    return (XK && XK.ui && XK.ui.layout) ? XK.ui.layout : null;
  }

  function loadPrefs() {
    const c = core();
    if (c && typeof c.load === 'function') return c.load();
    try {
      const raw = localStorage.getItem('xkeen-layout-v1');
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function saveApply(next) {
    const c = core();
    if (c && typeof c.save === 'function') c.save(next);
    else {
      try { localStorage.setItem('xkeen-layout-v1', JSON.stringify(next || {})); } catch (e) {}
    }
    if (c && typeof c.apply === 'function') c.apply(next);
  }

  function uniq(list) {
    const out = [];
    const seen = new Set();
    (list || []).forEach((k) => {
      const s = String(k || '');
      if (!s || seen.has(s)) return;
      seen.add(s);
      out.push(s);
    });
    return out;
  }

  function defaultOrder() {
    return TAB_DEFS.map(t => t.key);
  }

  function labelFor(key) {
    const hit = TAB_DEFS.find(t => t.key === key);
    const base = hit ? hit.label : key;
    try {
      if (XK && XK.ui && XK.ui.branding && typeof XK.ui.branding.labelForTabKey === 'function') {
        return XK.ui.branding.labelForTabKey(key, base);
      }
    } catch (e) {}
    return base;
  }

  function renderTabs(prefs) {
    const ul = byId('dt-layout-tab-list');
    if (!ul) return;

    const order = uniq((prefs && prefs.tabOrder && prefs.tabOrder.length) ? prefs.tabOrder : defaultOrder());
    // ensure all known keys are present
    TAB_DEFS.forEach((t) => {
      if (!order.includes(t.key)) order.push(t.key);
    });

    const fav = new Set(uniq(prefs && prefs.tabFav));

    ul.innerHTML = '';
    order.forEach((key) => {
      const li = document.createElement('li');
      li.className = 'dt-tab-item' + (fav.has(key) ? ' is-fav' : '');
      li.setAttribute('draggable', 'true');
      li.dataset.key = key;

      const handle = document.createElement('span');
      handle.className = 'dt-tab-handle';
      handle.textContent = '≡';
      handle.title = 'Перетащить';

      const label = document.createElement('span');
      label.className = 'dt-tab-label';
      label.textContent = labelFor(key);

      const star = document.createElement('button');
      star.type = 'button';
      star.className = 'btn-secondary dt-tab-star';
      star.textContent = fav.has(key) ? '⭐' : '☆';
      star.title = fav.has(key) ? 'Убрать из избранных' : 'Закрепить (избранное)';

      star.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const p = loadPrefs();
        const curFav = uniq(p.tabFav);
        const has = curFav.includes(key);
        const nextFav = has ? curFav.filter(k => k !== key) : curFav.concat([key]);
        const next = { ...p, tabFav: nextFav };
        saveApply(next);
        renderTabs(loadPrefs());
        toast(has ? 'Избранное: убрано' : 'Избранное: закреплено');
      });

      li.appendChild(handle);
      li.appendChild(label);
      li.appendChild(star);
      ul.appendChild(li);
    });

    wireTabsDnD(ul);
  }

  function wireTabsDnD(ul) {
    if (!ul || ul.dataset && ul.dataset.xkeenWired === '1') return;
    if (ul.dataset) ul.dataset.xkeenWired = '1';

    let dragKey = '';

    const getLi = (ev) => {
      const el = ev && ev.target ? ev.target : null;
      if (!el) return null;
      return el.closest ? el.closest('.dt-tab-item') : null;
    };

    ul.addEventListener('dragstart', (ev) => {
      const li = getLi(ev);
      if (!li) return;
      dragKey = String(li.dataset.key || '');
      li.classList.add('is-dragging');
      try {
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', dragKey);
      } catch (e) {}
    });

    ul.addEventListener('dragend', (ev) => {
      const li = getLi(ev);
      if (li) li.classList.remove('is-dragging');
      dragKey = '';
      try {
        ul.querySelectorAll('.dt-tab-item.is-drop-target').forEach(n => n.classList.remove('is-drop-target'));
      } catch (e) {}
    });

    ul.addEventListener('dragover', (ev) => {
      if (!dragKey) return;
      ev.preventDefault();
      const li = getLi(ev);
      if (!li) return;
      try {
        ul.querySelectorAll('.dt-tab-item.is-drop-target').forEach(n => n.classList.remove('is-drop-target'));
        li.classList.add('is-drop-target');
      } catch (e) {}
    });

    ul.addEventListener('dragleave', (ev) => {
      const li = getLi(ev);
      if (li) li.classList.remove('is-drop-target');
    });

    ul.addEventListener('drop', (ev) => {
      if (!dragKey) return;
      ev.preventDefault();
      const target = getLi(ev);
      if (!target) return;
      const src = ul.querySelector(`.dt-tab-item[data-key="${CSS.escape(dragKey)}"]`);
      if (!src || src === target) return;

      target.classList.remove('is-drop-target');

      // Insert before target
      try { ul.insertBefore(src, target); } catch (e) {}

      // Persist order
      const nextOrder = Array.from(ul.querySelectorAll('.dt-tab-item')).map(li => String(li.dataset.key || '')).filter(Boolean);
      const p = loadPrefs();
      const next = { ...p, tabOrder: uniq(nextOrder) };
      saveApply(next);
      toast('Порядок вкладок сохранён');
    });
  }

  function initControls() {
    const elCompact = byId('dt-layout-compact');
    const elHideHints = byId('dt-layout-hide-hints');
    const elHideCardDesc = byId('dt-layout-hide-card-desc');
    const elHideFmHotkeys = byId('dt-layout-hide-fm-hotkeys');
    const elHideUnused = byId('dt-layout-hide-unused');
    const elContainer = byId('dt-layout-container');
    const elDescScale = byId('dt-layout-desc-scale');
    const elResetTabs = byId('dt-layout-tabs-reset');

    if (!elCompact && !elHideHints && !elHideCardDesc && !elHideFmHotkeys && !elHideUnused && !elContainer && !elDescScale && !elResetTabs) return;

    const sync = () => {
      const p = loadPrefs();
      try {
        if (elCompact) elCompact.checked = !!p.compact;
        if (elHideHints) elHideHints.checked = !!p.hideHints;
        if (elHideCardDesc) elHideCardDesc.checked = !!p.hideCardDesc;
        if (elHideFmHotkeys) elHideFmHotkeys.checked = !!p.hideFmHotkeys;
        if (elHideUnused) elHideUnused.checked = !!p.hideUnused;
        if (elContainer) elContainer.value = String(p.container || 'fluid');
        if (elDescScale) elDescScale.value = String((typeof p.cardDescScale === 'number' || typeof p.cardDescScale === 'string') ? p.cardDescScale : 1);
      } catch (e) {}
      renderTabs(p);
    };

    sync();

    const onChange = () => {
      const p = loadPrefs();
      const next = {
        ...p,
        compact: elCompact ? !!elCompact.checked : !!p.compact,
        hideHints: elHideHints ? !!elHideHints.checked : !!p.hideHints,
        hideCardDesc: elHideCardDesc ? !!elHideCardDesc.checked : !!p.hideCardDesc,
        hideFmHotkeys: elHideFmHotkeys ? !!elHideFmHotkeys.checked : !!p.hideFmHotkeys,
        hideUnused: elHideUnused ? !!elHideUnused.checked : !!p.hideUnused,
        container: elContainer ? String(elContainer.value || 'fluid') : String(p.container || 'fluid'),
        cardDescScale: elDescScale ? Number(elDescScale.value || 1) : (typeof p.cardDescScale === 'number' ? p.cardDescScale : 1),
      };
      saveApply(next);
      toast('Layout: применено');
    };

    [elCompact, elHideHints, elHideCardDesc, elHideFmHotkeys, elHideUnused, elContainer, elDescScale].forEach((el) => {
      if (!el) return;
      if (el.dataset && el.dataset.xkeenWired === '1') return;
      el.addEventListener('change', onChange);
      if (el.dataset) el.dataset.xkeenWired = '1';
    });

    if (elResetTabs && (!elResetTabs.dataset || elResetTabs.dataset.xkeenWired !== '1')) {
      elResetTabs.addEventListener('click', () => {
        const p = loadPrefs();
        const next = { ...p, tabOrder: [], tabFav: [] };
        saveApply(next);
        sync();
        toast('Вкладки: сброшено');
      });
      if (elResetTabs.dataset) elResetTabs.dataset.xkeenWired = '1';
    }

    // Sync UI if prefs were changed in another tab
    try {
      window.addEventListener('storage', (ev) => {
        if (!ev || ev.key !== 'xkeen-layout-v1') return;
        sync();
      });
    } catch (e) {}
  }

  Feature.init = function init() {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initControls);
    else initControls();
  };

  try { Feature.init(); } catch (e) {}
})();
