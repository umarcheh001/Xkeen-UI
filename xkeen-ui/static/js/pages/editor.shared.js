// Shared editor-side effects for gradual Vite adoption.
//
// These modules publish global editor helpers used by multiple screens, but
// they do not need to sit inside the main shell chunk.

import '../ui/editor_engine.js?v=20260325-devtools';
import '../ui/editor_actions.js?v=20260325-stage3';
import '../ui/editor_toolbar.js?v=20260325-wave3';
import '../ui/editor_links.js?v=20260325-wave3';
import '../ui/diff_engine.js?v=20260428-diff12';
import '../ui/diff_modal.js?v=20260428-diff12';
