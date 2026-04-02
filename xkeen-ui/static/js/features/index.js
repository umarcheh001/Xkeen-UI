export { backupsApi } from './backups.js';
export { brandingPrefsApi } from './branding_prefs.js';
export { commandsListApi } from './commands_list.js';
export { coresStatusApi } from './cores_status.js';
export { devtoolsApi } from './devtools.js';
export { donateApi } from './donate.js';
export { fileManagerApi } from './file_manager.js';
export { githubApi } from './github.js';
export { inboundsApi } from './inbounds.js';
export { layoutPrefsApi } from './layout_prefs.js';
export { localIoApi } from './local_io.js';
export { mihomoGeneratorApi } from './mihomo_generator.js';
export { mihomoHwidSubApi } from './mihomo_hwid_sub.js';
export { mihomoImportApi } from './mihomo_import.js';
export { mihomoPanelApi } from './mihomo_panel.js';
export { mihomoProxyToolsApi } from './mihomo_proxy_tools.js';
export { mihomoYamlPatchApi } from './mihomo_yaml_patch.js';
export { outboundsApi } from './outbounds.js';
export { restartLogApi } from './restart_log.js';
export { routingApi } from './routing.js';
export { routingCardsApi } from './routing_cards.js';
export { routingTemplatesApi } from './routing_templates.js';
export { serviceStatusApi } from './service_status.js';
export { typographyApi } from './typography.js';
export { uiPrefsIoApi } from './ui_prefs_io.js';
export { updateNotifierApi } from './update_notifier.js';
export { xkeenTextsApi } from './xkeen_texts.js';
export { xrayLogsApi } from './xray_logs.js';
export { featureAccessApi, featureAccessorRegistry, getFeatureAccessorRegistry, getFeatureApi, requireFeatureApi } from './feature_access.js';

import { backupsApi } from './backups.js';
import { brandingPrefsApi } from './branding_prefs.js';
import { commandsListApi } from './commands_list.js';
import { coresStatusApi } from './cores_status.js';
import { devtoolsApi } from './devtools.js';
import { donateApi } from './donate.js';
import { fileManagerApi } from './file_manager.js';
import { githubApi } from './github.js';
import { inboundsApi } from './inbounds.js';
import { layoutPrefsApi } from './layout_prefs.js';
import { localIoApi } from './local_io.js';
import { mihomoGeneratorApi } from './mihomo_generator.js';
import { mihomoHwidSubApi } from './mihomo_hwid_sub.js';
import { mihomoImportApi } from './mihomo_import.js';
import { mihomoPanelApi } from './mihomo_panel.js';
import { mihomoProxyToolsApi } from './mihomo_proxy_tools.js';
import { mihomoYamlPatchApi } from './mihomo_yaml_patch.js';
import { outboundsApi } from './outbounds.js';
import { restartLogApi } from './restart_log.js';
import { routingApi } from './routing.js';
import { routingCardsApi } from './routing_cards.js';
import { routingTemplatesApi } from './routing_templates.js';
import { serviceStatusApi } from './service_status.js';
import { typographyApi } from './typography.js';
import { uiPrefsIoApi } from './ui_prefs_io.js';
import { updateNotifierApi } from './update_notifier.js';
import { xkeenTextsApi } from './xkeen_texts.js';
import { xrayLogsApi } from './xray_logs.js';

export const featureApiRegistry = Object.freeze({
  backups: backupsApi,
  brandingPrefs: brandingPrefsApi,
  commandsList: commandsListApi,
  coresStatus: coresStatusApi,
  devtools: devtoolsApi,
  donate: donateApi,
  fileManager: fileManagerApi,
  github: githubApi,
  inbounds: inboundsApi,
  layoutPrefs: layoutPrefsApi,
  localIo: localIoApi,
  mihomoGenerator: mihomoGeneratorApi,
  mihomoHwidSub: mihomoHwidSubApi,
  mihomoImport: mihomoImportApi,
  mihomoPanel: mihomoPanelApi,
  mihomoProxyTools: mihomoProxyToolsApi,
  mihomoYamlPatch: mihomoYamlPatchApi,
  outbounds: outboundsApi,
  restartLog: restartLogApi,
  routing: routingApi,
  routingCards: routingCardsApi,
  routingTemplates: routingTemplatesApi,
  serviceStatus: serviceStatusApi,
  typography: typographyApi,
  uiPrefsIo: uiPrefsIoApi,
  updateNotifier: updateNotifierApi,
  xkeenTexts: xkeenTextsApi,
  xrayLogs: xrayLogsApi,
});
