const stylePromises = Object.create(null);

export function ensureModuleStylesheet(key, href) {
  if (!href) return Promise.resolve(false);
  if (stylePromises[key]) return stylePromises[key];
  stylePromises[key] = new Promise((resolve, reject) => {
    const existing = document.head?.querySelector(`link[data-xk-module-css="${key}"]`);
    if (existing) {
      resolve(true);
      return;
    }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.xkModuleCss = key;
    link.addEventListener('load', () => resolve(true), { once: true });
    link.addEventListener('error', () => {
      link.remove();
      reject(new Error(`failed to load module stylesheet: ${key}`));
    }, { once: true });
    document.head.appendChild(link);
  }).catch((error) => {
    delete stylePromises[key];
    throw error;
  });
  return stylePromises[key];
}
