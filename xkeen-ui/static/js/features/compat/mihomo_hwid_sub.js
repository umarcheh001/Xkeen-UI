import { getMihomoHwidSubApi } from '../mihomo_hwid_sub.js';

window.XKeen = window.XKeen || {};
const XKeen = window.XKeen;
XKeen.features = XKeen.features || {};

const mihomoHwidSubApi = typeof getMihomoHwidSubApi === 'function' ? getMihomoHwidSubApi() : null;
if (mihomoHwidSubApi) {
  const legacyMihomoHwidSubApi = XKeen.features.mihomoHwidSub || {};
  XKeen.features.mihomoHwidSub = legacyMihomoHwidSubApi;
  Object.assign(legacyMihomoHwidSubApi, mihomoHwidSubApi);
}
