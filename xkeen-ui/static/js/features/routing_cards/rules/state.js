/*
  routing_cards/rules/state.js
  Centralized state for Rules card (routing_cards).

  RC-07a
*/
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.features = XK.features || {};

  const RC = XK.features.routingCards = XK.features.routingCards || {};
  RC.rules = RC.rules || {};

  const S = RC.rules.state = RC.rules.state || {};

  // Model + source root tracking
  if (!('_model' in S)) S._model = null;
  if (!('_root' in S)) S._root = null;
  if (!('_rootHasKey' in S)) S._rootHasKey = true;

  // UI state
  if (!('_dirty' in S)) S._dirty = false;
  if (!('_filter' in S)) S._filter = '';
  if (!('_disabledRules' in S)) S._disabledRules = [];
  if (!('_ruleSegments' in S)) S._ruleSegments = [];

  // Last error (normalized via RC.common.normalizeError).
  if (!('_error' in S)) S._error = null;
  if (!('_perfLite' in S)) S._perfLite = false;
  if (!('_manualGuiSync' in S)) S._manualGuiSync = false;
  if (!('_rulesStale' in S)) S._rulesStale = false;

  // Expanded items: store object references (stable across reorder)
  if (!('_openSet' in S)) S._openSet = new Set();
  if (!('_balOpenSet' in S)) S._balOpenSet = new Set();

  // Drag & drop reorder state
  if (!('_dragRuleIdx' in S)) S._dragRuleIdx = null;
  if (!('_dropInsertIdx' in S)) S._dropInsertIdx = null;
  if (!('_placeholderEl' in S)) S._placeholderEl = null;

  // Pointer-based DnD state
  if (!('_pDndActive' in S)) S._pDndActive = false;
  if (!('_pDndStarted' in S)) S._pDndStarted = false;
  if (!('_pDndPointerId' in S)) S._pDndPointerId = null;
  if (!('_pDndFromIdx' in S)) S._pDndFromIdx = null;
  if (!('_pDndCardEl' in S)) S._pDndCardEl = null;
  if (!('_pDndGhostEl' in S)) S._pDndGhostEl = null;
  if (!('_pDndBaseLeft' in S)) S._pDndBaseLeft = 0;
  if (!('_pDndBaseTop' in S)) S._pDndBaseTop = 0;
  if (!('_pDndShiftX' in S)) S._pDndShiftX = 0;
  if (!('_pDndShiftY' in S)) S._pDndShiftY = 0;
  if (!('_pDndStartX' in S)) S._pDndStartX = 0;
  if (!('_pDndStartY' in S)) S._pDndStartY = 0;
})();
