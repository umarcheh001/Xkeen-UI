import { getGithubApi } from '../github.js';

window.XKeen = window.XKeen || {};
const XKeen = window.XKeen;

const githubApi = typeof getGithubApi === 'function' ? getGithubApi() : null;
if (githubApi) {
  const legacyGithubApi = XKeen.github || {};
  XKeen.github = legacyGithubApi;
  Object.assign(legacyGithubApi, githubApi);
}
