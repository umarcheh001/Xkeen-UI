(() => {
  'use strict';

  // Diff engine — public API and scope registry.
  //
  // Editors register their own "diff scope" describing how to read the current
  // buffer, the on-disk baseline, and (optionally) snapshots. The engine is
  // editor-agnostic: it never touches CodeMirror or Monaco directly; that work
  // lives in diff_modal.js (Monaco backend in Phase 1).
  //
  // Public API:
  //   XKeen.ui.diff.registerScope({
  //     scope, label, language,
  //     getCurrent(),                 // string, sync — required
  //     getBaseline?(),              // string|Promise<string>
  //     reloadFromDisk?(),           // string|Promise<string>
  //     listSnapshots?(),            // [{id,label,createdAt}]|Promise<...>
  //     readSnapshot?(id),           // string|Promise<string>
  //     applyText?(newText),         // void|Promise<void> — write back into the
  //                                   // active editor buffer; required for the
  //                                   // diff-modal "apply hunk" toolbar (Phase 5)
  //     applyTextToSide?(side, text),// optional bidirectional apply hook;
  //                                   // `side` is 'left' | 'right'
  //     save?(),                     // optional save hook for the active editor
  //     saveClosesOwner?: boolean,   // true when save closes the parent editor/modal
  //   })
  //   XKeen.ui.diff.unregisterScope(scope)
  //   XKeen.ui.diff.getScope(scope)
  //   XKeen.ui.diff.openForScope(scope, opts?)
  //   XKeen.ui.diff.open({ left, right, language, title, ... })

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  XKeen.ui = XKeen.ui || {};

  const _scopes = Object.create(null);

  function isFn(x) { return typeof x === 'function'; }
  function asString(v) { return v == null ? '' : String(v); }
  function trimKey(v) { return String(v == null ? '' : v).trim(); }

  function normalizeScope(input) {
    const o = (input && typeof input === 'object') ? input : {};
    const key = trimKey(o.scope || o.name || o.id);
    if (!key) return null;
    return {
      scope: key,
      label: trimKey(o.label) || key,
      language: trimKey(o.language) || 'text',
      getCurrent: isFn(o.getCurrent) ? o.getCurrent : null,
      getBaseline: isFn(o.getBaseline) ? o.getBaseline : null,
      reloadFromDisk: isFn(o.reloadFromDisk) ? o.reloadFromDisk : null,
      listSnapshots: isFn(o.listSnapshots) ? o.listSnapshots : null,
      readSnapshot: isFn(o.readSnapshot) ? o.readSnapshot : null,
      applyText: isFn(o.applyText) ? o.applyText : null,
      applyTextToSide: isFn(o.applyTextToSide) ? o.applyTextToSide : null,
      save: isFn(o.save) ? o.save : null,
      saveClosesOwner: !!o.saveClosesOwner,
    };
  }

  function registerScope(input) {
    const next = normalizeScope(input);
    if (!next) return null;
    _scopes[next.scope] = next;
    try {
      document.dispatchEvent(new CustomEvent('xkeen:diff-scope-change', {
        detail: { scope: next.scope, action: 'register' },
      }));
    } catch (e) {}
    return next;
  }

  function unregisterScope(scope) {
    const key = trimKey(scope);
    if (!key || !_scopes[key]) return false;
    try { delete _scopes[key]; } catch (e) { _scopes[key] = null; }
    try {
      document.dispatchEvent(new CustomEvent('xkeen:diff-scope-change', {
        detail: { scope: key, action: 'unregister' },
      }));
    } catch (e) {}
    return true;
  }

  function getScope(scope) {
    const key = trimKey(scope);
    return key ? (_scopes[key] || null) : null;
  }

  function listScopes() {
    return Object.keys(_scopes).map((k) => _scopes[k]).filter(Boolean);
  }

  async function resolveSourceText(scopeDef, descriptor) {
    const def = scopeDef || null;
    const d = (descriptor && typeof descriptor === 'object') ? descriptor : { source: 'buffer' };
    const kind = trimKey(d.source) || 'buffer';

    if (kind === 'text') return asString(d.text);

    if (!def) throw new Error('diff: scope is not registered');

    if (kind === 'buffer') {
      if (!def.getCurrent) throw new Error('diff: scope ' + def.scope + ' has no getCurrent()');
      return asString(def.getCurrent());
    }

    if (kind === 'disk') {
      if (def.getBaseline) {
        const baseline = await Promise.resolve(def.getBaseline());
        if (typeof baseline === 'string' && baseline.length) return baseline;
      }
      if (def.reloadFromDisk) {
        const fresh = await Promise.resolve(def.reloadFromDisk());
        return asString(fresh);
      }
      throw new Error('diff: scope ' + def.scope + ' has no disk baseline');
    }

    if (kind === 'reload') {
      if (!def.reloadFromDisk) throw new Error('diff: scope ' + def.scope + ' has no reloadFromDisk()');
      return asString(await Promise.resolve(def.reloadFromDisk()));
    }

    if (kind === 'snapshot') {
      if (!def.readSnapshot) throw new Error('diff: scope ' + def.scope + ' has no readSnapshot()');
      const snapId = trimKey(d.id || d.snapshotId);
      if (!snapId) throw new Error('diff: snapshot id is required');
      return asString(await Promise.resolve(def.readSnapshot(snapId)));
    }

    throw new Error('diff: unknown source kind "' + kind + '"');
  }

  function getModalApi() {
    try {
      if (XKeen.ui && XKeen.ui.diffModal && isFn(XKeen.ui.diffModal.open)) return XKeen.ui.diffModal;
    } catch (e) {}
    return null;
  }

  function logDiff(scopeKey, leftKind, rightKind) {
    const detail = {
      scope: asString(scopeKey),
      left: asString(leftKind),
      right: asString(rightKind),
    };
    try { console.debug('[diff.compare]', detail); } catch (e) {}
    try {
      const url = '/api/log/event';
      const payload = JSON.stringify(Object.assign({ kind: 'diff.compare' }, detail));
      const init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
        credentials: 'same-origin',
      };
      try {
        const coreHttp = window.XKeen && XKeen.core && XKeen.core.http;
        if (coreHttp && isFn(coreHttp.withCSRF)) {
          const wrapped = coreHttp.withCSRF(init, 'POST');
          if (wrapped) Object.assign(init, wrapped);
        }
      } catch (e) {}
      fetch(url, init).catch(() => {});
    } catch (e) {}
  }

  async function openForScope(scope, opts) {
    const def = getScope(scope);
    if (!def) throw new Error('diff: scope "' + asString(scope) + '" is not registered');

    const o = (opts && typeof opts === 'object') ? opts : {};
    const left = o.left || { source: 'buffer' };
    const right = o.right || { source: 'disk' };

    let leftText = '';
    let rightText = '';
    let leftError = null;
    let rightError = null;

    try { leftText = await resolveSourceText(def, left); } catch (e) { leftError = e; }
    try { rightText = await resolveSourceText(def, right); } catch (e) { rightError = e; }

    const modal = getModalApi();
    if (!modal) throw new Error('diff: diff_modal is not loaded');

    return modal.open({
      title: trimKey(o.title) || ('Сравнить · ' + def.label),
      language: trimKey(o.language) || def.language || 'text',
      mode: trimKey(o.mode) || 'split',
      readOnly: o.readOnly !== false,
      scope: def,
      left: {
        text: leftText,
        descriptor: left,
        title: leftLabelFor(def, left, leftError),
        error: leftError ? String(leftError.message || leftError) : '',
      },
      right: {
        text: rightText,
        descriptor: right,
        title: rightLabelFor(def, right, rightError),
        error: rightError ? String(rightError.message || rightError) : '',
      },
    });
  }

  function describeSource(d) {
    if (!d || typeof d !== 'object') return 'Текст';
    const kind = trimKey(d.source);
    if (kind === 'buffer') return 'Текущий редактор';
    if (kind === 'disk') return 'Последняя сохранённая версия';
    if (kind === 'reload') return 'Файл с диска (перечитать)';
    if (kind === 'snapshot') return 'Снэпшот' + (d.label ? ' · ' + d.label : '');
    if (kind === 'text') return d.label ? String(d.label) : 'Текст';
    return kind || 'Источник';
  }

  function leftLabelFor(def, d, err) {
    return describeSource(d) + (err ? ' (ошибка)' : '');
  }
  function rightLabelFor(def, d, err) {
    return describeSource(d) + (err ? ' (ошибка)' : '');
  }

  async function openRaw(opts) {
    const o = (opts && typeof opts === 'object') ? opts : {};
    const modal = getModalApi();
    if (!modal) throw new Error('diff: diff_modal is not loaded');
    return modal.open(o);
  }

  async function applyTextToScope(scopeKey, newText) {
    const def = getScope(scopeKey);
    if (!def) throw new Error('diff: scope "' + asString(scopeKey) + '" is not registered');
    if (!isFn(def.applyText)) throw new Error('diff: scope ' + def.scope + ' is read-only');
    return await Promise.resolve(def.applyText(asString(newText)));
  }

  XKeen.ui.diff = XKeen.ui.diff || {};
  XKeen.ui.diff.registerScope = registerScope;
  XKeen.ui.diff.unregisterScope = unregisterScope;
  XKeen.ui.diff.getScope = getScope;
  XKeen.ui.diff.listScopes = listScopes;
  XKeen.ui.diff.openForScope = openForScope;
  XKeen.ui.diff.open = openRaw;
  XKeen.ui.diff.resolveSourceText = resolveSourceText;
  XKeen.ui.diff.applyTextToScope = applyTextToScope;
  XKeen.ui.diff.describeSource = describeSource;
  XKeen.ui.diff.logDiff = logDiff;
})();
