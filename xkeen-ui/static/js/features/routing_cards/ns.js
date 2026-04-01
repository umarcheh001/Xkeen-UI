import { initRoutingCardsNamespace } from '../routing_cards_namespace.js';

/*
  routing_cards namespace bootstrap

  Goal: keep routing cards modular and avoid relying on window.XKeen.features
  as the canonical namespace root.
*/
initRoutingCardsNamespace();
