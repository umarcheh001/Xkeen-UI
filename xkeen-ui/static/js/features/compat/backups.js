import { getBackupsApi } from '../backups.js?v=20260317b';

window.XKeen = window.XKeen || {};
const XKeen = window.XKeen;

const backupsApi = typeof getBackupsApi === 'function' ? getBackupsApi() : null;
if (backupsApi) {
  const legacyBackupsApi = XKeen.backups || {};
  XKeen.backups = legacyBackupsApi;
  Object.assign(legacyBackupsApi, backupsApi);
}
