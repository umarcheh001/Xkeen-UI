// Module-owned editor runtime. It stays outside the panel startup graph until
// an active engine or editor action needs it.

export async function activate() {
  await import('./editor.shared.js');
  return { ready: true };
}
