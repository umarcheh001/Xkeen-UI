// Advanced editor capabilities. Imports stay behind the capability allow-list.

export async function activate() {
  await import('../ui/prettier_loader.js');
  await import('../ui/editor_schema.js');
  await import('../ui/schema_quickfixes.js');
  return { ready: true, capabilities: ['prettier', 'quick-fix', 'schema-extended'] };
}
