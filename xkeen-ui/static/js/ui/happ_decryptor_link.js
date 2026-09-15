// Error texts about the Happ decryptor end with this label (services/happ_links.py,
// HAPP_DECRYPTOR_CARD_LABEL). Where it appears, a link to the DevTools card is added.
export const HAPP_DECRYPTOR_CARD_LABEL = 'DevTools → «Декриптор Happ»';
export const HAPP_DECRYPTOR_CARD_URL = '/devtools#dt-happ-decryptor-card';

export function mentionsHappDecryptorCard(text) {
  return String(text || '').includes(HAPP_DECRYPTOR_CARD_LABEL);
}

export function appendHappDecryptorCardLink(el, text) {
  if (!el || !mentionsHappDecryptorCard(text)) return false;
  if (el.querySelector && el.querySelector('[data-xk-happ-decryptor-link]')) return true;
  const link = document.createElement('a');
  link.href = HAPP_DECRYPTOR_CARD_URL;
  link.className = 'xk-happ-decryptor-link';
  link.setAttribute('data-xk-happ-decryptor-link', '1');
  link.style.marginLeft = '6px';
  link.style.textDecoration = 'underline';
  link.textContent = 'Открыть «Декриптор Happ»';
  el.appendChild(link);
  return true;
}
