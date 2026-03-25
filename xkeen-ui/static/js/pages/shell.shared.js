// Shared shell-side effects for gradual Vite adoption.
//
// These modules are safe to execute as ESM side-effect imports: they keep
// publishing the same XKeen globals, but Vite can now lift them into a shared
// chunk that multiple page entries reuse.

import '../00_state.js';
import '../01_bootstrap.js';
import '../core/xk_store.js';
import '../ui/toast.js';
import '../ui/settings.js?v=20260308-stage2';
import '../features/service_status.js';
