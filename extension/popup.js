const btn = document.getElementById('cap');
const status = document.getElementById('status');

const set = (msg, cls) => { status.textContent = msg; status.className = 'status ' + (cls || 'muted'); };

// Pairing check up front, so the user knows before clicking.
chrome.storage.local.get('pairing').then(({ pairing }) => {
  if (pairing && pairing.conversationId) set('Connected to your Kara session.', 'ok');
  else set('Open kara.usegoblin.xyz and press Start first.', 'muted');
});

btn.addEventListener('click', () => {
  btn.disabled = true;
  set('Capturing…', 'muted');
  chrome.runtime.sendMessage({ type: 'capture' }, (resp) => {
    btn.disabled = false;
    if (chrome.runtime.lastError) { set(chrome.runtime.lastError.message, 'err'); return; }
    if (resp && resp.ok) set(`Sent to Kara: "${resp.title}". Ask her about it.`, 'ok');
    else set((resp && resp.error) || 'Capture failed.', 'err');
  });
});
