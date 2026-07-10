/* Kara Capture — service worker.
 *
 * On demand (popup "Capture" button), it serializes the ACTIVE tab into a
 * structured payload and POSTs it to Kara, keyed to the paired conversation.
 * "Stronger than a screenshot" = we send real DOM text, a computed-style
 * digest for faithful rebuilds, the trimmed HTML, AND a screenshot — so Kara
 * reads structure when there is one and still sees canvas apps (Figma, Maps)
 * that have no meaningful DOM.
 */
const ENDPOINT = 'https://kara.usegoblin.xyz/api/capture';

// Injected into the target tab's MAIN world. Must be self-contained (no closure
// over service-worker scope) — it's serialized and run in the page.
function serializePage() {
  const cap = (s, n) => (s && s.length > n ? s.slice(0, n) : s || '');
  const clean = (root) => {
    const c = root.cloneNode(true);
    c.querySelectorAll('script,noscript,style,svg,iframe,link,template').forEach((n) => n.remove());
    // Drop noisy attributes that bloat markup without helping a rebuild.
    c.querySelectorAll('*').forEach((el) => {
      for (const a of [...el.attributes]) {
        if (/^(data-|aria-|on)/.test(a.name) || a.name === 'style') el.removeAttribute(a.name);
      }
    });
    return c.innerHTML.replace(/\s{2,}/g, ' ').replace(/>\s+</g, '><');
  };
  // Computed-style digest: the values you'd need to rebuild the look.
  const digestOf = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const s = getComputedStyle(el);
    return {
      sel,
      font: s.fontFamily,
      size: s.fontSize,
      weight: s.fontWeight,
      color: s.color,
      bg: s.backgroundColor,
      radius: s.borderRadius,
      pad: s.padding,
    };
  };
  const digest = ['body', 'h1', 'h2', 'h3', 'p', 'a', 'button', 'nav', 'header', 'footer']
    .map(digestOf)
    .filter(Boolean);
  const main = document.querySelector('main') || document.body;
  return {
    url: location.href,
    title: document.title,
    text: cap(document.body ? document.body.innerText : '', 8000),
    html: cap(main ? clean(main) : '', 60000),
    styleDigest: digest,
  };
}

async function capture() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error('No active tab.');
  if (/^(chrome|edge|about|chrome-extension):/.test(tab.url || '')) {
    throw new Error('Browser pages can’t be captured. Open a normal website tab.');
  }
  const { pairing } = await chrome.storage.local.get('pairing');
  if (!pairing) throw new Error('Open kara.usegoblin.xyz and start a conversation first, then try again.');

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: serializePage,
  });

  let screenshot = '';
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 55 });
    screenshot = dataUrl.split(',')[1] || '';
  } catch { /* some tabs disallow capture; DOM still ships */ }

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId: pairing.conversationId,
      captureKey: pairing.captureKey,
      ...result,
      screenshot,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(res.status === 403 ? 'Pairing expired — reload kara.usegoblin.xyz.' : `Kara rejected the capture (${res.status}). ${t.slice(0, 80)}`);
  }
  return result.title || result.url;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'capture') {
    capture().then(
      (title) => sendResponse({ ok: true, title }),
      (err) => sendResponse({ ok: false, error: err.message }),
    );
    return true; // async response
  }
});
