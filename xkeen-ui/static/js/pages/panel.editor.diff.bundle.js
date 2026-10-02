// Diff viewer support. It is separate from the light editor runtime.

export async function activate() {
  await import('../ui/diff_engine.js?v=20260430-diff19');
  await import('../ui/diff_modal.js?v=20260907b');
  return { ready: true, capability: 'diff' };
}
