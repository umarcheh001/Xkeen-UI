// Build/source managed CM6 runtime bridge.
//
// In source mode the page runs directly from static/js/*.entry.js, so we install
// an import map that points bare @codemirror/* specifiers to the locally
// unpacked offline vendor files under /static/vendor/npm/ before loading the
// actual CM6 runtime module.

const CM6_IMPORTS = {
  "@codemirror/autocomplete": new URL('../../vendor/npm/@codemirror/autocomplete/dist/index.js', import.meta.url).href,
  "@codemirror/commands": new URL('../../vendor/npm/@codemirror/commands/dist/index.js', import.meta.url).href,
  "@codemirror/lang-json": new URL('../../vendor/npm/@codemirror/lang-json/dist/index.js', import.meta.url).href,
  "@codemirror/lang-yaml": new URL('../../vendor/npm/@codemirror/lang-yaml/dist/index.js', import.meta.url).href,
  "@codemirror/language": new URL('../../vendor/npm/@codemirror/language/dist/index.js', import.meta.url).href,
  "@codemirror/lint": new URL('../../vendor/npm/@codemirror/lint/dist/index.js', import.meta.url).href,
  "@codemirror/search": new URL('../../vendor/npm/@codemirror/search/dist/index.js', import.meta.url).href,
  "@codemirror/state": new URL('../../vendor/npm/@codemirror/state/dist/index.js', import.meta.url).href,
  "@codemirror/view": new URL('../../vendor/npm/@codemirror/view/dist/index.js', import.meta.url).href,
  "@lezer/common": new URL('../../vendor/npm/@lezer/common/dist/index.js', import.meta.url).href,
  "@lezer/highlight": new URL('../../vendor/npm/@lezer/highlight/dist/index.js', import.meta.url).href,
  "@lezer/json": new URL('../../vendor/npm/@lezer/json/dist/index.js', import.meta.url).href,
  "@lezer/lr": new URL('../../vendor/npm/@lezer/lr/dist/index.js', import.meta.url).href,
  "@lezer/yaml": new URL('../../vendor/npm/@lezer/yaml/dist/index.js', import.meta.url).href,
  "@marijn/find-cluster-break": new URL('../../vendor/npm/@marijn/find-cluster-break/src/index.js', import.meta.url).href,
  "@replit/codemirror-indentation-markers": new URL('../../vendor/npm/@replit/codemirror-indentation-markers/dist/index.js', import.meta.url).href,
  "argparse": new URL('../../vendor/npm/argparse/argparse.js', import.meta.url).href,
  "codemirror": new URL('../../vendor/npm/codemirror/dist/index.js', import.meta.url).href,
  "crelt": new URL('../../vendor/npm/crelt/index.js', import.meta.url).href,
  "js-yaml": new URL('../../vendor/npm/js-yaml/dist/js-yaml.mjs', import.meta.url).href,
  "jsonc-parser": new URL('../../vendor/npm/jsonc-parser/lib/esm/main.js', import.meta.url).href,
  "style-mod": new URL('../../vendor/npm/style-mod/src/style-mod.js', import.meta.url).href,
  "w3c-keyname": new URL('../../vendor/npm/w3c-keyname/index.js', import.meta.url).href,
};

function installImportMap() {
  try {
    if (document.querySelector('script[data-xkeen-cm6-importmap="1"]')) return true;
    const script = document.createElement('script');
    script.type = 'importmap';
    script.dataset.xkeenCm6Importmap = '1';
    script.textContent = JSON.stringify({ imports: CM6_IMPORTS });
    (document.head || document.documentElement).prepend(script);
    return true;
  } catch (e) {
    try { console.error('[xkeen] failed to install CM6 import map', e); } catch (e2) {}
    return false;
  }
}

async function ensureCodeMirror6Runtime() {
  installImportMap();
  try {
    await import('../ui/codemirror6_boot.js?v=20260324cm6');
    return true;
  } catch (e) {
    try { console.error('[xkeen] failed to load CM6 runtime bridge', e); } catch (e2) {}
    return false;
  }
}

await ensureCodeMirror6Runtime();
