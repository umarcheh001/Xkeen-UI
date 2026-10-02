// CodeMirror-owned editor support. Loaded only when a CodeMirror surface is opened.

export async function activate() {
  await import('./codemirror6.shared.js');
  return { ready: true, capability: 'codemirror' };
}
