(() => {
  "use strict";

  // Minimal shared store base for upcoming UI-core migration.
  // Goals for this first step:
  // - single, stable place for shared client state
  // - zero behavior changes in existing features
  // - tiny public API that future commits can build upon

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;

  XK.core = XK.core || {};

  const existing = XK.core.store;
  if (existing && Number(existing.__xkStoreVersion || 0) >= 3) {
    XK.store = existing;
    return;
  }

  let state = Object.create(null);
  const subscribers = new Set();
  const eventSubscribers = new Map();
  const UI_SHELL_KEY = "uiShell";
  const UI_MODAL_KEY = "uiModal";
  const UI_SETTINGS_KEY = "uiSettings";
  const UI_TOAST_KEY = "uiToast";
  const UI_SHELL_DEFAULTS = Object.freeze({
    serviceStatus: "",
    currentCore: "",
    version: {
      currentLabel: "",
      currentCommit: "",
      currentBuiltAt: "",
      latestLabel: "",
      latestPublishedAt: "",
      channel: "",
    },
    control: {
      pending: false,
      action: "",
      requestId: 0,
    },
    loading: {
      serviceStatus: false,
      currentCore: true,
      update: true,
    },
    update: {
      visible: false,
      hasUpdate: false,
      label: "",
      title: "",
    },
  });
  const UI_MODAL_DEFAULTS = Object.freeze({
    modals: Object.freeze({}),
  });
  const UI_SETTINGS_DEFAULTS = Object.freeze({
    snapshot: Object.freeze({}),
    loadedFromServer: false,
  });
  const UI_TOAST_DEFAULTS = Object.freeze({
    queue: Object.freeze([]),
  });
  const toastRecent = new Map();
  let toastSequence = 0;

  function noop() {}

  function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function cloneEventMeta(meta) {
    if (!isObject(meta)) return {};
    return Object.assign({}, meta);
  }

  function cloneJsonLike(value) {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item) => cloneJsonLike(item));

    const out = Object.create(null);
    Object.keys(value).forEach((key) => {
      out[key] = cloneJsonLike(value[key]);
    });
    return out;
  }

  function sameJsonLike(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null) return a === b;
    if (typeof a !== "object") return a === b;

    const aIsArray = Array.isArray(a);
    const bIsArray = Array.isArray(b);
    if (aIsArray !== bIsArray) return false;

    if (aIsArray && bIsArray) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i += 1) {
        if (!sameJsonLike(a[i], b[i])) return false;
      }
      return true;
    }

    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;

    for (let i = 0; i < aKeys.length; i += 1) {
      const key = aKeys[i];
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (!sameJsonLike(a[key], b[key])) return false;
    }

    return true;
  }

  function deepMergeJsonLike(base, patch) {
    const left = (base && typeof base === "object") ? base : {};
    const right = (patch && typeof patch === "object") ? patch : {};

    if (Array.isArray(left) || Array.isArray(right)) {
      return cloneJsonLike(Array.isArray(right) ? right : left);
    }

    const out = cloneJsonLike(left);
    Object.keys(right).forEach((key) => {
      const leftValue = out[key];
      const rightValue = right[key];

      if (
        leftValue && rightValue &&
        typeof leftValue === "object" && typeof rightValue === "object" &&
        !Array.isArray(leftValue) && !Array.isArray(rightValue)
      ) {
        out[key] = deepMergeJsonLike(leftValue, rightValue);
        return;
      }

      out[key] = cloneJsonLike(rightValue);
    });

    return out;
  }

  function cloneUiShellState(raw) {
    const source = isObject(raw) ? raw : {};
    const rawVersion = isObject(source.version) ? source.version : {};
    const rawControl = isObject(source.control) ? source.control : {};
    const rawLoading = isObject(source.loading) ? source.loading : {};
    const rawUpdate = isObject(source.update) ? source.update : {};
    const parsedRequestId = Number(rawControl.requestId);

    return {
      serviceStatus: typeof source.serviceStatus === "string" ? source.serviceStatus : UI_SHELL_DEFAULTS.serviceStatus,
      currentCore: typeof source.currentCore === "string" ? source.currentCore : UI_SHELL_DEFAULTS.currentCore,
      version: {
        currentLabel: typeof rawVersion.currentLabel === "string" ? rawVersion.currentLabel : UI_SHELL_DEFAULTS.version.currentLabel,
        currentCommit: typeof rawVersion.currentCommit === "string" ? rawVersion.currentCommit : UI_SHELL_DEFAULTS.version.currentCommit,
        currentBuiltAt: typeof rawVersion.currentBuiltAt === "string" ? rawVersion.currentBuiltAt : UI_SHELL_DEFAULTS.version.currentBuiltAt,
        latestLabel: typeof rawVersion.latestLabel === "string" ? rawVersion.latestLabel : UI_SHELL_DEFAULTS.version.latestLabel,
        latestPublishedAt: typeof rawVersion.latestPublishedAt === "string" ? rawVersion.latestPublishedAt : UI_SHELL_DEFAULTS.version.latestPublishedAt,
        channel: typeof rawVersion.channel === "string" ? rawVersion.channel : UI_SHELL_DEFAULTS.version.channel,
      },
      control: {
        pending: typeof rawControl.pending === "boolean" ? rawControl.pending : UI_SHELL_DEFAULTS.control.pending,
        action: typeof rawControl.action === "string" ? rawControl.action : UI_SHELL_DEFAULTS.control.action,
        requestId: Number.isFinite(parsedRequestId) ? Math.max(0, Math.floor(parsedRequestId)) : UI_SHELL_DEFAULTS.control.requestId,
      },
      loading: {
        serviceStatus: typeof rawLoading.serviceStatus === "boolean" ? rawLoading.serviceStatus : UI_SHELL_DEFAULTS.loading.serviceStatus,
        currentCore: typeof rawLoading.currentCore === "boolean" ? rawLoading.currentCore : UI_SHELL_DEFAULTS.loading.currentCore,
        update: typeof rawLoading.update === "boolean" ? rawLoading.update : UI_SHELL_DEFAULTS.loading.update,
      },
      update: {
        visible: typeof rawUpdate.visible === "boolean" ? rawUpdate.visible : UI_SHELL_DEFAULTS.update.visible,
        hasUpdate: typeof rawUpdate.hasUpdate === "boolean" ? rawUpdate.hasUpdate : UI_SHELL_DEFAULTS.update.hasUpdate,
        label: typeof rawUpdate.label === "string" ? rawUpdate.label : UI_SHELL_DEFAULTS.update.label,
        title: typeof rawUpdate.title === "string" ? rawUpdate.title : UI_SHELL_DEFAULTS.update.title,
      },
    };
  }

  function normalizeModalId(modalId) {
    return String(modalId || "").trim();
  }

  function cloneUiModalState(raw) {
    const source = isObject(raw) ? raw : {};
    const rawModals = isObject(source.modals) ? source.modals : UI_MODAL_DEFAULTS.modals;
    const modals = Object.create(null);

    Object.keys(rawModals).forEach((key) => {
      const id = normalizeModalId(key);
      if (!id) return;
      modals[id] = !!rawModals[key];
    });

    return { modals };
  }

  function cloneUiSettingsState(raw) {
    const source = isObject(raw) ? raw : {};
    const snapshot = isObject(source.snapshot) ? cloneJsonLike(source.snapshot) : cloneJsonLike(UI_SETTINGS_DEFAULTS.snapshot);

    return {
      snapshot: isObject(snapshot) ? snapshot : Object.create(null),
      loadedFromServer: !!source.loadedFromServer,
    };
  }

  function normalizeToastKind(kind) {
    if (typeof kind === "boolean") return kind ? "error" : "success";
    if (typeof kind !== "string") return "success";

    const value = String(kind || "").trim().toLowerCase();
    if (!value) return "success";
    if (value === "danger" || value === "fail" || value === "failed") return "error";
    if (value === "warn") return "warning";
    if (value === "ok") return "success";
    if (value === "success" || value === "info" || value === "warning" || value === "error") return value;
    return "success";
  }

  function nextToastSequence() {
    toastSequence += 1;
    return toastSequence;
  }

  function nextToastUid(sequence) {
    const seq = Number.isFinite(Number(sequence)) ? Math.max(1, Math.floor(Number(sequence))) : nextToastSequence();
    return "toast-" + String(seq);
  }

  function cloneUiToastEntry(raw) {
    const source = isObject(raw) ? raw : {};
    const duration = Number(source.duration);
    const createdAt = Number(source.createdAt);
    const updatedAt = Number(source.updatedAt);

    return {
      uid: typeof source.uid === "string" ? source.uid : "",
      id: typeof source.id === "string" ? source.id : "",
      dedupeKey: typeof source.dedupeKey === "string" ? source.dedupeKey : "",
      message: typeof source.message === "string" ? source.message : "",
      kind: normalizeToastKind(source.kind),
      duration: Number.isFinite(duration) ? Math.max(0, Math.floor(duration)) : 0,
      sticky: !!source.sticky,
      createdAt: Number.isFinite(createdAt) ? Math.max(0, Math.floor(createdAt)) : 0,
      updatedAt: Number.isFinite(updatedAt) ? Math.max(0, Math.floor(updatedAt)) : 0,
    };
  }

  function cloneUiToastState(raw) {
    const source = isObject(raw) ? raw : {};
    const rawQueue = Array.isArray(source.queue) ? source.queue : UI_TOAST_DEFAULTS.queue;
    const queue = [];

    rawQueue.forEach((item) => {
      const entry = cloneUiToastEntry(item);
      if (!entry.uid || !entry.message) return;
      queue.push(entry);
    });

    return { queue };
  }

  function normalizeUiToastPayload(raw) {
    const source = isObject(raw) ? raw : {};
    const duration = Number.isFinite(Number(source.durationMs))
      ? Number(source.durationMs)
      : (Number.isFinite(Number(source.duration)) ? Number(source.duration) : 0);
    const dedupeWindowMs = Number.isFinite(Number(source.dedupeWindowMs))
      ? Math.max(0, Math.floor(Number(source.dedupeWindowMs)))
      : 600;

    return {
      message: String(source.message ?? ""),
      kind: normalizeToastKind(source.kind),
      duration: Number.isFinite(duration) ? Math.max(0, Math.floor(duration)) : 0,
      sticky: !!(source.sticky || source.persist || source.persistent),
      id: source.id ? String(source.id) : "",
      dedupeKey: source.dedupeKey ? String(source.dedupeKey) : "",
      dedupeWindowMs,
      replace: source.replace !== false,
    };
  }

  function resolveUiToastKey(payload) {
    if (!payload) return "";
    if (payload.id) return String(payload.id);
    if (payload.dedupeKey) return String(payload.dedupeKey);
    return String(payload.kind || "success") + "|" + String(payload.message || "");
  }

  function rememberUiToastRecent(key) {
    if (!key) return;
    try {
      toastRecent.set(key, Date.now());
    } catch (error) {}
  }

  function isUiToastRecentDuplicate(key, windowMs) {
    if (!key) return false;
    try {
      const prev = Number(toastRecent.get(key) || 0);
      if (!prev) return false;
      return (Date.now() - prev) < Math.max(0, Number(windowMs || 0));
    } catch (error) {
      return false;
    }
  }

  function createUiToastEntry(payload, existing) {
    const seq = nextToastSequence();
    const current = existing && typeof existing === "object" ? existing : null;

    return {
      uid: current && current.uid ? current.uid : nextToastUid(seq),
      id: payload.id ? String(payload.id) : "",
      dedupeKey: resolveUiToastKey(payload),
      message: String(payload.message || ""),
      kind: normalizeToastKind(payload.kind),
      duration: Number.isFinite(Number(payload.duration)) ? Math.max(0, Math.floor(Number(payload.duration))) : 0,
      sticky: !!payload.sticky,
      createdAt: current && Number.isFinite(Number(current.createdAt)) ? Math.max(0, Math.floor(Number(current.createdAt))) : Date.now(),
      updatedAt: seq,
    };
  }

  function sameUiShellState(a, b) {
    const left = cloneUiShellState(a);
    const right = cloneUiShellState(b);

    return (
      left.serviceStatus === right.serviceStatus &&
      left.currentCore === right.currentCore &&
      left.version.currentLabel === right.version.currentLabel &&
      left.version.currentCommit === right.version.currentCommit &&
      left.version.currentBuiltAt === right.version.currentBuiltAt &&
      left.version.latestLabel === right.version.latestLabel &&
      left.version.latestPublishedAt === right.version.latestPublishedAt &&
      left.version.channel === right.version.channel &&
      left.control.pending === right.control.pending &&
      left.control.action === right.control.action &&
      left.control.requestId === right.control.requestId &&
      left.loading.serviceStatus === right.loading.serviceStatus &&
      left.loading.currentCore === right.loading.currentCore &&
      left.loading.update === right.loading.update &&
      left.update.visible === right.update.visible &&
      left.update.hasUpdate === right.update.hasUpdate &&
      left.update.label === right.update.label &&
      left.update.title === right.update.title
    );
  }

  function sameUiModalState(a, b) {
    const left = cloneUiModalState(a).modals;
    const right = cloneUiModalState(b).modals;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);

    if (leftKeys.length !== rightKeys.length) return false;

    for (let i = 0; i < leftKeys.length; i += 1) {
      const key = leftKeys[i];
      if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
      if (!!left[key] !== !!right[key]) return false;
    }

    return true;
  }

  function sameUiSettingsState(a, b) {
    const left = cloneUiSettingsState(a);
    const right = cloneUiSettingsState(b);

    return (
      left.loadedFromServer === right.loadedFromServer &&
      sameJsonLike(left.snapshot, right.snapshot)
    );
  }

  function sameUiToastState(a, b) {
    const left = cloneUiToastState(a);
    const right = cloneUiToastState(b);
    return sameJsonLike(left.queue, right.queue);
  }

  function getState() {
    return state;
  }

  function get(key, fallbackValue) {
    if (!key) return fallbackValue;
    return Object.prototype.hasOwnProperty.call(state, key) ? state[key] : fallbackValue;
  }

  function notify(nextState, prevState, meta) {
    subscribers.forEach((listener) => {
      try {
        listener(nextState, prevState, meta);
      } catch (error) {
        console.error("[xk_store] subscriber error", error);
      }
    });
  }

  function setState(nextOrPatch, meta) {
    const prevState = state;
    const options = cloneEventMeta(meta);

    let resolved = typeof nextOrPatch === "function" ? nextOrPatch(prevState) : nextOrPatch;

    if (typeof resolved === "undefined") {
      return state;
    }

    if (options.replace === true) {
      state = isObject(resolved) ? resolved : Object.create(null);
      notify(state, prevState, options);
      return state;
    }

    if (!isObject(resolved)) {
      console.warn("[xk_store] ignored non-object patch");
      return state;
    }

    state = Object.assign({}, prevState, resolved);
    notify(state, prevState, options);
    return state;
  }

  function set(key, value, meta) {
    if (!key) return state;
    const patch = {};
    patch[String(key)] = value;
    return setState(patch, meta);
  }

  function reset(meta) {
    return setState(Object.create(null), Object.assign({}, meta, { replace: true }));
  }

  function subscribe(listener, options) {
    if (typeof listener !== "function") return noop;

    subscribers.add(listener);

    if (options && options.immediate) {
      try {
        listener(state, state, { immediate: true });
      } catch (error) {
        console.error("[xk_store] immediate subscriber error", error);
      }
    }

    return () => {
      subscribers.delete(listener);
    };
  }

  function emit(eventName, payload) {
    const name = String(eventName || "").trim();
    if (!name) return false;

    const handlers = eventSubscribers.get(name);
    if (!handlers || handlers.size === 0) return false;

    handlers.forEach((handler) => {
      try {
        handler(payload);
      } catch (error) {
        console.error("[xk_store] event handler error", error);
      }
    });

    return true;
  }

  function on(eventName, handler) {
    const name = String(eventName || "").trim();
    if (!name || typeof handler !== "function") return noop;

    let handlers = eventSubscribers.get(name);
    if (!handlers) {
      handlers = new Set();
      eventSubscribers.set(name, handlers);
    }

    handlers.add(handler);

    return () => {
      const current = eventSubscribers.get(name);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) {
        eventSubscribers.delete(name);
      }
    };
  }

  function getUiShellState() {
    return cloneUiShellState(get(UI_SHELL_KEY, null));
  }

  function getUiModalState() {
    return cloneUiModalState(get(UI_MODAL_KEY, null));
  }

  function getUiSettingsState() {
    return cloneUiSettingsState(get(UI_SETTINGS_KEY, null));
  }

  function getUiToastState() {
    return cloneUiToastState(get(UI_TOAST_KEY, null));
  }

  function setUiShellState(nextState, meta) {
    return set(UI_SHELL_KEY, cloneUiShellState(nextState), meta);
  }

  function setUiModalState(nextState, meta) {
    return set(UI_MODAL_KEY, cloneUiModalState(nextState), meta);
  }

  function setUiSettingsState(nextState, meta) {
    return set(UI_SETTINGS_KEY, cloneUiSettingsState(nextState), meta);
  }

  function setUiToastState(nextState, meta) {
    return set(UI_TOAST_KEY, cloneUiToastState(nextState), meta);
  }

  function patchUiShellState(patch, meta) {
    const current = getUiShellState();
    const extra = isObject(patch) ? patch : {};
    const next = {
      serviceStatus: Object.prototype.hasOwnProperty.call(extra, "serviceStatus") ? String(extra.serviceStatus || "") : current.serviceStatus,
      currentCore: Object.prototype.hasOwnProperty.call(extra, "currentCore") ? String(extra.currentCore || "") : current.currentCore,
      version: Object.assign({}, current.version),
      control: Object.assign({}, current.control),
      loading: Object.assign({}, current.loading),
      update: Object.assign({}, current.update),
    };

    if (isObject(extra.version)) {
      if (Object.prototype.hasOwnProperty.call(extra.version, "currentLabel")) next.version.currentLabel = String(extra.version.currentLabel || "");
      if (Object.prototype.hasOwnProperty.call(extra.version, "currentCommit")) next.version.currentCommit = String(extra.version.currentCommit || "");
      if (Object.prototype.hasOwnProperty.call(extra.version, "currentBuiltAt")) next.version.currentBuiltAt = String(extra.version.currentBuiltAt || "");
      if (Object.prototype.hasOwnProperty.call(extra.version, "latestLabel")) next.version.latestLabel = String(extra.version.latestLabel || "");
      if (Object.prototype.hasOwnProperty.call(extra.version, "latestPublishedAt")) next.version.latestPublishedAt = String(extra.version.latestPublishedAt || "");
      if (Object.prototype.hasOwnProperty.call(extra.version, "channel")) next.version.channel = String(extra.version.channel || "");
    }

    if (isObject(extra.control)) {
      if (Object.prototype.hasOwnProperty.call(extra.control, "pending")) next.control.pending = !!extra.control.pending;
      if (Object.prototype.hasOwnProperty.call(extra.control, "action")) next.control.action = String(extra.control.action || "");
      if (Object.prototype.hasOwnProperty.call(extra.control, "requestId")) {
        const requestId = Number(extra.control.requestId);
        next.control.requestId = Number.isFinite(requestId) ? Math.max(0, Math.floor(requestId)) : 0;
      }
    }

    if (isObject(extra.loading)) {
      if (Object.prototype.hasOwnProperty.call(extra.loading, "serviceStatus")) next.loading.serviceStatus = !!extra.loading.serviceStatus;
      if (Object.prototype.hasOwnProperty.call(extra.loading, "currentCore")) next.loading.currentCore = !!extra.loading.currentCore;
      if (Object.prototype.hasOwnProperty.call(extra.loading, "update")) next.loading.update = !!extra.loading.update;
    }

    if (isObject(extra.update)) {
      if (Object.prototype.hasOwnProperty.call(extra.update, "visible")) next.update.visible = !!extra.update.visible;
      if (Object.prototype.hasOwnProperty.call(extra.update, "hasUpdate")) next.update.hasUpdate = !!extra.update.hasUpdate;
      if (Object.prototype.hasOwnProperty.call(extra.update, "label")) next.update.label = String(extra.update.label || "");
      if (Object.prototype.hasOwnProperty.call(extra.update, "title")) next.update.title = String(extra.update.title || "");
    }

    return setUiShellState(next, meta);
  }

  function patchUiModalState(patch, meta) {
    const current = getUiModalState();
    const next = {
      modals: Object.assign(Object.create(null), current.modals),
    };
    const extra = isObject(patch) ? patch : {};
    const rawModals = isObject(extra.modals) ? extra.modals : extra;

    if (!isObject(rawModals)) {
      return current;
    }

    Object.keys(rawModals).forEach((key) => {
      const id = normalizeModalId(key);
      if (!id) return;

      if (rawModals[key] == null || rawModals[key] === false) {
        delete next.modals[id];
        return;
      }

      next.modals[id] = true;
    });

    return setUiModalState(next, meta);
  }

  function patchUiSettingsState(patch, meta) {
    const current = getUiSettingsState();
    const extra = isObject(patch) ? patch : {};
    const hasSnapshot = Object.prototype.hasOwnProperty.call(extra, "snapshot");
    const hasLoaded = Object.prototype.hasOwnProperty.call(extra, "loadedFromServer");
    const snapshotPatch = hasSnapshot
      ? extra.snapshot
      : (() => {
          const rootPatch = Object.assign({}, extra);
          try { delete rootPatch.loadedFromServer; } catch (e) {}
          return rootPatch;
        })();

    const next = {
      snapshot: current.snapshot,
      loadedFromServer: hasLoaded ? !!extra.loadedFromServer : current.loadedFromServer,
    };

    if (isObject(snapshotPatch)) {
      next.snapshot = deepMergeJsonLike(current.snapshot, snapshotPatch);
    }

    return setUiSettingsState(next, meta);
  }

  function patchUiToastState(patch, meta) {
    const current = getUiToastState();
    const extra = isObject(patch) ? patch : {};

    if (!Array.isArray(extra.queue)) {
      return current;
    }

    return setUiToastState({
      queue: extra.queue,
    }, meta);
  }

  function subscribeUiShellState(listener, options) {
    if (typeof listener !== "function") return noop;

    let previous = getUiShellState();

    if (options && options.immediate) {
      try {
        listener(previous, previous, { immediate: true });
      } catch (error) {
        console.error("[xk_store] immediate uiShell subscriber error", error);
      }
    }

    return subscribe((nextRoot) => {
      const next = cloneUiShellState(nextRoot && nextRoot[UI_SHELL_KEY]);
      if (sameUiShellState(previous, next)) return;
      const prev = previous;
      previous = next;
      try {
        listener(next, prev, { source: "uiShell" });
      } catch (error) {
        console.error("[xk_store] uiShell subscriber error", error);
      }
    });
  }

  function subscribeUiModalState(listener, options) {
    if (typeof listener !== "function") return noop;

    let previous = getUiModalState();

    if (options && options.immediate) {
      try {
        listener(previous, previous, { immediate: true });
      } catch (error) {
        console.error("[xk_store] immediate uiModal subscriber error", error);
      }
    }

    return subscribe((nextRoot) => {
      const next = cloneUiModalState(nextRoot && nextRoot[UI_MODAL_KEY]);
      if (sameUiModalState(previous, next)) return;
      const prev = previous;
      previous = next;
      try {
        listener(next, prev, { source: "uiModal" });
      } catch (error) {
        console.error("[xk_store] uiModal subscriber error", error);
      }
    });
  }

  function subscribeUiSettingsState(listener, options) {
    if (typeof listener !== "function") return noop;

    let previous = getUiSettingsState();

    if (options && options.immediate) {
      try {
        listener(previous, previous, { immediate: true });
      } catch (error) {
        console.error("[xk_store] immediate uiSettings subscriber error", error);
      }
    }

    return subscribe((nextRoot, prevRoot, meta) => {
      const next = cloneUiSettingsState(nextRoot && nextRoot[UI_SETTINGS_KEY]);
      if (sameUiSettingsState(previous, next)) return;
      const prev = previous;
      previous = next;
      try {
        listener(next, prev, Object.assign({}, meta, {
          source: meta && meta.source ? meta.source : "uiSettings",
        }));
      } catch (error) {
        console.error("[xk_store] uiSettings subscriber error", error);
      }
    });
  }

  function subscribeUiToastState(listener, options) {
    if (typeof listener !== "function") return noop;

    let previous = getUiToastState();

    if (options && options.immediate) {
      try {
        listener(previous, previous, { immediate: true });
      } catch (error) {
        console.error("[xk_store] immediate uiToast subscriber error", error);
      }
    }

    return subscribe((nextRoot, prevRoot, meta) => {
      const next = cloneUiToastState(nextRoot && nextRoot[UI_TOAST_KEY]);
      if (sameUiToastState(previous, next)) return;
      const prev = previous;
      previous = next;
      try {
        listener(next, prev, Object.assign({}, meta, {
          source: meta && meta.source ? meta.source : "uiToast",
        }));
      } catch (error) {
        console.error("[xk_store] uiToast subscriber error", error);
      }
    });
  }

  function isUiModalOpen(modalId) {
    const id = normalizeModalId(modalId);
    if (!id) return false;
    return !!getUiModalState().modals[id];
  }

  function setUiModalOpen(modalId, isOpen, meta) {
    const id = normalizeModalId(modalId);
    if (!id) return getUiModalState();

    const current = getUiModalState();
    const prevOpen = !!current.modals[id];
    const nextOpen = !!isOpen;
    if (prevOpen === nextOpen) return current;

    const next = {
      modals: Object.assign(Object.create(null), current.modals),
    };

    if (nextOpen) next.modals[id] = true;
    else delete next.modals[id];

    return setUiModalState(next, meta);
  }

  function subscribeUiModalOpen(modalId, listener, options) {
    const id = normalizeModalId(modalId);
    if (!id || typeof listener !== "function") return noop;

    let previous = isUiModalOpen(id);

    if (options && options.immediate) {
      try {
        listener(previous, previous, { immediate: true, modalId: id });
      } catch (error) {
        console.error("[xk_store] immediate uiModal open subscriber error", error);
      }
    }

    return subscribeUiModalState((nextState) => {
      const next = !!(nextState && nextState.modals && nextState.modals[id]);
      if (previous === next) return;
      const prev = previous;
      previous = next;
      try {
        listener(next, prev, { source: "uiModal", modalId: id });
      } catch (error) {
        console.error("[xk_store] uiModal open subscriber error", error);
      }
    });
  }

  function getUiSettingsSnapshot() {
    return cloneJsonLike(getUiSettingsState().snapshot || Object.create(null));
  }

  function setUiSettingsSnapshot(snapshot, meta) {
    const current = getUiSettingsState();
    return setUiSettingsState({
      snapshot: isObject(snapshot) ? cloneJsonLike(snapshot) : Object.create(null),
      loadedFromServer: current.loadedFromServer,
    }, meta);
  }

  function patchUiSettingsSnapshot(patch, meta) {
    const current = getUiSettingsState();
    const nextSnapshot = isObject(patch)
      ? deepMergeJsonLike(current.snapshot, patch)
      : current.snapshot;

    return setUiSettingsState({
      snapshot: nextSnapshot,
      loadedFromServer: current.loadedFromServer,
    }, meta);
  }

  function isUiSettingsLoadedFromServer() {
    return !!getUiSettingsState().loadedFromServer;
  }

  function setUiSettingsLoadedFromServer(isLoaded, meta) {
    const current = getUiSettingsState();
    if (current.loadedFromServer === !!isLoaded) return current;
    return setUiSettingsState({
      snapshot: current.snapshot,
      loadedFromServer: !!isLoaded,
    }, meta);
  }

  function findUiToastIndex(queue, idOrKey) {
    const needle = String(idOrKey || "").trim();
    if (!needle || !Array.isArray(queue) || queue.length === 0) return -1;

    for (let index = 0; index < queue.length; index += 1) {
      const item = queue[index];
      if (!item) continue;
      if (item.uid === needle || item.id === needle || item.dedupeKey === needle) {
        return index;
      }
    }

    return -1;
  }

  function enqueueUiToast(payload, meta) {
    const options = normalizeUiToastPayload(payload);
    if (!options.message) return null;

    const dedupeKey = resolveUiToastKey(options);
    const currentState = getUiToastState();
    const nextQueue = Array.isArray(currentState.queue) ? currentState.queue.slice() : [];
    let existingIndex = -1;
    let existingEntry = null;

    if (options.id) {
      existingIndex = nextQueue.findIndex((item) => !!item && item.id === options.id);
      existingEntry = existingIndex >= 0 ? nextQueue[existingIndex] : null;

      if (existingEntry && options.replace === false) {
        nextQueue.splice(existingIndex, 1);
        existingIndex = -1;
        existingEntry = null;
      }
    } else {
      existingIndex = nextQueue.findIndex((item) => !!item && item.dedupeKey === dedupeKey);
      existingEntry = existingIndex >= 0 ? nextQueue[existingIndex] : null;
    }

    if (!existingEntry && !options.id && isUiToastRecentDuplicate(dedupeKey, options.dedupeWindowMs)) {
      return null;
    }

    const entry = createUiToastEntry(Object.assign({}, options, {
      dedupeKey,
    }), existingEntry);

    if (existingIndex >= 0) {
      nextQueue[existingIndex] = entry;
    } else {
      nextQueue.push(entry);
    }

    rememberUiToastRecent(dedupeKey);
    setUiToastState({
      queue: nextQueue,
    }, Object.assign({}, meta, {
      source: meta && meta.source ? meta.source : "uiToast",
    }));

    return cloneUiToastEntry(entry);
  }

  function dismissUiToast(idOrKey, meta) {
    const currentState = getUiToastState();
    const nextQueue = Array.isArray(currentState.queue) ? currentState.queue.slice() : [];
    const index = findUiToastIndex(nextQueue, idOrKey);
    if (index < 0) return false;

    nextQueue.splice(index, 1);
    setUiToastState({
      queue: nextQueue,
    }, Object.assign({}, meta, {
      source: meta && meta.source ? meta.source : "uiToast",
    }));
    return true;
  }

  function clearUiToasts(meta) {
    try {
      toastRecent.clear();
    } catch (error) {}

    const currentState = getUiToastState();
    if (!currentState.queue.length) return currentState;

    return setUiToastState({
      queue: [],
    }, Object.assign({}, meta, {
      source: meta && meta.source ? meta.source : "uiToast",
    }));
  }

  function isUiToastActive(idOrKey) {
    return findUiToastIndex(getUiToastState().queue, idOrKey) >= 0;
  }

  const api = {
    __xkStoreVersion: 3,
    getState,
    setState,
    subscribe,
    emit,
    on,
    get,
    set,
    reset,
  };

  const uiShellApi = {
    KEY: UI_SHELL_KEY,
    DEFAULTS: cloneUiShellState(UI_SHELL_DEFAULTS),
    getState: getUiShellState,
    setState: setUiShellState,
    patchState: patchUiShellState,
    subscribe: subscribeUiShellState,
  };

  const uiModalApi = {
    KEY: UI_MODAL_KEY,
    DEFAULTS: cloneUiModalState(UI_MODAL_DEFAULTS),
    getState: getUiModalState,
    setState: setUiModalState,
    patchState: patchUiModalState,
    subscribe: subscribeUiModalState,
    isOpen: isUiModalOpen,
    setOpen: setUiModalOpen,
    open(modalId, meta) {
      return setUiModalOpen(modalId, true, meta);
    },
    close(modalId, meta) {
      return setUiModalOpen(modalId, false, meta);
    },
    subscribeModal: subscribeUiModalOpen,
  };

  const uiSettingsApi = {
    KEY: UI_SETTINGS_KEY,
    DEFAULTS: cloneUiSettingsState(UI_SETTINGS_DEFAULTS),
    getState: getUiSettingsState,
    setState: setUiSettingsState,
    patchState: patchUiSettingsState,
    subscribe: subscribeUiSettingsState,
    getSnapshot: getUiSettingsSnapshot,
    setSnapshot: setUiSettingsSnapshot,
    patchSnapshot: patchUiSettingsSnapshot,
    isLoadedFromServer: isUiSettingsLoadedFromServer,
    setLoadedFromServer: setUiSettingsLoadedFromServer,
  };

  const uiToastApi = {
    KEY: UI_TOAST_KEY,
    DEFAULTS: cloneUiToastState(UI_TOAST_DEFAULTS),
    getState: getUiToastState,
    setState: setUiToastState,
    patchState: patchUiToastState,
    subscribe: subscribeUiToastState,
    enqueue: enqueueUiToast,
    dismiss: dismissUiToast,
    clear: clearUiToasts,
    isActive: isUiToastActive,
  };

  XK.core.store = api;
  XK.store = api;
  XK.core.uiShell = uiShellApi;
  XK.uiShell = uiShellApi;
  XK.core.uiModal = uiModalApi;
  XK.uiModal = uiModalApi;
  XK.core.uiSettings = uiSettingsApi;
  XK.uiSettings = uiSettingsApi;
  XK.core.uiToast = uiToastApi;
  XK.uiToast = uiToastApi;
})();
