const activeAnimations = new WeakMap();

function canAnimate(element) {
  return !!(element && element.isConnected && typeof element.animate === 'function'
    && !document.hidden
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function cancelAnimation(element) {
  const previous = element && activeAnimations.get(element);
  if (previous) previous.cancel();
  if (element) activeAnimations.delete(element);
}

export function animateScreenEnter(element) {
  if (!element) return;
  cancelAnimation(element);
  if (!canAnimate(element)) return;

  const animation = element.animate([
    { opacity: 0.48, transform: 'translate3d(0, 12px, 0) scale(0.995)' },
    { opacity: 1, transform: 'translate3d(0, 0, 0) scale(1)' },
  ], {
    duration: 260,
    easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
    fill: 'both',
  });
  activeAnimations.set(element, animation);
  animation.finished.then(() => {
    if (activeAnimations.get(element) === animation) {
      animation.cancel();
      activeAnimations.delete(element);
    }
  }).catch(() => {});
}

export async function animateScreenLeave(element) {
  if (!element) return;
  cancelAnimation(element);
  if (!canAnimate(element)) return;

  const animation = element.animate([
    { opacity: 1, transform: 'translate3d(0, 0, 0)' },
    { opacity: 0.62, transform: 'translate3d(0, -5px, 0)' },
  ], {
    duration: 90,
    easing: 'ease-in',
    fill: 'forwards',
  });
  activeAnimations.set(element, animation);
  try { await animation.finished; } catch (error) {}
}
