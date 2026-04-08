import { ensureXkeenRoot } from '../features/xkeen_runtime.js';

const MOUNT_ID = 'xk-top-level-screen-mount';
const GLOBAL_BODY_NODE_IDS = new Set(['xk-tooltip-portal']);

function ensureTopLevelRoot() {
  try {
    const xk = ensureXkeenRoot();
    if (!xk) return null;
    xk.topLevel = xk.topLevel && typeof xk.topLevel === 'object' ? xk.topLevel : {};
    return xk.topLevel;
  } catch (error) {
    return null;
  }
}

function ensureHostState() {
  try {
    const root = ensureTopLevelRoot();
    if (!root) return null;
    root.host = root.host && typeof root.host === 'object' ? root.host : {};
    root.host.styleKeys = root.host.styleKeys instanceof Set ? root.host.styleKeys : new Set();
    return root.host;
  } catch (error) {
    return null;
  }
}

function getDocumentRef() {
  try {
    return document || null;
  } catch (error) {
    return null;
  }
}

function getWindowRef() {
  try {
    return window || null;
  } catch (error) {
    return null;
  }
}

function getBodyRef() {
  const doc = getDocumentRef();
  return doc ? doc.body || null : null;
}

function cloneJson(value) {
  if (value == null) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    return value;
  }
}

function buildPageConfigRegexSource() {
  return /var\s+pageConfig\s*=\s*(\{[\s\S]*?\});\s*window\.XKeen\.pageConfig\s*=\s*pageConfig\s*;/;
}

function extractPageConfigFromDocument(doc) {
  if (!doc) return null;

  const scripts = Array.from(doc.querySelectorAll('script'));
  for (const script of scripts) {
    const text = String(script.textContent || '');
    if (!text.includes('window.XKeen.pageConfig')) continue;
    const match = text.match(buildPageConfigRegexSource());
    if (!match || !match[1]) continue;
    try {
      return JSON.parse(match[1]);
    } catch (error) {}
  }

  return null;
}

function buildStyleKey(node) {
  if (!node || typeof node !== 'object') return '';
  const tagName = String(node.tagName || '').toLowerCase();
  if (tagName === 'link') {
    try {
      const href = String(node.getAttribute('href') || '').trim();
      if (href) return `link:${href}`;
    } catch (error) {}
  }
  if (tagName === 'style') {
    const text = String(node.textContent || '').trim();
    if (text) return `style:${text}`;
  }
  return '';
}

function createScreenRoot(name) {
  const doc = getDocumentRef();
  if (!doc) return null;

  const root = doc.createElement('div');
  root.dataset.xkTopLevelScreenRoot = String(name || '');
  root.hidden = true;
  return root;
}

function shouldKeepBodyNodeGlobal(node) {
  if (!node || node.nodeType !== 1) return false;
  try {
    const id = String(node.id || '').trim();
    return !!(id && GLOBAL_BODY_NODE_IDS.has(id));
  } catch (error) {
    return false;
  }
}

export function ensureTopLevelScreenMount() {
  const doc = getDocumentRef();
  const body = getBodyRef();
  if (!doc || !body) return null;

  let mount = doc.getElementById(MOUNT_ID);
  if (mount) return mount;

  mount = doc.createElement('div');
  mount.id = MOUNT_ID;
  mount.dataset.xkTopLevelScreenMount = '1';

  const firstScript = Array.from(body.children).find((node) => String(node.tagName || '').toLowerCase() === 'script');
  if (firstScript && firstScript.parentNode === body) {
    body.insertBefore(mount, firstScript);
  } else {
    body.appendChild(mount);
  }

  return mount;
}

export function captureCurrentDocumentScreenSnapshot(name) {
  const doc = getDocumentRef();
  const body = getBodyRef();
  const mount = ensureTopLevelScreenMount();
  if (!doc || !body || !mount) return null;

  const root = createScreenRoot(name);
  if (!root) return null;

  const movableNodes = Array.from(body.childNodes).filter((node) => {
    if (!node) return false;
    if (node === mount) return false;
    if (shouldKeepBodyNodeGlobal(node)) return false;
    if (node.nodeType === 1 && String(node.tagName || '').toLowerCase() === 'script') return false;
    return true;
  });

  movableNodes.forEach((node) => {
    root.appendChild(node);
  });

  mount.appendChild(root);
  root.hidden = false;

  return {
    name: String(name || ''),
    root,
    pageConfig: cloneJson(getWindowRef()?.XKeen?.pageConfig || null),
    title: String(doc.title || ''),
    bodyClass: String(body.className || ''),
    styles: [],
    isCurrentDocument: true,
  };
}

function importFetchedBodyNodes(doc, name) {
  const currentDoc = getDocumentRef();
  if (!doc || !currentDoc) return null;

  const root = createScreenRoot(name);
  if (!root) return null;

  const sourceNodes = Array.from(doc.body ? doc.body.childNodes : []).filter((node) => {
    if (!node) return false;
    if (shouldKeepBodyNodeGlobal(node)) return false;
    if (node.nodeType === 1 && String(node.tagName || '').toLowerCase() === 'script') return false;
    return true;
  });

  sourceNodes.forEach((node) => {
    root.appendChild(currentDoc.importNode(node, true));
  });

  return root;
}

function collectFetchedStyles(doc) {
  const currentDoc = getDocumentRef();
  if (!doc || !currentDoc) return [];

  const nodes = Array.from(doc.head ? doc.head.querySelectorAll('link[rel="stylesheet"], style') : []);
  return nodes.map((node) => {
    const clone = currentDoc.importNode(node, true);
    const key = buildStyleKey(clone);
    if (key) clone.dataset.xkTopLevelStyleKey = key;
    return clone;
  });
}

export async function fetchTopLevelScreenSnapshot(name, route) {
  const response = await fetch(String(route || ''), {
    method: 'GET',
    credentials: 'same-origin',
      cache: 'no-store',
    headers: {
      'X-Requested-With': 'XKeenTopLevelScreen',
    },
  });
  if (!response.ok) {
    throw new Error(`screen fetch failed: ${response.status}`);
  }

  const html = await response.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  return {
    name: String(name || ''),
    root: importFetchedBodyNodes(doc, name),
    pageConfig: extractPageConfigFromDocument(doc),
    title: String(doc.title || ''),
    bodyClass: String((doc.body && doc.body.className) || ''),
    styles: collectFetchedStyles(doc),
    isCurrentDocument: false,
  };
}

export function ensureScreenStyles(snapshot) {
  const hostState = ensureHostState();
  const doc = getDocumentRef();
  if (!hostState || !doc || !snapshot || !Array.isArray(snapshot.styles)) return;

  snapshot.styles.forEach((node) => {
    if (!node) return;
    const key = buildStyleKey(node);
    if (key && hostState.styleKeys.has(key)) return;
    if (key) hostState.styleKeys.add(key);
    doc.head.appendChild(node);
  });
}

export function applyScreenDocumentState(snapshot) {
  const doc = getDocumentRef();
  const body = getBodyRef();
  const win = getWindowRef();
  if (!doc || !body || !snapshot) return false;

  if (snapshot.title) doc.title = snapshot.title;
  body.className = String(snapshot.bodyClass || '');

  try {
    win.XKeen = win.XKeen || {};
    win.XKeen.pageConfig = cloneJson(snapshot.pageConfig || null);
  } catch (error) {}

  return true;
}

export function attachScreenRoot(snapshot) {
  const mount = ensureTopLevelScreenMount();
  const root = snapshot && snapshot.root ? snapshot.root : null;
  if (!mount || !root) return false;
  if (root.parentNode !== mount) {
    mount.appendChild(root);
  }
  root.hidden = false;
  return true;
}

export function detachScreenRoot(snapshot) {
  const mount = ensureTopLevelScreenMount();
  const root = snapshot && snapshot.root ? snapshot.root : null;
  if (!mount || !root) return false;
  root.hidden = true;
  if (root.parentNode === mount) {
    mount.removeChild(root);
  }
  return true;
}
