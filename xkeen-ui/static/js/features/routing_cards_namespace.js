let routingCardsNamespace = null;

export function initRoutingCardsNamespace() {
  if (routingCardsNamespace && typeof routingCardsNamespace === 'object') return routingCardsNamespace;

  const RC = {};

  routingCardsNamespace = RC;
  RC.state = RC.state || {};
  RC.__nsReady = true;
  return RC;
}

export function getRoutingCardsNamespace() {
  try {
    return initRoutingCardsNamespace();
  } catch (error) {}
  return null;
}

export const routingCardsNamespaceApi = Object.freeze({
  get: getRoutingCardsNamespace,
  init: initRoutingCardsNamespace,
});
