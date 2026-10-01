# Stage 5: dynamic frontend loading design

**Date:** 1 October 2026  
**Status:** approved design, implementation pending  
**Scope:** modular Xkeen UI panel frontend after Stage 4 server-side composition

## Purpose

Stage 4 makes initial HTML depend on the active module set. Stage 5 applies
the same ownership boundary to browser assets and runtime side effects. An
active profile must load only frontend code, CSS, API clients and WebSocket
clients owned by its enabled modules.

The implementation preserves the existing public HTML and `pageConfig`
contract. It adds a backward-compatible frontend activation descriptor rather
than deriving runtime eligibility from DOM presence or client-side guesses.

## Runtime contract

`frontend_page_config()` will publish a versioned `frontendModules` object.
It contains only stable, allow-listed identifiers:

- active module IDs;
- bundle keys and load modes;
- owned DOM roots;
- permitted HTTP and WebSocket endpoint prefixes;
- module-owned stylesheet keys.

It never includes a filesystem path, arbitrary import specifier, or a value
from persisted module state that can be executed by the browser. The server
builds this descriptor from the Module Registry, `PANEL_COMPOSITION`, and a
static frontend ownership manifest.

The first manifest covers:

| Module | Bundle key | Loading mode | Owned panel surfaces |
| --- | --- | --- | --- |
| `core` | `panel-core` | startup | shell and `xkeen` workspace |
| `engine.xray` | `panel-routing` | after shell startup | routing and Xray logs |
| `engine.mihomo` | `panel-mihomo` | after shell startup | Mihomo workspace |
| `tool.terminal` | `terminal-lazy` | first terminal action or Commands view | terminal and Commands |
| `tool.files` | `file-manager-lazy` | first Files view or file action | Files workspace |
| `tool.advanced-diagnostics` | `diagnostics-panel` | after first paint when its roots exist | header diagnostics and modal |
| `tool.editor` | `editor-runtime` | first editor action | module-owned editor modals and editors |

Top-level page entrypoints such as DevTools, Backups and Mihomo Generator
remain independently build-managed page entries. They consume the same active
module descriptor when they have module-specific frontend work.

## Loader architecture

A new `panel_module_loader` is the sole panel-level orchestrator for optional
frontend bundles. Its local registry maps the stable bundle keys above to
fixed `import()` factories. That registry is shipped with the application and
is not populated from `modules.json` or network data.

The loader exposes these behaviours:

- `isActive(moduleId)` answers from the server-owned descriptor;
- `ensure(bundleKey, reason)` returns one deduplicated promise per bundle;
- `ensureForView(view)` and `ensureForAction(action)` resolve the owning
  bundle before event replay or view activation;
- `ensureStyles(bundleKey)` creates at most one marked stylesheet link;
- disabled, absent-root and unavailable-route cases return a typed no-op
  result and neither make a request nor show an error toast;
- imports and initialisation failures are reported once with the bundle key
  and remain visible as real console errors.

Bundle modules must expose activation functions rather than perform an API or
WebSocket request as an import-time side effect. The loader marks a bundle
ready only after its import and its activation function complete. This gives a
testable ordering guarantee: feature HTTP/WS work begins only after the
corresponding module is ready.

`panel.screen.bootstrap.js` retains only core shell work and asks the loader
for active engine startup bundles. `panel.view_runtime.js`, the core UI
watcher, and lazy bindings stop importing optional feature implementations
directly. They call the loader through narrow public methods instead.

## Stylesheet ownership

The panel currently has two large shared compatibility stylesheets,
`styles.css` and `panel-operator.css`. They remain base shell styles in this
stage: both contain mixed historical selectors, and mechanical extraction
would risk changing the visible panel without providing a reliable ownership
boundary.

Assets with clear module ownership move behind the loader. The immediate
example is `xterm.css`, removed from the initial document and attached only
when the terminal module is requested. New module CSS must be registered with
the same bundle descriptor and follows the same one-link, retry-safe loading
rule. The Stage 5 contract distinguishes those declared lazy stylesheets from
the two legacy shared base styles so the browser tests make a precise,
defensible assertion.

Full physical classification and extraction of the shared stylesheets is not
claimed as complete by Stage 5. It requires a separate selector inventory and
will be addressed with editor/style modularisation work.

## Error handling and compatibility

Full and legacy-full publish the same active frontend descriptor and preserve
the existing interactive behaviour. Minimal profiles have no descriptor entry
for inactive modules; therefore their loaders cannot import that code.

Missing markup or a backend route for an otherwise active module is handled as
an inert feature boundary. The user does not see an error toast for expected
`module_not_enabled` situations. A user action against an active module whose
bundle fails to load remains a real failure and is logged once, without
replaying the action indefinitely.

No API client or WebSocket connector for an inactive module is initialised.
The loader also avoids creating an inactive module's CSS link. Existing core
requests continue unchanged.

## Test and documentation strategy

A generator produces a Stage 5 frontend-loading contract containing, per
profile, active bundles, roots, lazy CSS and permitted API/WS prefixes. Python
tests keep that snapshot current and protect the server descriptor, the static
allow-list, root guards and removal of direct optional imports.

Playwright runs isolated runtime fixtures for Full, Xray-minimal,
Mihomo-minimal and core-only. Each run observes browser requests, WebSocket
attempts, console errors and rendered roots. The assertions cover:

- inactive bundles and declared module CSS are absent from Network;
- inactive DOM roots and API/WS requests are absent;
- active feature requests happen only after the loader starts that module;
- initial load and opening every available view cause no unexpected console
  errors or expected `module_not_enabled` toast;
- Full and legacy-full preserve their frontend module contract.

The E2E server fixture receives an explicit module profile and writes its own
state before Flask starts. It never modifies the developer's local panel
state. Source-fallback browser runs use canonical module URLs for precise
network assertions; build verification continues to confirm the Vite graph.

On closure, `README-modular-panel-plan.md`, `docs/README.md`, the generated
contract and its companion Markdown report record the completed Stage 5
boundary and the remaining legacy CSS limitation.

## Acceptance criteria

Stage 5 is complete when:

1. The server publishes an allow-listed frontend module descriptor derived
   from active Module Registry state.
2. The panel has one dynamic loader, and optional module code is not pulled
   through static panel bootstrap or compatibility imports.
3. Xray-only never loads Mihomo assets, roots, API or WS; Mihomo-only never
   loads Xray equivalents; core-only loads neither engine nor optional tool
   assets.
4. Terminal, Files, Diagnostics and Editor obey their declared lazy loading
   and DOM/API ownership rules.
5. The terminal stylesheet is lazy; legacy shared styles are documented as
   base compatibility CSS rather than incorrectly treated as module assets.
6. The Python contract suite, frontend build verification and profile-aware
   Playwright Network/Console suite pass.
