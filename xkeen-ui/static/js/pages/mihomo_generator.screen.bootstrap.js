import { bootMihomoGeneratorPage } from './mihomo_generator.init.js';
import { getMihomoGeneratorApi } from '../features/mihomo_generator.js';

export async function bootMihomoGeneratorScreen() {
  bootMihomoGeneratorPage();
  return getMihomoGeneratorApi();
}

export function getMihomoGeneratorTopLevelApi() {
  return getMihomoGeneratorApi();
}
