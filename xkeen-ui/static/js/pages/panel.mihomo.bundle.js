export async function activate(context) {
  const entry = await import('./mihomo.module.entry.js');
  return entry.activate(context);
}
