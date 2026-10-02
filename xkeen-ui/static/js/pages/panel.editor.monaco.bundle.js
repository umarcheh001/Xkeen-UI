// Monaco-owned editor support. Loaded only when the selected editor requests Monaco.

export async function activate() {
  await import('./editor_monaco.shared.js');
  return { ready: true, capability: 'monaco' };
}
