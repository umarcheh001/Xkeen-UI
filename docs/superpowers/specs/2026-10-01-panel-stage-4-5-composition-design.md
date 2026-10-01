# Panel Stage 4.5 Composition Design

## Goal

Make server-rendered panel HTML a composition of the Stage 3 active module set.
An inactive module must contribute no navigation control, screen root, modal
markup, or module-owned shell slot, including when a browser retains an old
selected view in local storage.

## Scope

This stage changes server-side Jinja composition only. It does not change
frontend bundle loading, dynamic imports, CSS loading, module installation, or
the public Module Registry API; those remain Stage 5 and later work.

## Architecture

`routes/pages.py` will own a static panel composition manifest. Each manifest
entry names its required module ids and one of: a navigation item, a screen
partial, a modal partial, or a module-owned shell slot. The manifest is UI
layout policy, so it stays beside the page renderer instead of adding Jinja
template paths to the generic `services.module_registry` metadata.

For every request, the page route will transform the already calculated Stage
3 `active_module_ids` into a single `page_context` value. Its selected entries
are deterministic and preserve the existing full-page order. `panel.html`,
`panel/navigation.html`, `panel/header.html`, and `panel/shell.html` will
render those selected entries by iteration; they will not repeat independent
`has_xray`, `has_mihomo`, `has_terminal`, or `has_files` gates around each
module-owned partial.

The page context will contain only server-owned, allow-listed template paths
and navigation metadata. No template name or module id comes from browser
state, request input, or local storage.

## Composition Rules

1. The active set is read once from `module_activation` when page routes are
   registered. A missing activation retains the existing legacy/full fallback:
   all known panel entries are eligible.
2. A manifest entry is included only when every required owner module is
   active. Composite ownership remains explicit: the HWID modal needs both
   `integration.happ` and `engine.mihomo`; the file editor modal needs both
   `tool.files` and `tool.editor`.
3. The static shell remains core-owned. Module-owned shell fragments are
   selected through the same context: the Xray routing-focus control, Xray
   logging badge, and diagnostics resource monitor must not remain in a
   profile where their owners are disabled.
4. Navigation items are rendered from ordered metadata. The first available
   in-panel screen is marked active, so a Mihomo-only or core-only page never
   starts with a stale Xray selection. The external Mihomo generator item is
   present only with `engine.mihomo`; donate remains core-owned.
5. Screen and modal markup is selected by its declared owners in the manifest.
   `panel.html` remains the compatible entrypoint and composition root, but
   contains loops over `page_context` rather than a chain of module gates.
6. Existing DOM ids, `data-view`, `data-xk-section`, modal ordering, URLs,
   entrypoint scripts, and full/legacy HTML remain compatible.

## Error Handling and Compatibility

The composition builder returns an empty optional collection for an unknown or
inactive module instead of asking Jinja to render an unavailable partial. A
minimal profile therefore renders the core shell and its allowed navigation
without a template-variable error. The existing section whitelist remains a
client/runtime visibility constraint and does not reintroduce server HTML for
an inactive module.

## Tests

Server-side tests will exercise Full, Legacy, Xray-only, Mihomo-only, and
core-only module sets. They will verify the exact visible navigation views,
screen roots, modal ids, module-owned shell ids, absence of unrendered Jinja
tokens, duplicate-id safety, legacy equivalence, and invariance when active
module input order changes. A static guard will ensure that `panel.html`
consumes the composition context rather than reintroducing per-module include
gates.

## Documentation

Completion adds `docs/modular-panel-stage4.5-composition.md`, marks 4.5 as
closed in `README-modular-panel-plan.md`, advances the next substage to 4.6,
and adds the closure document to `docs/README.md`.
