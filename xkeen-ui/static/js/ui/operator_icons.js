window.XKeen = window.XKeen || {};
const XKeen = window.XKeen;
XKeen.ui = XKeen.ui || {};

const SPRITE_URL = '/static/icons/operator.svg?v=20260801b';
const SAFE_ICON_NAME = /^[a-z0-9-]+$/;

function iconHref(name) {
  const value = String(name || '').trim().toLowerCase();
  if (!SAFE_ICON_NAME.test(value)) return `${SPRITE_URL}#xk-help`;
  return `${SPRITE_URL}#xk-${value}`;
}

function iconHtml(name, className = '') {
  const extraClass = String(className || '').trim();
  const classes = ['xk-action-icon', extraClass].filter(Boolean).join(' ');
  return `<svg class="${classes}" aria-hidden="true" focusable="false"><use href="${iconHref(name)}"></use></svg>`;
}

function setIcon(target, name, options = {}) {
  if (!target) return null;
  const label = options.label == null ? '' : String(options.label);
  target.innerHTML = `${iconHtml(name, options.className || '')}${label ? `<span class="xk-action-label">${label}</span>` : ''}`;
  return target;
}

XKeen.ui.operatorIcons = Object.freeze({
  spriteUrl: SPRITE_URL,
  href: iconHref,
  html: iconHtml,
  set: setIcon,
});

export { SPRITE_URL, iconHref, iconHtml, setIcon };
