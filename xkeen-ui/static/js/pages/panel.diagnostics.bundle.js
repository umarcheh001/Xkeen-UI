// Resource diagnostics are optional and activate only when their server-owned
// header or modal root is present.

export async function activate() {
  const mod = await import('../features/resource_monitor.js');
  if (mod && typeof mod.initResourceMonitor === 'function') mod.initResourceMonitor();
  return mod && mod.resourceMonitorApi ? mod.resourceMonitorApi : mod;
}
