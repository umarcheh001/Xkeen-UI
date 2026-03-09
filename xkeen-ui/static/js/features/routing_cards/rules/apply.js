/*
  routing_cards/rules/apply.js
  Apply Rules-card model back into routing editor (JSON / JSONC-preserve best-effort).

  RC-07c
*/
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.features = XK.features || {};

  const RC = XK.features.routingCards = XK.features.routingCards || {};
  RC.rules = RC.rules || {};

  const C = RC.common || {};
  const IDS = RC.IDS || {};
  const LS_KEYS = RC.LS_KEYS || {};

  const toast = (typeof C.toast === 'function') ? C.toast : function (msg) { try { /* eslint-disable-next-line no-alert */ alert(String(msg || '')); } catch (e) {} };
  const confirmModal = (typeof C.confirmModal === 'function') ? C.confirmModal : async function (opts) {
    const msg = String((opts && (opts.message || opts.text)) || 'Confirm?');
    // eslint-disable-next-line no-restricted-globals
    return confirm(msg);
  };
  const safeJsonParse = (typeof C.safeJsonParse === 'function') ? C.safeJsonParse : function (text) {
    try { return JSON.parse(String(text || '')); } catch (e) { return { __error: e }; }
  };

  const getEditorText = (typeof C.getEditorText === 'function') ? C.getEditorText : function () {
    try {
      const cm = (XK.state && XK.state.routingEditor) ? XK.state.routingEditor : null;
      if (cm && typeof cm.getValue === 'function') return cm.getValue();
    } catch (e) {}
    const ta = document.getElementById('routing-editor');
    return ta ? ta.value : '';
  };

  const setEditorText = (typeof C.setEditorText === 'function') ? C.setEditorText : function (text) {
    try {
      const cm = (XK.state && XK.state.routingEditor) ? XK.state.routingEditor : null;
      if (cm && typeof cm.setValue === 'function') { cm.setValue(String(text || '')); return; }
    } catch (e) {}
    const ta = document.getElementById('routing-editor');
    if (ta) ta.value = String(text || '');
  };

  const buildApplyPreviewLine = (typeof C.buildApplyPreviewLine === 'function') ? C.buildApplyPreviewLine : function () { return ''; };

  const RM = RC.rules.model = RC.rules.model || {};
  const S = RC.rules.state = RC.rules.state || {};

  const RA = RC.rules.apply = RC.rules.apply || {};

  // Feature flag for incremental rollout.
  const JSONC_PRESERVE_ENABLED = true;

  function isJsoncDebugEnabled() {
    try {
      if (C && typeof C.isDebugEnabled === 'function') return !!C.isDebugEnabled();
    } catch (e) {}
    try {
      const k = LS_KEYS.jsoncDebug || 'xk.routing.jsonc.debug';
      return String((localStorage && localStorage.getItem && localStorage.getItem(k)) || '') === '1';
    } catch (e) {
      return false;
    }
  }

  function canPreserve() {
    try {
      if (!JSONC_PRESERVE_ENABLED) return false;
      const jp = (XK.features && XK.features.routingJsoncPreserve) ? XK.features.routingJsoncPreserve : null;
      return !!(jp && typeof jp.locateRoutingObject === 'function');
    } catch (e) {
      return false;
    }
  }
  function _suppressEditorChange(ms) {
    try { S._suppressEditorChange = true; } catch (e) {}
    setTimeout(() => {
      try { S._suppressEditorChange = false; } catch (e) {}
    }, Number(ms || 350));
  }

  function _stableListFromSegments(jp, segments) {
    const arr = Array.isArray(segments) ? segments : [];
    return arr.map((seg) => {
      if (seg && typeof seg.canonical === 'string' && seg.canonical) return seg.canonical;
      if (seg && seg.parsed && typeof jp.stableStringify === 'function') return jp.stableStringify(seg.parsed);
      return '';
    });
  }

  function _stableListFromObjects(jp, arr) {
    const list = Array.isArray(arr) ? arr : [];
    return list.map((item) => (jp && typeof jp.stableStringify === 'function') ? jp.stableStringify(item) : JSON.stringify(item));
  }

  function _sameStableList(a, b) {
    const aa = Array.isArray(a) ? a : [];
    const bb = Array.isArray(b) ? b : [];
    if (aa.length !== bb.length) return false;
    for (let i = 0; i < aa.length; i++) {
      if (String(aa[i] || '') !== String(bb[i] || '')) return false;
    }
    return true;
  }


  function _emitCommentsUx(kind, extra) {
    const detail = Object.assign({ kind: String(kind || '') }, (extra && typeof extra === 'object') ? extra : {});
    try { document.dispatchEvent(new CustomEvent('xkeen:routing-comments-ux', { detail })); } catch (e) {}
  }


  async function applyToEditor(opts) {
      const o = opts || {};
      const silent = !!o.silent;
      const allowLegacyFallback = (o.allowLegacyFallback !== false);
      const confirmLegacyFallback = (o.confirmLegacyFallback !== false);

      // TODO(jsonc-preserve): do not rewrite the whole document; patch only rules/balancers/domainStrategy in JSONC text.
      // Safety guard: do not apply if editor content is empty or currently invalid JSON/JSONC.
      const raw = getEditorText();
      if (!String(raw || '').trim()) {
        if (!silent) toast('Редактор JSON пуст — невозможно применить изменения', true);
        return false;
      }
      const parsed = safeJsonParse(raw);
      if (parsed && parsed.__error) {
        if (!silent) toast('Текущий JSON содержит ошибку — сначала исправьте его в редакторе', true);
        return false;
      }
  
      const m0 = (RM && typeof RM.ensureModel === 'function') ? RM.ensureModel() : { domainStrategy: '', rules: [], balancers: [] };
      const m = (RM && typeof RM.sanitizeModelForExport === 'function') ? RM.sanitizeModelForExport(m0) : m0;
      const debugJsonc = isJsoncDebugEnabled();
  
      const jp = (JSONC_PRESERVE_ENABLED && XK.features && XK.features.routingJsoncPreserve)
        ? XK.features.routingJsoncPreserve
        : null;
  
      // Best-effort: apply routing.rules + routing.balancers + routing.domainStrategy via JSONC patcher.
      // On failure, ask user before falling back to the legacy full rewrite (comments will be lost).
      if (jp && typeof jp.locateRoutingObject === 'function') {
        let fallbackReason = '';
        let debugStage = '';
        let debugError = '';
        const preview = { rules: null, balancers: null, domainStrategy: 'noop' };
        let rulesSegments = null;
        let balancersSegments = null;
  
        try {
          // Work on a copy; only touch the editor if we successfully apply all patches.
          let nextText = raw;
  
          debugStage = 'locateRouting';
          // routing object range (root.routing or routing-only fragment)
          let routingRange = jp.locateRoutingObject(nextText);
          if (!routingRange) {
            fallbackReason = 'Не удалось найти routing-объект в текущем документе.';
            throw new Error('routingRange');
          }
  
          debugStage = 'checkFns';
          // Need a ready JSONC-preserve surface.
          const needFns = [
            'locateArrayByKey',
            'splitJsoncArrayElements',
            'renderRulesArray',
            'renderBalancersArray',
            'renderObjectArrayLiteral',
            'detectObjectIndents',
            'insertKeyValueInObject',
            'applyDomainStrategy',
          ];
          for (const fn of needFns) {
            if (typeof jp[fn] !== 'function') {
              fallbackReason = `JSONC-preserve модуль не готов (${fn}).`;
              throw new Error('missingFn');
            }
          }
  
          // 1) rules
          debugStage = 'rules';
          let rulesRange = jp.locateArrayByKey(nextText, routingRange, 'rules');
          if (rulesRange) {
            const segments = jp.splitJsoncArrayElements(nextText, rulesRange);
            rulesSegments = segments || [];
            const rendered = jp.renderRulesArray(nextText, rulesRange, segments || [], m.rules || []);
            if (!rendered || !rendered.ok || typeof rendered.text !== 'string') {
              fallbackReason = 'Не удалось применить изменения с сохранением комментариев (rules).';
              throw new Error('rules');
            }
            preview.rules = { ...(rendered.stats || {}), inserted: false };
            // Treat pure reorder as "changed" for preview purposes (content may be unchanged).
            if (preview.rules && !preview.rules.inserted && Number(preview.rules.added || 0) === 0 && Number(preview.rules.removed || 0) === 0 && Number(preview.rules.changed || 0) === 0) {
              try {
                const oldList = (rulesSegments || []).map((seg) => (seg && seg.canonical) ? seg.canonical : ((seg && seg.parsed) ? jp.stableStringify(seg.parsed) : ''));
                const newList = (Array.isArray(m.rules) ? m.rules : []).map((r) => jp.stableStringify(r));
                if (oldList.length === newList.length) {
                  let moved = 0;
                  for (let k = 0; k < oldList.length; k++) if (oldList[k] !== newList[k]) moved++;
                  if (moved) preview.rules.changed = moved;
                }
              } catch (e) {}
            }
            nextText = nextText.slice(0, rulesRange.start) + rendered.text + nextText.slice(rulesRange.end);
          } else {
            // If rules key is missing, insert it (legacy rewrite would also add it).
            const ind = jp.detectObjectIndents(nextText, routingRange);
            if (!ind) {
              fallbackReason = 'Не удалось определить отступы routing-объекта для вставки rules.';
              throw new Error('rulesIndent');
            }
            const arrText = jp.renderObjectArrayLiteral(ind.childIndent, String(ind.childIndent || '') + '  ', m.rules || []);
            const ins = jp.insertKeyValueInObject(nextText, routingRange, 'rules', arrText);
            if (!ins || !ins.ok || typeof ins.text !== 'string') {
              fallbackReason = 'Не удалось вставить routing.rules в документ.';
              throw new Error('rulesInsert');
            }
            preview.rules = { added: (Array.isArray(m.rules) ? m.rules.length : 0), changed: 0, removed: 0, unchanged: 0, inserted: true };
            nextText = ins.text;
          }
  
          debugStage = 'relocateRouting2';
          // Re-locate after patching (offsets may have changed)
          routingRange = jp.locateRoutingObject(nextText);
          if (!routingRange) {
            fallbackReason = 'Не удалось повторно найти routing-объект после обновления rules.';
            throw new Error('routingRange2');
          }
  
          // 2) balancers
          debugStage = 'balancers';
          let balancersRange = jp.locateArrayByKey(nextText, routingRange, 'balancers');
          if (balancersRange) {
            const segmentsB = jp.splitJsoncArrayElements(nextText, balancersRange);
            balancersSegments = segmentsB || [];
            const oldBalancersList = _stableListFromSegments(jp, balancersSegments || []);
            const newBalancersList = _stableListFromObjects(jp, m.balancers || []);
            if (_sameStableList(oldBalancersList, newBalancersList)) {
              preview.balancers = { added: 0, changed: 0, removed: 0, unchanged: newBalancersList.length, inserted: false, skipped: true };
            } else {
              const renderedB = jp.renderBalancersArray(nextText, balancersRange, segmentsB || [], m.balancers || []);
              if (!renderedB || !renderedB.ok || typeof renderedB.text !== 'string') {
                fallbackReason = 'Не удалось применить изменения с сохранением комментариев (balancers).';
                throw new Error('balancers');
              }
              preview.balancers = { ...(renderedB.stats || {}), inserted: false };
              // Treat pure reorder as "changed" for preview purposes (content may be unchanged).
              if (preview.balancers && !preview.balancers.inserted && Number(preview.balancers.added || 0) === 0 && Number(preview.balancers.removed || 0) === 0 && Number(preview.balancers.changed || 0) === 0) {
                try {
                  if (oldBalancersList.length === newBalancersList.length) {
                    let moved = 0;
                    for (let k = 0; k < oldBalancersList.length; k++) if (oldBalancersList[k] !== newBalancersList[k]) moved++;
                    if (moved) preview.balancers.changed = moved;
                  }
                } catch (e) {}
              }
              nextText = nextText.slice(0, balancersRange.start) + renderedB.text + nextText.slice(balancersRange.end);
            }
          } else if (Array.isArray(m.balancers) && m.balancers.length) {
            // Missing key: insert only when there are real balancers to persist.
            const indB = jp.detectObjectIndents(nextText, routingRange);
            if (!indB) {
              fallbackReason = 'Не удалось определить отступы routing-объекта для вставки balancers.';
              throw new Error('balIndent');
            }
            const arrTextB = jp.renderObjectArrayLiteral(indB.childIndent, String(indB.childIndent || '') + '  ', m.balancers || []);
            const insB = jp.insertKeyValueInObject(nextText, routingRange, 'balancers', arrTextB);
            if (!insB || !insB.ok || typeof insB.text !== 'string') {
              fallbackReason = 'Не удалось вставить routing.balancers в документ.';
              throw new Error('balInsert');
            }
            preview.balancers = { added: (Array.isArray(m.balancers) ? m.balancers.length : 0), changed: 0, removed: 0, unchanged: 0, inserted: true };
            nextText = insB.text;
          } else {
            preview.balancers = { added: 0, changed: 0, removed: 0, unchanged: 0, inserted: false, skipped: true };
          }
  
          debugStage = 'relocateRouting3';
          // Re-locate after patching (offsets may have changed)
          routingRange = jp.locateRoutingObject(nextText);
          if (!routingRange) {
            fallbackReason = 'Не удалось повторно найти routing-объект после обновления balancers.';
            throw new Error('routingRange3');
          }
  
          // 3) domainStrategy (point replacement/insert without touching surrounding comments)
          debugStage = 'domainStrategy';
          const dsRes = jp.applyDomainStrategy(nextText, routingRange, m.domainStrategy || '');
          if (!dsRes || !dsRes.ok || typeof dsRes.text !== 'string') {
            fallbackReason = 'Не удалось применить изменения domainStrategy с сохранением комментариев.';
            throw new Error('domainStrategy');
          }
          preview.domainStrategy = String(dsRes.action || 'noop');
          nextText = dsRes.text;
  
          // Minimal preview of changes (rules/balancers/domainStrategy)
          const previewLine = buildApplyPreviewLine(preview);
          if (previewLine) toast(previewLine, false);
          _emitCommentsUx('preserved', { message: previewLine || 'Изменения применены с JSONC-preserve.' });
          if (debugJsonc) {
            try {
              // eslint-disable-next-line no-console
              console.info('[routing][jsonc] apply ok', { preview, stage: debugStage });
            } catch (e) {}
          }
  
          // Success: apply to editor
          _suppressEditorChange(400);
          setEditorText(nextText);
          try { S._editorDirtyFromCards = true; } catch (e) {}
          if (RM && typeof RM.markDirty === 'function') RM.markDirty(false);
          if (RM && typeof RM.refreshApplyButtonState === 'function') RM.refreshApplyButtonState();
  
          // Best-effort validate/update UI in routing.js
          try {
            if (XK.routing && typeof XK.routing.validate === 'function') {
              XK.routing.validate();
            }
          } catch (e) {}
  
          return true;
        } catch (e) {
          debugError = String((e && (e.message || e)) || '');
          if (!fallbackReason) fallbackReason = 'Не удалось применить изменения с сохранением комментариев JSONC.';
  
          if (debugJsonc) {
            try {
              // eslint-disable-next-line no-console
              console.warn('[routing][jsonc] fallback', { reason: fallbackReason, stage: debugStage, error: debugError });
            } catch (e2) {}
            toast(`[debug] JSONC-preserve fallback: ${fallbackReason} (stage: ${debugStage})`, false);
          }
  
          const previewLine = buildApplyPreviewLine(preview);
          const explain = [
            'Примечание:',
            '• Комментарии рядом с правилами/балансировщиками обычно сохраняются.',
            '• Если правило/балансировщик менялся, комментарии внутри него могут быть перезаписаны (это ожидаемо).',
          ].join('\n');
  
          const msgParts = [];
          msgParts.push(fallbackReason);
          if (previewLine) msgParts.push(previewLine);
          msgParts.push(explain);
          msgParts.push('Применить старым способом (комментарии будут потеряны)?');
  
          // In auto-sync mode we must never block the UI with confirm dialogs.
          _emitCommentsUx('fallback-needed', { reason: fallbackReason, message: previewLine || '' });

          if (!confirmLegacyFallback) return false;

          const okFallback = await confirmModal({
            title: 'Сохранение комментариев',
            message: msgParts.join('\n\n'),
            okText: 'Применить старым способом',
            cancelText: 'Отмена',
            danger: true,
          });
          if (!okFallback) { _emitCommentsUx('fallback-cancelled', { reason: fallbackReason }); return false; }
        }
      }
  
      if (!allowLegacyFallback) return false;

      // Legacy fallback: rewrite the whole JSON (comments are lost).
      _emitCommentsUx('fallback-used', { message: 'Применён legacy rewrite: комментарии в текущем тексте будут перезаписаны.' });
      const out = (RM && typeof RM.buildRootFromModel === 'function') ? RM.buildRootFromModel() : (m || {});
      const text = JSON.stringify(out, null, 2) + '\n';
      _suppressEditorChange(400);
      setEditorText(text);
      if (RM && typeof RM.markDirty === 'function') RM.markDirty(false);
  
      // Best-effort validate/update UI in routing.js
      try {
        if (XK.routing && typeof XK.routing.validate === 'function') {
          XK.routing.validate();
        }
      } catch (e) {}
  
      return true;
    }


  // Auto-sync helper: debounce apply without toasts and without confirm dialogs.
  let _autoTimer = null;
  let _autoApplying = false;
  let _autoQueued = false;

  function _isAutoApplyEnabled() {
    try {
      const st = (XK && XK.ui && XK.ui.settings && typeof XK.ui.settings.get === 'function') ? XK.ui.settings.get() : null;
      return !(st && st.routing && st.routing.autoApply === false);
    } catch (e) {}
    return true;
  }

  async function _autoApplyNow() {
    if (_autoApplying) { _autoQueued = true; return; }
    _autoApplying = true;
    _autoQueued = false;
    try {
      if (S && S._dirty) {
        await applyToEditor({ silent: true, confirmLegacyFallback: false, allowLegacyFallback: false });
      }
    } catch (e) {
      // silent
    } finally {
      _autoApplying = false;
      if (_autoQueued) {
        _autoQueued = false;
        try { _autoTimer = setTimeout(() => { try { _autoApplyNow(); } catch (e2) {} }, 50); } catch (e2) {}
      }
    }
  }

  function requestAutoApply(opts2) {
    if (!_isAutoApplyEnabled()) return;
    const o2 = (typeof opts2 === 'number') ? { wait: opts2 } : (opts2 || {});
    const wait = Number.isFinite(Number(o2.wait)) ? Number(o2.wait) : 400;
    const immediate = !!o2.immediate || wait <= 0;

    try { if (_autoTimer) clearTimeout(_autoTimer); } catch (e) {}
    _autoTimer = null;

    if (immediate) {
      try { _autoApplyNow(); } catch (e) {}
      return;
    }
    _autoTimer = setTimeout(() => {
      _autoTimer = null;
      try { _autoApplyNow(); } catch (e) {}
    }, wait);
  }

  // Public interface
  RA.applyToEditor = applyToEditor;
  RA.canPreserve = canPreserve;
  RA.requestAutoApply = requestAutoApply;
})();
