/*
  routing_cards namespace + state container

  Goal: keep routing cards modular and avoid relying on IIFE-closure globals.
  This file is intentionally tiny and safe to load multiple times.
*/
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.features = XK.features || {};

  const RC = XK.features.routingCards = XK.features.routingCards || {};
  RC.state = RC.state || {};
  RC.__nsReady = true;
})();
