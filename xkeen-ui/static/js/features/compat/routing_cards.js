import { getRoutingCardsApi } from '../routing_cards.js';
import { getRoutingCardsNamespace } from '../routing_cards_namespace.js';

window.XKeen = window.XKeen || {};
const XKeen = window.XKeen;
XKeen.features = XKeen.features || {};

const routingCardsNamespace = typeof getRoutingCardsNamespace === 'function' ? getRoutingCardsNamespace() : null;
const routingCardsApi = typeof getRoutingCardsApi === 'function' ? getRoutingCardsApi() : null;
if (routingCardsNamespace) {
  const previousLegacyRoutingCardsApi = XKeen.features.routingCards || null;
  const legacyRoutingCardsApi = routingCardsNamespace;
  if (previousLegacyRoutingCardsApi && previousLegacyRoutingCardsApi !== legacyRoutingCardsApi) {
    Object.assign(legacyRoutingCardsApi, previousLegacyRoutingCardsApi);
  }
  XKeen.features.routingCards = legacyRoutingCardsApi;
  if (routingCardsApi) Object.assign(legacyRoutingCardsApi, routingCardsApi);
}
