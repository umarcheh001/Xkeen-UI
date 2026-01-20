// Auto-migrate legacy browser tooltips (title="...") to themed tooltips (data-tooltip="...").
// + Portal tooltip renderer (fixed-position) to avoid clipping inside overflow/rounded containers.
//
// Motivation: native browser tooltips (title) look чужеродно в тёмной теме
// и не совпадают со стилем подсказок на карточке «Роутинг Xray».
//
// This helper guarantees a consistent tooltip style across the whole UI.
//
// Rules:
//  - If an element has `title` and no `data-tooltip`, we copy title -> data-tooltip and remove title.
//  - If `data-tooltip` already exists, we just remove title to avoid double tooltips.
//  - We skip only <option> (inconsistent across browsers).
//  - Works for dynamic DOM updates (MutationObserver).

(function () {
  'use strict';

  const ATTR = 'data-tooltip';
  // We skip only <option> because it behaves inconsistently across browsers.
  // Inputs/selects/textarea are supported by the portal tooltip renderer.
  const SKIP_TAGS = new Set(['OPTION', 'SCRIPT', 'STYLE']);
  const LEGACY_ATTR = 'data-tip';

  // Portal tooltip (rendered in <body>) prevents tooltip clipping
  // when buttons are inside overflow:hidden/scroll containers.
  const PORTAL_ID = 'xk-tooltip-portal';
  const ENABLE_PORTAL_CLASS = 'xk-tooltip-portal';

  function canUsePortalTooltips() {
    try {
      // Respect touch devices where hover is not a primary interaction.
      // (Older browsers may not support matchMedia for these queries.)
      const mqHover = window.matchMedia ? window.matchMedia('(hover: hover)') : null;
      const mqFine = window.matchMedia ? window.matchMedia('(pointer: fine)') : null;
      if (mqHover && mqHover.matches === false) return false;
      if (mqFine && mqFine.matches === false) return false;
      return true;
    } catch (e) {
      return true;
    }
  }

  function normalizeText(s) {
    if (!s) return '';
    return String(s).replace(/\s+/g, ' ').trim();
  }

  function isInteractiveEl(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'SUMMARY') return true;
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (role === 'button' || role === 'menuitem' || role === 'tab') return true;
    return false;
  }

  function findTooltipHost(el) {
    if (!el || el.nodeType !== 1) return null;
    if (isInteractiveEl(el)) return el;
    try {
      return el.closest ? el.closest('button,a,input,select,textarea,summary,[role="button"],[role="menuitem"],[role="tab"]') : null;
    } catch (e) {
      return null;
    }
  }

  function isIconOnlyControl(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      // Common icon-only classes in the UI
      if (el.classList && (el.classList.contains('btn-icon') || el.classList.contains('icon-btn') || el.classList.contains('terminal-tool-btn') || el.classList.contains('terminal-search-btn'))) {
        return true;
      }

      // Minimal visible text ("×", "…" etc.) is still an icon control.
      const text = normalizeText(el.textContent);
      if (!text || text.length <= 2) return true;

      // If it contains an SVG icon and only a very short text, treat it as icon-like.
      const hasSvg = !!(el.querySelector && el.querySelector('svg'));
      if (hasSvg && text.length <= 6) return true;

      return false;
    } catch (e) {
      return false;
    }
  }

  function migrateOne(el) {
    try {
      if (!el || el.nodeType !== 1) return; // Element
      if (SKIP_TAGS.has(el.tagName)) return;

      // Prefer title, but also migrate legacy data-tip (CodeMirror toolbar, etc.)
      const title = normalizeText(el.getAttribute('title'));
      const legacy = normalizeText(el.getAttribute(LEGACY_ATTR));
      const tip = title || legacy;
      if (!tip) return;

      if (!el.hasAttribute(ATTR)) el.setAttribute(ATTR, tip);

      // Remove native / legacy tooltip attributes to avoid double tooltips
      if (title) el.removeAttribute('title');
      if (legacy) el.removeAttribute(LEGACY_ATTR);
    } catch (e) {
      // silent: tooltips are non-critical
    }
  }

  // Optional helper: if an icon-only control has aria-label but no tooltip,
  // create a tooltip from aria-label.
  function maybeAddTooltipFromAriaLabel(el) {
    try {
      if (!el || el.nodeType !== 1) return;
      if (SKIP_TAGS.has(el.tagName)) return;
      const host = findTooltipHost(el);
      if (!host || SKIP_TAGS.has(host.tagName)) return;

      // Do not override explicit tooltips.
      if (host.hasAttribute(ATTR) || host.hasAttribute('title') || host.hasAttribute(LEGACY_ATTR)) return;

      // Some libraries put aria-label on the child (<svg>, <span>) instead of the button.
      const aria = normalizeText(el.getAttribute('aria-label')) || normalizeText(host.getAttribute('aria-label'));
      if (!aria) return;

      // Only for icon-like controls (avoid noisy tooltips on big buttons).
      if (!isIconOnlyControl(host)) return;

      host.setAttribute(ATTR, aria);
    } catch (e) {}
  }

  function migrateTree(root) {
    if (!root) return;

    // If root itself has title
    if (root.nodeType === 1 && root.hasAttribute && root.hasAttribute('title')) {
      migrateOne(root);
    }

    if (!root.querySelectorAll) return;

    const els = root.querySelectorAll('[title],[' + LEGACY_ATTR + ']');
    for (const el of els) migrateOne(el);

    // Auto tooltips for icon-only controls with aria-label
    const ariaEls = root.querySelectorAll('[aria-label]:not([' + ATTR + '])');
    for (const el of ariaEls) maybeAddTooltipFromAriaLabel(el);
  }

  function startObserver() {
    const target = document.body || document.documentElement;
    if (!target) return;

    const obs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes' && (m.attributeName === 'title' || m.attributeName === LEGACY_ATTR)) {
          migrateOne(m.target);
          continue;
        }
        if (m.type === 'attributes' && m.attributeName === 'aria-label') {
          maybeAddTooltipFromAriaLabel(m.target);
          continue;
        }

        if (m.type === 'childList') {
          for (const node of m.addedNodes) {
            if (node && node.nodeType === 1) migrateTree(node);
          }
        }
      }
    });

    obs.observe(target, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['title', LEGACY_ATTR, 'aria-label'],
    });
  }

  function ensurePortal() {
    if (!canUsePortalTooltips()) return null;
    if (document.getElementById(PORTAL_ID)) return document.getElementById(PORTAL_ID);

    // Mark the document so CSS can disable pseudo-element tooltips
    // and avoid double-rendering.
    try {
      document.documentElement.classList.add(ENABLE_PORTAL_CLASS);
    } catch (e) {}

    const portal = document.createElement('div');
    portal.id = PORTAL_ID;
    portal.setAttribute('hidden', '');
    portal.setAttribute('aria-hidden', 'true');
    portal.innerHTML =
      '<div class="xk-tooltip-bubble" role="tooltip">' +
      '  <div class="xk-tooltip-arrow"></div>' +
      '  <div class="xk-tooltip-text"></div>' +
      '</div>';

    try {
      document.body.appendChild(portal);
    } catch (e) {
      // body may not exist yet
      (document.documentElement || document).appendChild(portal);
    }

    return portal;
  }

  function startPortalTooltips() {
    const portal = ensurePortal();
    if (!portal) return;

    const bubble = portal.querySelector('.xk-tooltip-bubble');
    const arrow = portal.querySelector('.xk-tooltip-arrow');
    const textEl = portal.querySelector('.xk-tooltip-text');
    if (!bubble || !arrow || !textEl) return;

    let currentEl = null;
    let raf = 0;

    function hide() {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      currentEl = null;
      portal.setAttribute('hidden', '');
    }

    function positionFor(el) {
      if (!el || !document.documentElement.contains(el)) {
        hide();
        return;
      }

      const tip = normalizeText(el.getAttribute(ATTR));
      if (!tip) {
        hide();
        return;
      }

      // Fill text first, then measure bubble.
      textEl.textContent = tip;
      portal.removeAttribute('hidden');
      portal.style.opacity = '0';

      // Force layout so getBoundingClientRect is correct.
      const rect = el.getBoundingClientRect();
      const bb = bubble.getBoundingClientRect();

      const vw = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
      const vh = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);

      const margin = 10;
      const arrowGap = 10;

      // Prefer "top" placement, but flip if it would go out of viewport.
      const fitsTop = rect.top >= (bb.height + arrowGap + margin);
      const fitsBottom = (vh - rect.bottom) >= (bb.height + arrowGap + margin);
      const pos = fitsTop ? 'top' : (fitsBottom ? 'bottom' : 'top');
      portal.dataset.pos = pos;

      const centerX = rect.left + rect.width / 2;
      let left = centerX - bb.width / 2;
      left = Math.max(margin, Math.min(left, vw - bb.width - margin));

      let top;
      if (pos === 'top') {
        top = rect.top - bb.height - arrowGap;
      } else {
        top = rect.bottom + arrowGap;
      }
      top = Math.max(margin, Math.min(top, vh - bb.height - margin));

      // Arrow should point to element center, but stay within bubble.
      const arrowSize = 12;
      let arrowLeft = centerX - left - arrowSize / 2;
      arrowLeft = Math.max(12, Math.min(arrowLeft, bb.width - arrowSize - 12));
      arrow.style.left = `${arrowLeft}px`;

      portal.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
      portal.style.opacity = '1';
    }

    function showFor(el) {
      if (!el) {
        hide();
        return;
      }

      // Disabled elements don't fire mouse events reliably.
      // (But if we got here, keep showing.)
      currentEl = el;
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => positionFor(el));
    }

    function findTooltipEl(target) {
      if (!target || target.nodeType !== 1) return null;
      // closest() may throw for SVG / older browsers.
      try {
        const el = target.closest ? target.closest('[' + ATTR + ']') : null;
        if (!el) return null;
        if (SKIP_TAGS.has(el.tagName)) return null;
        // Skip empty tooltips
        const tip = normalizeText(el.getAttribute(ATTR));
        if (!tip) return null;
        return el;
      } catch (e) {
        return null;
      }
    }

    // Delegated hover/focus events
    document.addEventListener(
      'mouseover',
      (e) => {
        const el = findTooltipEl(e.target);
        if (!el) return;
        if (el === currentEl) return;
        showFor(el);
      },
      true
    );

    document.addEventListener(
      'mouseout',
      (e) => {
        if (!currentEl) return;
        // If moving within the same element, ignore.
        const related = e.relatedTarget;
        if (related && currentEl && currentEl.contains && currentEl.contains(related)) return;
        const still = related ? findTooltipEl(related) : null;
        if (still && still === currentEl) return;
        hide();
      },
      true
    );

    document.addEventListener(
      'focusin',
      (e) => {
        const el = findTooltipEl(e.target);
        if (!el) return;
        showFor(el);
      },
      true
    );

    document.addEventListener(
      'focusout',
      () => {
        hide();
      },
      true
    );

    // Hide on scroll/resize to avoid "floating" while user scrolls.
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide, true);
    window.addEventListener('blur', hide, true);
    document.addEventListener('keydown', (e) => {
      if (e && e.key === 'Escape') hide();
    });
    document.addEventListener('pointerdown', hide, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      migrateTree(document);
      startObserver();
      startPortalTooltips();
    });
  } else {
    migrateTree(document);
    startObserver();
    startPortalTooltips();
  }
})();
