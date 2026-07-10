/* Runs only on kara.usegoblin.xyz. The page (script.js) posts its live
 * conversation id + capture key via window.postMessage; we stash them so the
 * extension knows which conversation a capture belongs to. Content scripts
 * can't read the page's window directly, but they CAN hear its messages. */
window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  const d = e.data;
  if (d && d.__kara_pair__ && d.__kara_pair__.conversationId && d.__kara_pair__.captureKey) {
    chrome.storage.local.set({ pairing: d.__kara_pair__, pairedAt: Date.now() });
  }
});

// Ask the page to (re)announce its pairing, in case we loaded after it did.
window.postMessage({ __kara_pair_request__: true }, '*');
