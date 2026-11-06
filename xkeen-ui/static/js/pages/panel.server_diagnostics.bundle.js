// The server diagnostics window is an optional module. The server announces
// this bundle only while the module is active, so nothing here runs without it.

export async function activate() {
  const mod = await import('xk-module/tool.server-diagnostics');
  if (mod && typeof mod.initProviderDiagnostics === 'function') mod.initProviderDiagnostics();
  return mod;
}
