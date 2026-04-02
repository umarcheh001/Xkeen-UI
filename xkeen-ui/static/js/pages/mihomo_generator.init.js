import { initMihomoGenerator } from '../features/mihomo_generator.js';

function isMihomoGeneratorPage() {
  return !!(
    document.getElementById('profileSelect') ||
    document.getElementById('previewTextarea') ||
    document.getElementById('mihomo-preview-engine-select')
  );
}

function safe(fn) {
  try {
    fn();
  } catch (error) {
    console.error(error);
  }
}

export function initMihomoGeneratorPage() {
  if (!isMihomoGeneratorPage()) return;

  safe(() => {
    initMihomoGenerator();
  });
}

export function bootMihomoGeneratorPage() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMihomoGeneratorPage, { once: true });
    return;
  }

  initMihomoGeneratorPage();
}

export default initMihomoGeneratorPage;
