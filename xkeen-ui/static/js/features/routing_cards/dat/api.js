/*
  routing_cards/dat/api.js
  Backend calls for DAT card.

  RC-06c (api)
*/
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.features = XK.features || {};

  const RC = XK.features.routingCards = XK.features.routingCards || {};
  RC.state = RC.state || {};

  RC.dat = RC.dat || {};
  const DAT = RC.dat;

  const IDS = RC.IDS || {};
  const C = RC.common || {};
  const $ = (typeof C.$ === 'function') ? C.$ : (id) => document.getElementById(id);
  const toast = (typeof C.toast === 'function') ? C.toast : function () {};
  const confirmModal = (typeof C.confirmModal === 'function') ? C.confirmModal : async () => true;

  const prefsMod = (DAT && DAT.prefs) ? DAT.prefs : {};
  const normalizePath = (typeof prefsMod.normalizePath === 'function')
    ? prefsMod.normalizePath
    : function (dir, name) {
      const d = String(dir || '').trim().replace(/\/+$/g, '');
      const n = String(name || '').trim().replace(/^\/+/, '');
      if (!d) return '/' + n;
      if (!n) return d;
      return d + '/' + n;
    };

  function safeKind(kind) {
    return (String(kind || '').toLowerCase() === 'geoip') ? 'geoip' : 'geosite';
  }

  // -------- Low-level endpoints --------

  async function statBatch(paths) {
    const resp = await fetch('/api/fs/stat-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'local', paths: paths || [] }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data || data.ok === false) {
      throw new Error((data && (data.error || data.message)) || 'stat_failed');
    }
    return data;
  }

  async function list(path) {
    const p = String(path || '').trim();
    if (!p) return null;
    try {
      const resp = await fetch('/api/fs/list?target=local&path=' + encodeURIComponent(p));
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data || data.ok === false) return null;
      return data;
    } catch (e) {
      return null;
    }
  }

  async function upload(path, file, overwrite) {
    const fd = new FormData();
    fd.append('file', file);
    const url = '/api/fs/upload?target=local&path=' + encodeURIComponent(path) + (overwrite ? '&overwrite=1' : '');
    const resp = await fetch(url, { method: 'POST', body: fd });
    const data = await resp.json().catch(() => ({}));
    return { resp, data };
  }

  function downloadUrl(path) {
    return '/api/fs/download?target=local&path=' + encodeURIComponent(path);
  }

  async function update(kind, url, path) {
    const resp = await fetch('/api/routing/dat/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, url, path }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data || data.ok === false) {
      const msg = (data && (data.error || data.message)) || ('update_failed_' + resp.status);
      throw new Error(msg);
    }
    return data;
  }

  async function getGeodatStatus() {
    try {
      const resp = await fetch('/api/routing/geodat/status', { method: 'GET' });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data || data.ok === false) return { ok: false };
      return data;
    } catch (e) {
      return { ok: false };
    }
  }

  async function installGeodat(opts) {
    const o = opts || {};
    const mode = o.mode || 'release'; // release | url | file
    const url = (o.url ? String(o.url) : '').trim();
    const file = o.file || null;

    // If router arch is unsupported for published releases, avoid running installer.
    try {
      if (mode === 'release') {
        const st = await getGeodatStatus();
        const plat = st && st.platform ? st.platform : null;
        if (plat && plat.supported === false) {
          const note = String(plat.note || '').trim() || 'xk-geodat не поддерживается на этой архитектуре.';
          toast(note, true);
          return { ok: false, error: 'unsupported_arch', reason: note, platform: plat };
        }
      }
    } catch (e) {}

    let title = 'Установка xk-geodat';
    let message = 'Установить/обновить xk-geodat? Это включит просмотр содержимого DAT (GeoIP/GeoSite) и добавление тегов в правила маршрутизации.';
    if (mode === 'url' && url) {
      message = 'Скачать и установить xk-geodat по URL?\n\n' + url;
    } else if (mode === 'file' && file && file.name) {
      message = 'Установить xk-geodat из файла?\n\n' + String(file.name);
    }

    const ok = await confirmModal({
      title,
      message,
      okText: 'Установить',
      cancelText: 'Отмена',
      danger: false,
    });
    if (!ok) return { ok: false, cancelled: true };

    const btnMain = $(IDS.datGeodatInstall);
    const btnFile = $(IDS.datGeodatInstallFileBtn);
    try { if (btnMain) btnMain.disabled = true; } catch (e) {}
    try { if (btnFile) btnFile.disabled = true; } catch (e) {}

    try {
      if (XK && XK.ui && typeof XK.ui.showGlobalXkeenSpinner === 'function') {
        XK.ui.showGlobalXkeenSpinner('Установка xk-geodat…');
      }

      let resp = null;
      if (mode === 'file' && file) {
        const fd = new FormData();
        fd.append('file', file);
        resp = await fetch('/api/routing/geodat/install', { method: 'POST', body: fd });
      } else {
        const body = {};
        if (mode === 'url' && url) body.url = url;
        resp = await fetch('/api/routing/geodat/install', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }

      const data = await (resp ? resp.json().catch(() => ({})) : Promise.resolve({}));
      if (!resp || !resp.ok || !data || data.ok === false) {
        const msg = (data && (data.hint || data.error || data.message)) || (resp ? ('install_failed_' + resp.status) : 'install_failed');
        throw new Error(String(msg));
      }

      const installed = !!data.installed;
      if (installed) {
        toast('xk-geodat установлен.', false);
      } else {
        const hint = String((data.hint || data.error || '')).trim();
        let reason = String((data.reason || data.details || '')).trim();
        if (!reason) reason = String(data.help || '').trim();
        if (!reason) reason = String(data.stderr || '').trim();
        if (reason) {
          try {
            reason = reason.replace(/\r/g, '').split('\n')
              .map((s) => String(s || '').trim())
              .filter(Boolean)
              .slice(0, 3)
              .join(' | ');
            if (reason.length > 240) reason = reason.slice(0, 237) + '...';
          } catch (e) {}
        }
        let msg = 'xk-geodat: установка не выполнена.';
        if (hint) msg += ' ' + hint;
        if (reason && (!hint || hint.indexOf(reason) === -1)) msg += ' Причина: ' + reason;
        toast(msg, true);
      }

      // Let card refresh if available.
      try {
        const refresh = DAT && DAT.card && typeof DAT.card.refreshDatMeta === 'function' ? DAT.card.refreshDatMeta : null;
        if (refresh) await refresh();
      } catch (e) {}

      return data;
    } catch (e) {
      toast('xk-geodat: ошибка установки: ' + String(e && e.message ? e.message : e), true);
      return { ok: false, error: String(e && e.message ? e.message : e) };
    } finally {
      try {
        if (XK && XK.ui && typeof XK.ui.hideGlobalXkeenSpinner === 'function') {
          XK.ui.hideGlobalXkeenSpinner();
        }
      } catch (e) {}
      try { if (btnMain) btnMain.disabled = false; } catch (e) {}
      try { if (btnFile) btnFile.disabled = false; } catch (e) {}
    }
  }

  // -------- High-level actions (kind-based) --------

  async function uploadDat(kind) {
    const k = safeKind(kind);
    const prefs = (typeof prefsMod.load === 'function') ? prefsMod.load() : {};
    const p = prefs && prefs[k] ? prefs[k] : null;
    if (!p) return;

    const path = normalizePath(p.dir, p.name);

    const inputId = (k === 'geosite') ? IDS.datGeositeFile : IDS.datGeoipFile;
    const fi = $(inputId);
    if (!fi) return;

    fi.value = '';
    fi.onchange = async () => {
      const file = fi.files && fi.files[0];
      if (!file) return;

      const ok = await confirmModal({
        title: 'Upload DAT',
        message: `Загрузить файл ${file.name} в ${path}?`,
        okText: 'Загрузить',
        cancelText: 'Отмена',
      });
      if (!ok) return;

      try {
        let r = await upload(path, file, false);
        if (r.resp && r.resp.status === 409) {
          const ow = await confirmModal({
            title: 'Файл уже существует',
            message: `Файл ${path} уже существует. Перезаписать?`,
            okText: 'Перезаписать',
            cancelText: 'Отмена',
            danger: true,
          });
          if (!ow) return;
          r = await upload(path, file, true);
        }

        if (!r.resp || !r.resp.ok || r.data.ok === false) {
          throw new Error((r.data && (r.data.error || r.data.message)) || (r.resp ? ('upload_failed_' + r.resp.status) : 'upload_failed'));
        }

        toast('DAT загружен: ' + path, false);
        try {
          const refresh = DAT && DAT.card && typeof DAT.card.refreshDatMeta === 'function' ? DAT.card.refreshDatMeta : null;
          if (refresh) refresh();
        } catch (e) {}
      } catch (e) {
        toast('Upload failed: ' + String(e && e.message ? e.message : e), true);
      }
    };

    fi.click();
  }

  async function downloadDat(kind) {
    const k = safeKind(kind);
    const prefs = (typeof prefsMod.load === 'function') ? prefsMod.load() : {};
    const p = prefs && prefs[k] ? prefs[k] : null;
    if (!p) return;

    const path = normalizePath(p.dir, p.name);
    try {
      window.open(downloadUrl(path), '_blank');
    } catch (e) {
      toast('Download failed: ' + String(e && e.message ? e.message : e), true);
    }
  }

  async function updateDatByUrl(kind) {
    const k = safeKind(kind);
    const prefs = (typeof prefsMod.load === 'function') ? prefsMod.load() : {};
    const p = prefs && prefs[k] ? prefs[k] : null;
    if (!p) return;

    const path = normalizePath(p.dir, p.name);
    const url = String(p.url || '').trim();

    if (!url || !(url.startsWith('http://') || url.startsWith('https://'))) {
      toast('Укажите корректный URL (http/https)', true);
      return;
    }

    const ok = await confirmModal({
      title: 'Update DAT by URL',
      message: `Скачать ${k} из URL и заменить файл?\n\n${url}\n→ ${path}`,
      okText: 'Обновить',
      cancelText: 'Отмена',
      danger: true,
    });
    if (!ok) return;

    try {
      await update(k, url, path);
      toast('DAT обновлён: ' + path, false);
      try {
        const refresh = DAT && DAT.card && typeof DAT.card.refreshDatMeta === 'function' ? DAT.card.refreshDatMeta : null;
        if (refresh) refresh();
      } catch (e) {}
    } catch (e) {
      toast('Update failed: ' + String(e && e.message ? e.message : e), true);
    }
  }

  DAT.api = DAT.api || {};
  DAT.api.statBatch = statBatch;
  DAT.api.list = list;
  DAT.api.upload = upload;
  DAT.api.downloadUrl = downloadUrl;
  DAT.api.update = update;
  DAT.api.getGeodatStatus = getGeodatStatus;
  DAT.api.installGeodat = installGeodat;

  // keep handy actions
  DAT.api.uploadDat = uploadDat;
  DAT.api.downloadDat = downloadDat;
  DAT.api.updateDatByUrl = updateDatByUrl;

  // Back-compat exports (were on RC)
  RC.installGeodat = installGeodat;
  RC.getGeodatStatus = getGeodatStatus;
})();
