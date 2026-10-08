const KEY = 'xkeen.modules.update.v1';

function readBadge() {
  try {
    const record = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    return record?.schema === 1 && typeof record.sourceVersion === 'string' && typeof record.targetVersion === 'string'
      ? record : null;
  } catch (error) {
    return null;
  }
}

export function syncModulesUpdateBadges(scope = document) {
  const badge = readBadge();
  scope.querySelectorAll('[data-xk-modules-update-badge]').forEach((node) => {
    node.hidden = !badge;
    node.textContent = badge ? 'Обновление' : '';
    node.setAttribute('aria-label', badge ? `Доступно обновление ${badge.targetVersion}` : '');
  });
}

export function setModulesUpdateBadge({ sourceVersion, targetVersion }) {
  if (!sourceVersion || !targetVersion || sourceVersion === targetVersion) return false;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ schema: 1, sourceVersion, targetVersion }));
  } catch (error) {
    return false;
  }
  syncModulesUpdateBadges(document);
  return true;
}

export function clearModulesUpdateBadge() {
  try { sessionStorage.removeItem(KEY); } catch (error) {}
  syncModulesUpdateBadges(document);
}

export function reconcileModulesUpdateBadge(installed) {
  const badge = readBadge();
  if (!badge) return;
  const current = installed?.panel_version;
  if (current && current !== badge.sourceVersion) clearModulesUpdateBadge();
}

export function reconcileModulesUpdatePlan(plan) {
  if (plan?.operation !== 'panel-update') return;
  if (plan.blockers?.some((blocker) => blocker?.code === 'panel_version_current')) {
    clearModulesUpdateBadge();
  } else if (plan.applicable === true) {
    setModulesUpdateBadge({ sourceVersion: plan.source_version, targetVersion: plan.target_version });
  }
}

export function reconcileModulesUpdateStatus(status) {
  if (status?.operation === 'panel-update' && status.result === 'committed') clearModulesUpdateBadge();
}
