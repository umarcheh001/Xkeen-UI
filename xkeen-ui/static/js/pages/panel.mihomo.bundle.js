export async function prepare() {
  const entry = await import('xk-module/engine.mihomo');
  await entry.load('bundle');
}

export async function activate(context) {
  const entry = await import('xk-module/engine.mihomo');
  return entry.activate(context);
}
