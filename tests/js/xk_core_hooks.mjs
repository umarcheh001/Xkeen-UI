// Loaded with `node --import`: teaches node the names `xk-core/<path>`.
import { register } from 'node:module';

register('./xk_core_resolve.mjs', import.meta.url);
