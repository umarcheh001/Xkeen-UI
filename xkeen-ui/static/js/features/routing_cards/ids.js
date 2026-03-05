/*
  routing_cards/ids.js
  Centralized DOM IDs + localStorage keys for routing_cards feature.

  RC-02
*/
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.features = XK.features || {};

  const RC = XK.features.routingCards = XK.features.routingCards || {};
  RC.state = RC.state || {};

  // DOM IDs
  RC.IDS = RC.IDS || {
    // DAT
    datHeader: 'routing-dat-header',
    datBody: 'routing-dat-body',
    datArrow: 'routing-dat-arrow',
    datRefresh: 'routing-dat-refresh-btn',
    datStatus: 'routing-dat-status',
    datGeositeMeta: 'routing-dat-geosite-meta',
    datGeoipMeta: 'routing-dat-geoip-meta',
    datGeositeDir: 'routing-dat-geosite-dir',
    datGeositeName: 'routing-dat-geosite-name',
    datGeositeNameList: 'routing-dat-geosite-name-list',
    datGeositeBrowse: 'routing-dat-geosite-browse',
    datGeositeFound: 'routing-dat-geosite-found',
    datGeoipDir: 'routing-dat-geoip-dir',
    datGeoipName: 'routing-dat-geoip-name',
    datGeoipNameList: 'routing-dat-geoip-name-list',
    datGeoipBrowse: 'routing-dat-geoip-browse',
    datGeoipFound: 'routing-dat-geoip-found',
    datGeositeUrl: 'routing-dat-geosite-url',
    datGeoipUrl: 'routing-dat-geoip-url',
    datGeositeUpload: 'routing-dat-geosite-upload-btn',
    datGeoipUpload: 'routing-dat-geoip-upload-btn',
    datGeositeDownload: 'routing-dat-geosite-download-btn',
    datGeoipDownload: 'routing-dat-geoip-download-btn',
    datGeositeUpdate: 'routing-dat-geosite-update-btn',
    datGeoipUpdate: 'routing-dat-geoip-update-btn',
    datGeositeContent: 'routing-dat-geosite-content-btn',
    datGeoipContent: 'routing-dat-geoip-content-btn',
    datGeositeFile: 'routing-dat-geosite-file',
    datGeoipFile: 'routing-dat-geoip-file',
    datGeodatInstall: 'routing-dat-geodat-install-btn',
    datGeodatInstallFileBtn: 'routing-dat-geodat-install-file-btn',
    datGeodatInstallFile: 'routing-dat-geodat-install-file',

    // Rules
    rulesHeader: 'routing-rules-header',
    rulesBody: 'routing-rules-body',
    rulesArrow: 'routing-rules-arrow',
    rulesCount: 'routing-rules-count',
    rulesGeo: 'routing-rules-geo',
    rulesFilter: 'routing-rules-filter',
    rulesRefresh: 'routing-rules-refresh-btn',
    rulesReload: 'routing-rules-reload-btn',
    rulesApply: 'routing-rules-apply-btn',
    rulesAdd: 'routing-rules-add-btn',
    rulesList: 'routing-rules-list',
    rulesEmpty: 'routing-rules-empty',
    domainStrategy: 'routing-domain-strategy',

    balancersList: 'routing-balancers-list',
    balancerAdd: 'routing-balancer-add-btn',

    // Sidebar: extra collapsible cards (right column)
    backupsHeader: 'routing-backups-header',
    backupsBody: 'routing-backups-body',
    backupsArrow: 'routing-backups-arrow',
    helpHeader: 'routing-help-header',
    helpBody: 'routing-help-body',
    helpArrow: 'routing-help-arrow',
  };

  // localStorage keys
  RC.LS_KEYS = RC.LS_KEYS || {
    jsoncDebug: 'xk.routing.jsonc.debug',

    sidebarBackupsOpen: 'xk.routing.backups.open.v1',
    sidebarHelpOpen: 'xk.routing.help.open.v1',

    datPrefs: 'xk.routing.dat.prefs.v1',
    datOpen: 'xk.routing.dat.open.v3',

    rulesOpen: 'xk.routing.rules.open.v2',
  };
})();
