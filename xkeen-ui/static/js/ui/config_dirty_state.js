(() => {
  window.XKeen = window.XKeen || {};
  XKeen.state = XKeen.state || {};
  XKeen.ui = XKeen.ui || {};

  const scopes = (XKeen.state.configDirtyScopes && typeof XKeen.state.configDirtyScopes === 'object')
    ? XKeen.state.configDirtyScopes
    : Object.create(null);
  XKeen.state.configDirtyScopes = scopes;

  function normalizeKey(value, fallback) {
    const key = String(value || '').trim();
    return key || String(fallback || '');
  }

  function ensureScope(name, opts) {
    const key = normalizeKey(name, 'default');
    if (!scopes[key]) {
      scopes[key] = {
        name: key,
        label: key,
        dirty: false,
        sources: Object.create(null),
        confirmTitle: '',
        confirmMessage: '',
        okText: '',
        cancelText: '',
        updatedAt: 0,
      };
    }

    const scope = scopes[key];
    const patch = opts && typeof opts === 'object' ? opts : null;
    if (patch) {
      if (patch.label != null) scope.label = String(patch.label || key);
      if (patch.confirmTitle != null) scope.confirmTitle = String(patch.confirmTitle || '');
      if (patch.confirmMessage != null) scope.confirmMessage = String(patch.confirmMessage || '');
      if (patch.okText != null) scope.okText = String(patch.okText || '');
      if (patch.cancelText != null) scope.cancelText = String(patch.cancelText || '');
    }
    return scope;
  }

  function cloneSource(name, source) {
    return {
      name: String(name || ''),
      dirty: !!(source && source.dirty),
      label: source && source.label ? String(source.label) : '',
      summary: source && source.summary ? String(source.summary) : '',
      updatedAt: source && typeof source.updatedAt === 'number' ? source.updatedAt : 0,
    };
  }

  function getDirtySources(scope) {
    const out = [];
    if (!scope || !scope.sources) return out;
    Object.keys(scope.sources).forEach((key) => {
      const source = scope.sources[key];
      if (!source || !source.dirty) return;
      out.push(cloneSource(key, source));
    });
    return out;
  }

  function snapshotScope(scope) {
    if (!scope) return null;
    return {
      name: String(scope.name || ''),
      label: String(scope.label || scope.name || ''),
      dirty: !!scope.dirty,
      dirtySources: getDirtySources(scope),
      updatedAt: typeof scope.updatedAt === 'number' ? scope.updatedAt : 0,
    };
  }

  function recomputeScope(scope) {
    if (!scope || !scope.sources) return false;
    let dirty = false;
    Object.keys(scope.sources).forEach((key) => {
      if (dirty) return;
      try {
        if (scope.sources[key] && scope.sources[key].dirty) dirty = true;
      } catch (e) {}
    });
    scope.dirty = dirty;
    scope.updatedAt = Date.now();
    return dirty;
  }

  function emitScopeChange(scope, sourceName) {
    const detail = {
      scope: snapshotScope(scope),
      name: scope ? String(scope.name || '') : '',
      dirty: !!(scope && scope.dirty),
      source: null,
    };

    if (scope && sourceName && scope.sources && scope.sources[sourceName]) {
      detail.source = cloneSource(sourceName, scope.sources[sourceName]);
    }

    try {
      document.dispatchEvent(new CustomEvent('xkeen:config-dirty-change', { detail }));
    } catch (e) {}
  }

  function setDirty(name, sourceName, dirty, opts) {
    const patch = opts && typeof opts === 'object' ? opts : {};
    const scope = ensureScope(name, {
      label: patch.scopeLabel,
      confirmTitle: patch.confirmTitle,
      confirmMessage: patch.confirmMessage,
      okText: patch.okText,
      cancelText: patch.cancelText,
    });
    const sourceKey = normalizeKey(sourceName, 'default');
    const prevScopeDirty = !!scope.dirty;
    const prevSourceDirty = !!(scope.sources[sourceKey] && scope.sources[sourceKey].dirty);

    const source = scope.sources[sourceKey] || { name: sourceKey, dirty: false, label: '', summary: '', updatedAt: 0 };
    source.dirty = !!dirty;
    if (patch.label != null) source.label = String(patch.label || '');
    if (patch.summary != null) source.summary = String(patch.summary || '');
    source.updatedAt = Date.now();
    scope.sources[sourceKey] = source;

    recomputeScope(scope);
    if (prevScopeDirty !== scope.dirty || prevSourceDirty !== source.dirty || patch.forceEvent === true) {
      emitScopeChange(scope, sourceKey);
    }
    return !!source.dirty;
  }

  function clearSource(name, sourceName) {
    const scope = ensureScope(name);
    const sourceKey = normalizeKey(sourceName, 'default');
    if (!scope.sources || !Object.prototype.hasOwnProperty.call(scope.sources, sourceKey)) return false;

    try { delete scope.sources[sourceKey]; } catch (e) { scope.sources[sourceKey] = null; }
    recomputeScope(scope);
    emitScopeChange(scope, sourceKey);
    return true;
  }

  function clearScope(name) {
    const scope = ensureScope(name);
    const hadDirty = !!scope.dirty;
    scope.sources = Object.create(null);
    recomputeScope(scope);
    if (hadDirty) emitScopeChange(scope, '');
    return true;
  }

  function isDirty(name) {
    const key = normalizeKey(name, 'default');
    const scope = scopes[key];
    return !!(scope && scope.dirty);
  }

  function getState(name) {
    const key = normalizeKey(name, 'default');
    return snapshotScope(scopes[key] || ensureScope(key));
  }

  function getDirtyScopes(names) {
    const keys = Array.isArray(names) && names.length
      ? names.map((name) => normalizeKey(name, '')).filter(Boolean)
      : Object.keys(scopes);

    return keys
      .map((key) => snapshotScope(scopes[key]))
      .filter((scope) => !!(scope && scope.dirty));
  }

  function anyDirty(names) {
    return getDirtyScopes(names).length > 0;
  }

  async function confirmDiscard(name, opts) {
    if (!isDirty(name)) return true;

    const scope = ensureScope(name, opts && opts.scope ? opts.scope : null);
    const title = String((opts && opts.title) || scope.confirmTitle || 'Несохранённые изменения');
    const message = String((opts && opts.message) || scope.confirmMessage || ('Во вкладке ' + (scope.label || scope.name) + ' есть несохранённые изменения. Продолжить и потерять их?'));
    const okText = String((opts && opts.okText) || scope.okText || 'Продолжить');
    const cancelText = String((opts && opts.cancelText) || scope.cancelText || 'Отмена');

    try {
      if (window.XKeen && XKeen.ui && typeof XKeen.ui.confirm === 'function') {
        return await XKeen.ui.confirm({
          title,
          message,
          okText,
          cancelText,
          danger: true,
        });
      }
    } catch (e) {}

    try {
      return !!window.confirm(message);
    } catch (e) {}
    return false;
  }

  XKeen.ui.configDirty = {
    CONTRACT_VERSION: 1,
    ensureScope,
    setDirty,
    clearSource,
    clearScope,
    isDirty,
    getState,
    getDirtyScopes,
    anyDirty,
    confirmDiscard,
  };
})();
