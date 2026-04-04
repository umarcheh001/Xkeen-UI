import { getXkeenPageName } from '../features/xkeen_runtime.js';
import { getTopLevelRouterApi } from './top_level_router.js';

function getDocumentRef(root) {
  if (root && typeof root.querySelectorAll === 'function') return root;
  try {
    return document || null;
  } catch (e) {
    return null;
  }
}

function getLocationRef() {
  try {
    return window.location || null;
  } catch (e) {
    return null;
  }
}

function shouldBypassNavigationInterception(event, el) {
  if (!event) return false;
  if (event.defaultPrevented) return true;
  if (typeof event.button === 'number' && event.button !== 0) return true;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return true;

  try {
    const target = String((el && el.getAttribute && el.getAttribute('target')) || '').trim().toLowerCase();
    if (target && target !== '_self') return true;
  } catch (e) {}

  try {
    if (el && typeof el.hasAttribute === 'function' && el.hasAttribute('download')) return true;
  } catch (e) {}

  return false;
}

function readNavigationHref(el) {
  if (!el) return '';

  try {
    const dataHref = String((el.dataset && el.dataset.navHref) || '').trim();
    if (dataHref) return dataHref;
  } catch (e) {}

  try {
    return String(el.getAttribute('href') || '').trim();
  } catch (e) {
    return '';
  }
}

function resolveInternalUrl(rawHref) {
  const href = String(rawHref || '').trim();
  const locationRef = getLocationRef();
  if (!href || !locationRef) return null;

  try {
    const url = new URL(href, locationRef.href);
    if (String(url.origin || '') !== String(locationRef.origin || '')) return null;
    return url;
  } catch (e) {
    return null;
  }
}

function emitTopLevelNavigationIntent(url, trigger) {
  let href = '';
  let targetUrl = '';
  try {
    if (url && typeof url === 'object' && typeof url.pathname === 'string') {
      href = String(url.pathname || '') + String(url.search || '') + String(url.hash || '');
      targetUrl = String(url.toString());
    } else {
      targetUrl = String(url || '');
      href = targetUrl;
    }
  } catch (e) {
    targetUrl = String(url || '');
    href = targetUrl;
  }

  try {
    window.dispatchEvent(new CustomEvent('xkeen:top-level-nav-intent', {
      detail: {
        from: getXkeenPageName(),
        href,
        url: targetUrl,
        trigger: String(trigger || 'user'),
      },
    }));
  } catch (e) {}
}

export function navigateTopLevelHref(rawHref, opts) {
  const href = String(rawHref || '').trim();
  const locationRef = getLocationRef();
  if (!href || !locationRef) return false;

  const resolved = resolveInternalUrl(href);
  const nextUrl = resolved ? resolved.toString() : href;

  try {
    emitTopLevelNavigationIntent(resolved || nextUrl, opts && opts.trigger);
  } catch (e) {}

  try {
    if (resolved) {
      const router = getTopLevelRouterApi();
      if (router && typeof router.navigate === 'function' && router.navigate(resolved, opts || {})) {
        return true;
      }
    }
  } catch (e) {}

  try {
    if (opts && opts.replace && typeof locationRef.replace === 'function') {
      locationRef.replace(nextUrl);
    } else if (typeof locationRef.assign === 'function') {
      locationRef.assign(nextUrl);
    } else {
      locationRef.href = nextUrl;
    }
    return true;
  } catch (e) {
    return false;
  }
}

export function wireTopLevelNavigation(root) {
  const scope = getDocumentRef(root);
  if (!scope) return 0;

  let wiredCount = 0;
  const nodes = scope.querySelectorAll('[data-xk-top-nav]');
  nodes.forEach((node) => {
    if (!node) return;
    try {
      if (node.dataset && node.dataset.xkTopNavWired === '1') return;
    } catch (e) {}

    node.addEventListener('click', (event) => {
      if (shouldBypassNavigationInterception(event, node)) return;

      const href = readNavigationHref(node);
      if (!href) return;

      event.preventDefault();
      navigateTopLevelHref(href, { trigger: 'click' });
    });

    try {
      if (node.dataset) node.dataset.xkTopNavWired = '1';
    } catch (e) {}
    wiredCount += 1;
  });

  return wiredCount;
}
