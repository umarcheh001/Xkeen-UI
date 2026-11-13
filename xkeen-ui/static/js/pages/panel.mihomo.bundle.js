export async function activate(context) {
  const entry = await import('xk-module/engine.mihomo');
  return entry.activate(context);
}
