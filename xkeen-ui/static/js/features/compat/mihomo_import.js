import { getMihomoImportApi } from '../mihomo_import.js';

window.XKeen = window.XKeen || {};
const XKeen = window.XKeen;
XKeen.features = XKeen.features || {};

const mihomoImportApi = typeof getMihomoImportApi === 'function' ? getMihomoImportApi() : null;
if (mihomoImportApi) {
  const legacyMihomoImportApi = XKeen.features.mihomoImport || {};
  XKeen.features.mihomoImport = legacyMihomoImportApi;
  Object.assign(legacyMihomoImportApi, mihomoImportApi);
}
