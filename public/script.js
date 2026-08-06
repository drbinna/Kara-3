import { createClient } from 'https://esm.sh/@anam-ai/js-sdk@latest';
import { AnamEvent } from 'https://esm.sh/@anam-ai/js-sdk@latest/dist/module/types';

let anamClient = null;

// One id per page load: keys this operator's session on the server.
const conversationId = crypto.randomUUID();

const startButton = document.getElementById('start-button');
const stopButton = document.getElementById('stop-button');
const videoElement = document.getElementById('persona-video');
const statusElement = document.getElementById('status');
const chatHistory = document.getElementById('chat-history');
const actionBanner = document.getElementById('action-banner');
const pipButton = document.getElementById('pip-button');
const screenButton = document.getElementById('screen-button');
const posterImg = document.getElementById('poster');
const nameplate = document.getElementById('nameplate');
let screenStream = null;
const screenVideo = document.createElement('video'); // hidden sink for the capture
screenVideo.muted = true;
const frameCanvas = document.createElement('canvas');

function setScreenEnabled(on) {
  if (!screenButton) return;
  screenButton.disabled = !on;
  screenButton.style.opacity = on ? '1' : '0.55';
}

function stopScreenShare() {
  if (screenStream) {
    for (const t of screenStream.getTracks()) t.stop();
    screenStream = null;
  }
  screenVideo.srcObject = null;
  screenButton.textContent = 'Share screen';
  screenButton.style.background = '#3d3d3a';
}

async function toggleScreenShare() {
  if (screenStream) { stopScreenShare(); return; }
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });
    screenVideo.srcObject = screenStream;
    await screenVideo.play();
    screenStream.getVideoTracks()[0].addEventListener('ended', stopScreenShare); // browser "Stop sharing"
    screenButton.textContent = 'Sharing ✓ (stop)';
    screenButton.style.background = '#3b6d11';
  } catch (err) {
    console.error('screen share error:', err);
    stopScreenShare();
  }
}

// One JPEG frame of the shared screen, captured at utterance time.
function captureScreenFrame() {
  if (!screenStream || screenVideo.readyState < 2) return null;
  const maxW = 1280;
  const scale = Math.min(1, maxW / (screenVideo.videoWidth || maxW));
  frameCanvas.width = Math.round((screenVideo.videoWidth || maxW) * scale);
  frameCanvas.height = Math.round((screenVideo.videoHeight || 720) * scale);
  frameCanvas.getContext('2d').drawImage(screenVideo, 0, 0, frameCanvas.width, frameCanvas.height);
  return frameCanvas.toDataURL('image/jpeg', 0.7).split(',')[1];
}

function setPipEnabled(on) {
  if (!pipButton) return;
  pipButton.disabled = !on;
  pipButton.style.opacity = on ? '1' : '0.55';
}

/* ------------------------------ announcer ------------------------------- */
let eventSource = null;

function appendAnnouncement(text) {
  const div = document.createElement('div');
  div.style.cssText = 'margin-bottom:10px; padding:8px 12px; border-radius:8px; max-width:85%; background:#faeeda; color:#854f0b; font-weight:500;';
  div.textContent = `🔔 ${text}`;
  chatHistory?.appendChild(div);
  if (chatHistory) chatHistory.scrollTop = chatHistory.scrollHeight;
}

async function subscribeEvents() {
  if (eventSource) eventSource.close();
  // The token rides in the URL because EventSource can't send headers. Clerk
  // JWTs are short-lived, so on any drop we reopen with a fresh token instead
  // of letting EventSource auto-reconnect with the stale one.
  let token = '';
  try { token = (await (await clerkReady()).session?.getToken()) || ''; } catch { /* REQUIRE_AUTH=0 dev */ }
  eventSource = new EventSource(`/api/events?conversationId=${conversationId}&token=${encodeURIComponent(token)}`);
  eventSource.onerror = () => {
    eventSource.close();
    setTimeout(subscribeEvents, 3000);
  };
  eventSource.onmessage = (e) => {
    try {
      const ev = JSON.parse(e.data);
      if (ev.type === 'announce') {
        appendAnnouncement(ev.text);          // visible even before/without voice
        anamClient?.talk(ev.text);            // Kara speaks first
      } else if (ev.type === 'deliverable' && ev.file) {
        addDeliverable(ev.file);              // research brief lands as a chip
      } else if (ev.type === 'capture') {
        updateStatus(`Got the page: ${ev.title || ev.url}. Ask Kara about it.`, 'connected');
      }
    } catch { /* ignore malformed */ }
  };
}


/* The companion: ONE always-on-top window (Document Picture-in-Picture)
 * with Kara's live video + her files, following the operator across every
 * tab and app. The real <video> element is moved into the window (the
 * WebRTC stream keeps playing) and moved back when it closes. */
let companionWin = null;
let videoHome = null; // where the video element goes back to

async function togglePip() {
  if (companionWin && !companionWin.closed) { companionWin.close(); return; }

  if (!('documentPictureInPicture' in window)) {
    // Non-Chromium fallback: plain video PiP (no files list).
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (document.pictureInPictureEnabled && videoElement.readyState >= 1) await videoElement.requestPictureInPicture();
      else updateStatus('Companion Mode not supported in this browser', 'error');
    } catch (err) {
      console.error('PiP error:', err);
      updateStatus('Could not open Companion Mode', 'error');
    }
    return;
  }

  try {
    companionWin = await documentPictureInPicture.requestWindow({ width: 340, height: 470 });
    const doc = companionWin.document;
    doc.title = 'Kara';
    doc.body.style.cssText = 'margin:0; font-family:system-ui, Arial, sans-serif; background:#1c1c1a; display:flex; flex-direction:column; height:100vh; overflow:hidden;';

    // Move the live video in (the stream survives the move). Main-document
    // stylesheets don't apply inside the pop-out, so style it inline here.
    videoHome = { parent: videoElement.parentElement, next: videoElement.nextSibling };
    videoElement.style.cssText = 'width:100%;flex:none;background:#000;display:block;';
    doc.body.appendChild(videoElement);
    videoElement.play?.().catch(() => {});
    if (posterImg) posterImg.style.opacity = '1'; // the stage shows Kara's portrait while she's popped out

    const bar = doc.createElement('div');
    bar.textContent = '📁 Files — click to download';
    bar.style.cssText = 'padding:8px 12px; font-size:12px; font-weight:600; background:#2a2a28; color:#d8d7d2; flex:none;';
    const cont = doc.createElement('div');
    cont.className = 'fb-list';
    cont.style.cssText = 'height:100%; max-height:none; padding:4px;';
    const filesSurface = makeFoil(doc, companionWin, cont, 'flex:1; min-height:0;');
    doc.body.appendChild(bar);
    doc.body.appendChild(filesSurface);
    filesWidget.mirrorInto(cont); // live list — updates as new files land

    companionWin.addEventListener('pagehide', () => {
      filesWidget.unmirror();
      if (videoHome?.parent) {
        videoElement.style.cssText = ''; // page stylesheet takes over again
        videoHome.parent.insertBefore(videoElement, videoHome.next);
        videoElement.play?.().catch(() => {});
        if (posterImg && anamClient) posterImg.style.opacity = '0';
      }
      companionWin = null;
    });
  } catch (err) {
    console.error('companion pop-out error:', err);
    updateStatus('Could not open Companion Mode', 'error');
  }
}

const BANNER_STYLES = {
  pending: { bg: '#faeeda', fg: '#854f0b' },
  done: { bg: '#eaf3de', fg: '#3b6d11' },
};

/* Iridescent foil — vanilla port of the IridescentFoil React component.
 * Wraps a content element in holographic foil layers; pointer + scroll drive
 * the shine via CSS custom properties, identical math to the original. */
const FOIL_CSS = `
.if-surface {
  --pointer-x: 50%; --pointer-y: 50%; --foil-shift: 0%; --foil-y-shift: 0%;
  --glare-x: 50%; --glare-y: 50%; --shine-angle: 135deg; --shine-opacity: 0.62;
  --shine-opacity-scale: 1; --film-opacity: 0.34;
  --foil-filter: saturate(1.18) contrast(1.22) brightness(1);
  --highlight-filter: brightness(1) saturate(1);
  --foil-base-gradient: linear-gradient(135deg,#eeeeee 0%,#dcdcdc 40%,#c9c9c9 72%,#e8e8e8 100%);
  --glare-opacity: 0.38; --pearl-opacity: 0.98;
  --surface-inset-shadow: inset 0 0 0 1px rgba(255,255,255,0.38);
  position: relative; isolation: isolate; overflow: hidden;
  background: #f1f0ef; box-shadow: var(--surface-inset-shadow);
  contain: layout paint style;
}
.if-content,.if-film,.if-foil,.if-glare,.if-pearl,.if-shine { position: absolute; inset: 0; }
.if-film,.if-foil,.if-glare,.if-pearl,.if-shine { background-repeat: no-repeat; pointer-events: none; }
.if-film,.if-foil,.if-pearl,.if-shine { inset: -48%; }
.if-autoheight .if-content { position: relative; inset: auto; }
.if-foil {
  z-index: 0;
  background:
    linear-gradient(112deg,transparent 0%,transparent 28%,rgba(0,220,255,0.08) 32%,rgba(80,255,190,0.07) 36%,rgba(190,255,80,0.05) 40%,transparent 46%,rgba(255,230,70,0.04) 50%,rgba(255,70,180,0.07) 56%,rgba(150,90,255,0.07) 64%,rgba(60,120,255,0.06) 70%,transparent 75%,transparent 100%),
    var(--foil-base-gradient);
  background-repeat: no-repeat;
  background-position: var(--foil-shift) center, center;
  background-size: 320% 100%, 100% 100%;
  filter: var(--foil-filter);
  will-change: background-position;
}
.if-film {
  z-index: 1;
  background:
    radial-gradient(ellipse at 16% 28%,rgba(255,70,180,0.1) 0%,rgba(255,70,180,0.04) 18%,transparent 48%),
    radial-gradient(ellipse at 66% 18%,rgba(0,220,255,0.1) 0%,rgba(0,220,255,0.04) 20%,transparent 52%),
    radial-gradient(ellipse at 78% 70%,rgba(80,255,190,0.1) 0%,rgba(80,255,190,0.04) 22%,transparent 56%),
    radial-gradient(ellipse at 38% 82%,rgba(150,90,255,0.1) 0%,rgba(150,90,255,0.04) 18%,transparent 52%);
  background-repeat: no-repeat;
  background-position:
    calc(var(--foil-shift) * -0.2) calc(var(--foil-y-shift) * 0.3),
    calc(var(--foil-shift) * 0.5) calc(var(--foil-y-shift) * -0.2),
    calc(var(--foil-shift) * -0.4) calc(var(--foil-y-shift) * 0.5),
    calc(var(--foil-shift) * 0.35) calc(var(--foil-y-shift) * 0.25);
  background-size: 150% 150%, 160% 160%, 145% 145%, 155% 155%;
  filter: blur(0.4px) saturate(1.35);
  mix-blend-mode: screen; opacity: var(--film-opacity);
  will-change: background-position;
}
.if-pearl {
  z-index: 2;
  background:
    radial-gradient(ellipse at calc(var(--glare-x) * 0.9) calc(var(--glare-y) * 0.85),rgba(224,233,240,0.48) 0%,rgba(205,217,226,0.18) 22%,transparent 54%),
    linear-gradient(112deg,rgba(220,230,238,0.32) 0%,rgba(220,230,238,0) 28%,rgba(84,108,128,0.2) 48%,rgba(215,226,235,0.3) 72%,rgba(215,226,235,0.04) 100%),
    linear-gradient(28deg,rgba(188,218,255,0.12) 0%,transparent 34%,rgba(255,223,244,0.12) 58%,transparent 100%);
  background-repeat: no-repeat;
  background-position: center, var(--foil-shift) center, var(--foil-shift) center;
  background-size: 100% 100%, 180% 100%, 160% 100%;
  filter: var(--highlight-filter);
  mix-blend-mode: soft-light; opacity: var(--pearl-opacity);
  will-change: background-position;
}
.if-content { z-index: 3; }
.if-shine {
  z-index: 4;
  background:
    linear-gradient(var(--shine-angle),transparent 0%,rgba(220,230,238,0.04) 12%,rgba(226,235,242,0.48) 31%,rgba(37,52,66,0.24) 52%,rgba(0,124,255,0.08) 64%,rgba(255,0,147,0.08) 74%,rgba(223,232,239,0.28) 88%,transparent 100%),
    linear-gradient(112deg,transparent 0%,transparent 30%,rgba(0,220,255,0.04) 34%,rgba(80,255,190,0.04) 38%,rgba(190,255,80,0.03) 42%,transparent 45%,rgba(255,230,70,0.03) 52%,rgba(255,70,180,0.05) 59%,transparent 66%,rgba(150,90,255,0.05) 73%,rgba(60,120,255,0.04) 78%,transparent 84%);
  background-repeat: no-repeat;
  background-position: calc(50% + (var(--pointer-x) - 50%) * 0.35) calc(50% + (var(--pointer-y) - 50%) * 0.24);
  background-size: 220% 100%;
  filter: blur(0.25px) var(--highlight-filter);
  mix-blend-mode: screen;
  opacity: calc(var(--shine-opacity) * var(--shine-opacity-scale));
  will-change: background-position, opacity;
}
.if-glare {
  z-index: 5;
  background: radial-gradient(circle at var(--glare-x) var(--glare-y),rgba(226,235,242,0.34) 0%,rgba(205,218,228,0.14) 9%,rgba(226,237,246,0.08) 22%,transparent 36%);
  background-repeat: no-repeat;
  filter: var(--highlight-filter);
  mix-blend-mode: screen; opacity: var(--glare-opacity);
  will-change: background;
}

/* ---- filebox: inline-dropdown styling (after ui.harshsingh.xyz/inline-dropdown) ---- */
.fb-card{display:flex;flex-direction:column;gap:4px;padding:4px;min-width:248px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif}
.fb-head{display:flex;align-items:center;justify-content:space-between;padding:6px 8px;font-size:12px;font-weight:600;color:#1c1c1a}
.fb-close{border:none;background:rgba(28,28,26,.08);border-radius:6px;width:20px;height:20px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:#3c3c38;padding:0;transition:background .15s}
.fb-close:hover{background:rgba(28,28,26,.18)}
.fb-close svg{width:11px;height:11px}
.fb-hr{border:none;border-top:1px solid rgba(28,28,26,.14);margin:0 2px}
.fb-list{max-height:300px;overflow-y:auto;scroll-behavior:smooth;overscroll-behavior:contain;padding:2px;display:flex;flex-direction:column;gap:2px;scrollbar-width:thin;scrollbar-color:rgba(28,28,26,.25) transparent}
.fb-list::-webkit-scrollbar{width:6px}
.fb-list::-webkit-scrollbar-thumb{background:rgba(28,28,26,.18);border-radius:999px}
.fb-list::-webkit-scrollbar-thumb:hover{background:rgba(28,28,26,.32)}
.fb-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 8px;border-radius:6px;font-size:12px;font-weight:500;color:#1c1c1a;text-decoration:none;cursor:pointer;transition:background .12s;animation:fbIn .22s ease both}
.fb-row:hover{background:rgba(28,28,26,.1)}
.fb-row:active{background:rgba(28,28,26,.17)}
.fb-row .fb-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fb-row svg{width:13px;height:13px;flex:none;opacity:.6;transition:opacity .12s,transform .15s}
.fb-row:hover svg{opacity:1;transform:translate(1px,-1px)}
.fb-empty{padding:8px;font-size:12px;font-style:italic;color:#8a8984;animation:fbIn .22s ease both}
@keyframes fbIn{from{transform:translateY(-10px);opacity:0}to{transform:none;opacity:1}}`;

function makeFoil(doc, win, contentEl, surfaceCss, autoHeight) {
  if (!doc.getElementById('if-style')) {
    const st = doc.createElement('style');
    st.id = 'if-style';
    st.textContent = FOIL_CSS;
    (doc.head || doc.body).appendChild(st);
  }
  const surface = doc.createElement('div');
  surface.className = 'if-surface' + (autoHeight ? ' if-autoheight' : '');
  surface.style.cssText = surfaceCss || '';
  const layer = (cls) => {
    const s = doc.createElement('span');
    s.className = cls;
    s.setAttribute('aria-hidden', 'true');
    return s;
  };
  const content = doc.createElement('div');
  content.className = 'if-content';
  content.appendChild(contentEl);
  surface.append(layer('if-foil'), layer('if-film'), layer('if-pearl'), content, layer('if-shine'), layer('if-glare'));

  const clampN = (v, min, max) => Math.min(Math.max(v, min), max);
  let raf = null, px = 0.5, py = 0.5;
  const apply = () => {
    raf = null;
    const rect = surface.getBoundingClientRect();
    const range = win.innerHeight + rect.height;
    const sp = range > 0 ? clampN((win.innerHeight - rect.top) / range, 0, 1) : 0;
    const s = surface.style;
    s.setProperty('--foil-shift', ((sp * 0.82 + (px - 0.5) * 0.18) * 100).toFixed(3) + '%');
    s.setProperty('--foil-y-shift', ((sp * 0.28 + (py - 0.5) * 0.12) * 100).toFixed(3) + '%');
    s.setProperty('--glare-x', (px * 100).toFixed(3) + '%');
    s.setProperty('--glare-y', (py * 100).toFixed(3) + '%');
    s.setProperty('--pointer-x', (px * 100).toFixed(3) + '%');
    s.setProperty('--pointer-y', (py * 100).toFixed(3) + '%');
    s.setProperty('--shine-angle', (105 + sp * 80 + (px - 0.5) * 28).toFixed(3) + 'deg');
    s.setProperty('--shine-opacity', (0.56 + Math.abs(px - 0.5) * 0.24 + sp * 0.12).toFixed(3));
  };
  const schedule = () => { if (raf === null) raf = win.requestAnimationFrame(apply); };
  win.addEventListener('pointermove', (e) => {
    const r = surface.getBoundingClientRect();
    px = r.width > 0 ? clampN((e.clientX - r.left) / r.width, 0.08, 0.92) : 0.5;
    py = r.height > 0 ? clampN((e.clientY - r.top) / r.height, 0.08, 0.92) : 0.5;
    schedule();
  }, { passive: true });
  win.addEventListener('scroll', schedule, { passive: true });
  win.addEventListener('resize', schedule, { passive: true });
  schedule();
  return surface;
}

/* Floating downloads widget — fixed to the corner so Kara's files stay one
 * click away in the app tab. The companion pop-out (see togglePip) mirrors
 * this list into an always-on-top window that follows you everywhere. */
const filesWidget = (() => {
  const files = []; // { name, url }
  let remote = null; // list container inside the companion window, when open

  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed; bottom:20px; right:20px; z-index:9999; display:flex; flex-direction:column; align-items:flex-end;';

  // Inline-dropdown card (header + close, divider, smooth-scrolling list)
  // living on an iridescent foil surface.
  const card = document.createElement('div');
  card.className = 'fb-card';
  const head = document.createElement('div');
  head.className = 'fb-head';
  const headLabel = document.createElement('span');
  headLabel.textContent = 'Files';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'fb-close';
  closeBtn.setAttribute('aria-label', 'Close files');
  closeBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  head.append(headLabel, closeBtn);
  const hr = document.createElement('hr');
  hr.className = 'fb-hr';
  const list = document.createElement('div');
  list.className = 'fb-list';
  // "From your past sessions" — cross-session history (Chinedu's request).
  // Hidden until /api/projects returns something for this user.
  const pastHr = document.createElement('hr');
  pastHr.className = 'fb-hr';
  const pastLabel = document.createElement('div');
  pastLabel.className = 'fb-empty';
  pastLabel.textContent = 'From your past sessions';
  const pastList = document.createElement('div');
  pastList.className = 'fb-list';
  pastHr.style.display = pastLabel.style.display = 'none';
  card.append(head, hr, list, pastHr, pastLabel, pastList);

  const panel = makeFoil(document, window, card,
    'display:none; margin-bottom:8px; border-radius:12px; box-shadow:0 12px 34px rgba(0,0,0,0.5);', true);
  closeBtn.addEventListener('click', () => { panel.style.display = 'none'; });

  const btn = document.createElement('button');
  btn.style.cssText = 'background:#fff; color:#1c1c1a; border:none; padding:11px 18px; border-radius:999px; cursor:pointer; font-size:14px; font-weight:600; box-shadow:0 10px 26px rgba(0,0,0,0.5); font-family:inherit;';
  btn.textContent = '📁 Files (0)';
  btn.addEventListener('click', () => {
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  });

  wrap.appendChild(panel);
  wrap.appendChild(btn);
  document.body.appendChild(wrap);

  function linkEl(doc, { name, url }, idx) {
    const a = doc.createElement('a');
    a.href = new URL(url, location.origin).href; // absolute: works inside the pop-out
    a.download = name;
    a.target = '_blank';
    a.className = 'fb-row';
    a.style.animationDelay = `${Math.min(idx * 35, 350)}ms`; // staggered entrance
    const span = doc.createElement('span');
    span.className = 'fb-name';
    span.textContent = name;
    a.appendChild(span);
    a.insertAdjacentHTML('beforeend',
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M9 7h8v8"/></svg>');
    return a;
  }

  function emptyEl(doc) {
    const d = doc.createElement('div');
    d.className = 'fb-empty';
    d.textContent = 'Nothing here yet. Ask Kara for a page.';
    return d;
  }

  function render() {
    btn.textContent = `📁 Files (${files.length})`;
    headLabel.textContent = `Files (${files.length})`;
    list.replaceChildren(...(files.length ? files.map((f, i) => linkEl(document, f, i)) : [emptyEl(document)]));
    if (remote) {
      const doc = remote.ownerDocument;
      remote.replaceChildren(...(files.length ? files.map((f, i) => linkEl(doc, f, i)) : [emptyEl(doc)]));
    }
    // newest file lands at the bottom — keep it in view without a jump
    list.scrollTop = list.scrollHeight;
  }
  render();

  return {
    add({ name, url }) {
      files.push({ name, url });
      wrap.style.display = 'flex';
      render();
      if (remote) return; // the companion already shows it live
      panel.style.display = 'block'; // surface the new file immediately
    },
    setPast(items) {
      // Don't repeat files already sitting in this session's list.
      const current = new Set(files.map((f) => f.url));
      const past = (items || []).filter((p) => !current.has(p.url));
      const show = past.length ? '' : 'none';
      pastHr.style.display = pastLabel.style.display = show;
      pastList.replaceChildren(...past.map((p, i) => {
        const a = linkEl(document, p, i);
        if (p.savedAt) a.title = `Built ${new Date(p.savedAt).toLocaleDateString()}`;
        a.style.opacity = '.75';
        return a;
      }));
    },
    mirrorInto(el) { remote = el; render(); },
    unmirror() { remote = null; },
  };
})();

/* Cross-session project history: pull the signed-in user's past builds into
 * the Files box. Fire-and-forget on load; harmless 401/empty when signed out. */
(async function loadPastBuilds() {
  try {
    const r = await fetch('/api/projects', { headers: await authHeaders() });
    if (!r.ok) return;
    const { projects } = await r.json();
    if (projects?.length) filesWidget.setPast(projects);
  } catch { /* offline or signed out — the box just shows this session */ }
})();

/* --------------------------- live document panel ------------------------ */
const draftPanel = document.getElementById('draft-panel');
const draftTitle = document.getElementById('draft-title');
const draftStatus = document.getElementById('draft-status');
const draftFrame = document.getElementById('draft-frame');
const draftText = document.getElementById('draft-text');

function showDraft({ filename, content, done }) {
  if (!draftPanel) return;
  draftPanel.style.display = 'block';
  draftTitle.textContent = filename || 'document';
  const isHtml = /\.html?$/i.test(filename || '');
  draftFrame.style.display = isHtml ? 'block' : 'none';
  draftText.style.display = isHtml ? 'none' : 'block';
  if (isHtml) draftFrame.srcdoc = content;
  else { draftText.textContent = content; draftText.scrollTop = draftText.scrollHeight; }
  if (done) { draftStatus.textContent = '✓ saved'; draftStatus.style.color = '#3ddc84'; }
  else { draftStatus.textContent = '✍ writing…'; draftStatus.style.color = '#ffb020'; }
}

const seenDeliverables = new Set();
async function refreshDeliverables() {
  try {
    const r = await fetch(`/api/deliverables?conversationId=${conversationId}`);
    const { files } = await r.json();
    for (const f of files || []) addDeliverable(f);
    return (files || []).length;
  } catch { return 0; }
}

function addDeliverable({ name, url }) {
  if (seenDeliverables.has(url)) return;
  seenDeliverables.add(url);
  filesWidget.add({ name, url });
}

function updateBanner({ state, text }) {
  if (!actionBanner) return;
  if (state === 'idle' || !text) {
    actionBanner.style.display = 'none';
    actionBanner.textContent = '';
    return;
  }
  const s = BANNER_STYLES[state] || BANNER_STYLES.pending;
  actionBanner.style.display = 'block';
  actionBanner.style.background = s.bg;
  actionBanner.style.color = s.fg;
  actionBanner.textContent = state === 'pending' ? `⏳ ${text} — say “confirm” to send` : `✓ ${text}`;
}

function updateStatus(message, type = 'normal') {
  statusElement.textContent = message;
  const colors = { loading: '#ba7517', connected: '#3b6d11', error: '#a32d2d', normal: '#1c1c1a' };
  statusElement.style.color = colors[type] || colors.normal;
}

function renderHistory(messages) {
  if (!chatHistory) return;
  chatHistory.innerHTML = '';
  if (!messages.length) {
    chatHistory.innerHTML =
      '<div style="font-style: italic; color: #8a8984; text-align: center;">Start a conversation to see the transcript…</div>';
    return;
  }
  for (const message of messages) {
    const isUser = message.role === 'user';
    const div = document.createElement('div');
    div.style.cssText = `margin-bottom: 10px; padding: 8px 12px; border-radius: 8px; max-width: 85%;
      background: ${isUser ? '#e6f1fb' : '#eaf3de'}; ${isUser ? 'margin-left: auto; text-align: right;' : ''}`;
    div.innerHTML = `<strong>${isUser ? 'You' : 'Kara'}:</strong> ${message.content}`;
    chatHistory.appendChild(div);
  }
  chatHistory.scrollTop = chatHistory.scrollHeight;
}

// The key seam: when the user finishes speaking, ask our backend brain and
/* ---- Clerk auth: sign in before Kara mints a session (work-trial gating).
 * clerk.browser.js is loaded async from index.html; wait for the global,
 * initialize once, and hand out Bearer headers for the paid endpoints.
 * getToken() caches and auto-refreshes, so calling it per turn is cheap. ---- */
let clerkLoading = null;
function clerkReady() {
  if (clerkLoading) return clerkLoading;
  clerkLoading = (async () => {
    // A blocked clerk.browser.js (ad-blocker, network) must FAIL, not hang:
    // this wait used to be infinite, which made the Start button appear dead.
    const deadline = Date.now() + 8000;
    while (!window.Clerk) {
      if (Date.now() > deadline) {
        clerkLoading = null; // allow a retry once the blocker is disabled
        throw new Error('clerk_unavailable');
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!window.Clerk.loaded) await window.Clerk.load({
      // Theme every Clerk surface (modal, loading states, spinner) to match
      // the page: near-black card, dashed hairline, warm text, green accent.
      appearance: {
        variables: {
          colorPrimary: '#22A03A',
          colorBackground: '#0a0a0a',
          colorText: '#f0efe9',
          colorTextSecondary: 'rgba(255,255,255,0.55)',
          colorTextOnPrimaryBackground: '#000000',
          colorInputBackground: '#141414',
          colorInputText: '#f0efe9',
          colorNeutral: '#f0efe9',
          colorDanger: '#e08585',
          borderRadius: '14px',
          fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
        },
        elements: {
          modalBackdrop: { backgroundColor: 'rgba(5,5,5,0.82)', backdropFilter: 'blur(6px)' },
          card: { border: '1px dashed rgba(255,255,255,0.18)', boxShadow: '0 30px 80px rgba(0,0,0,0.65)' },
          socialButtonsBlockButton: {
            border: '1px solid rgba(255,255,255,0.16)',
            backgroundColor: 'rgba(255,255,255,0.05)',
          },
          dividerLine: { backgroundColor: 'rgba(255,255,255,0.12)' },
          spinner: { color: '#22A03A' },
        },
      },
    });
    return window.Clerk;
  })();
  return clerkLoading;
}

async function authHeaders() {
  try {
    const clerk = await clerkReady();
    const token = await clerk.session?.getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {}; // Clerk unreachable — let the server decide (REQUIRE_AUTH=0 dev)
  }
}

/* Kara Capture extension pairing. The extension can't read this page's JS
 * directly, so we announce {conversationId, captureKey} via postMessage (its
 * content script listens) and register the key server-side so only captures
 * from this signed-in session are accepted. */
const captureKey = crypto.randomUUID();
function announcePairing() {
  window.postMessage({ __kara_pair__: { conversationId, captureKey } }, window.location.origin);
}
window.addEventListener('message', (e) => {
  if (e.source === window && e.data && e.data.__kara_pair_request__) announcePairing();
});
async function registerCapturePairing() {
  try {
    await fetch('/api/capture/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ conversationId, captureKey }),
    });
    announcePairing(); // in case the extension's content script is already live
  } catch { /* extension optional — capture just won't be paired */ }
}

// stream its reply into the avatar's mouth via createTalkMessageStream().
async function handleUserMessage(messageHistory) {
  const last = messageHistory[messageHistory.length - 1];
  if (!last || last.role !== 'user' || !anamClient) return;

  const messages = messageHistory.map((m) => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.content,
  }));

  try {
    // One TalkMessageStream = one speech turn. An announce (delivery line or
    // mid-build progress filler) closes the current stream; if the model
    // speaks again afterwards, we open a FRESH stream for it — never resume
    // the old one across a gap (that desyncs the avatar's voice and lips).
    let talkStream = anamClient.createTalkMessageStream();

    const response = await fetch('/api/chat-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ messages, conversationId, screenFrame: captureScreenFrame() }),
    });
    if (!response.ok) throw new Error(`brain request failed: ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (talkStream.isActive()) talkStream.endMessage();
        refreshDeliverables(); // pull-based sync: chips appear even if a stream line was missed
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // keep the trailing partial line
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.control) {
            if (obj.control.announce) {
              // Close the filler's talk turn at the tool-call gap, then speak
              // the announcement as a fresh utterance — keeps voice and lips
              // in sync across the silent gap.
              if (talkStream.isActive()) talkStream.endMessage();
              anamClient?.talk(obj.control.announce);
            }
            else if (obj.control.draft) showDraft(obj.control.draft);
            else if (obj.control.deliverable) addDeliverable(obj.control.deliverable);
            else updateBanner(obj.control); // UI only — never spoken
          } else if (obj.content) {
            if (!talkStream.isActive()) talkStream = anamClient.createTalkMessageStream();
            talkStream.streamMessageChunk(obj.content, false);
          }
        } catch {
          /* ignore partial/non-JSON lines */
        }
      }
    }
  } catch (err) {
    console.error('brain error:', err);
    anamClient?.talk("Sorry, something went wrong on my end. Please try again.");
  }
}

async function startConversation() {
  try {
    startButton.disabled = true;
    updateStatus('Connecting…', 'loading');

    // Signed out? Open Clerk's modal instead of dialing. After signing in the
    // visitor clicks Start again — no auto-dial, no surprise mic prompt.
    const clerk = await clerkReady().catch(() => null);
    if (clerk && !clerk.user) {
      // Force the OAuth round-trip to land back HERE — without this, Clerk
      // falls back to the instance home URL (usegoblin.xyz) after Google.
      clerk.openSignIn({
        forceRedirectUrl: window.location.href,
        signUpForceRedirectUrl: window.location.href,
      });
      startButton.disabled = false;
      updateStatus('Sign in, then press Start again', 'loading');
      return;
    }

    const response = await fetch('/api/session-token', {
      method: 'POST',
      headers: await authHeaders(),
    });
    if (response.status === 401) {
      if (!clerk) {
        // Auth is required but the sign-in script never loaded — the honest
        // message, not a sign-in prompt that can't appear.
        startButton.disabled = false;
        updateStatus('Sign-in couldn’t load — disable ad-blocker for this site, then retry', 'error');
        return;
      }
      clerk.openSignIn({
        forceRedirectUrl: window.location.href,
        signUpForceRedirectUrl: window.location.href,
      });
      startButton.disabled = false;
      updateStatus('Sign in, then press Start again', 'loading');
      return;
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error === 'anam_session_failed'
        ? `avatar session failed (Anam ${body.anamStatus}: ${body.detail}) — check ANAM_API_KEY on the server`
        : 'failed to get session token');
    }
    const { sessionToken } = await response.json();
    if (!sessionToken) throw new Error('empty session token from server');

    registerCapturePairing(); // pair the Kara Capture extension to this session

    anamClient = createClient(sessionToken);

    anamClient.addListener(AnamEvent.SESSION_READY, () => {
      updateStatus('Connected. Just talk to her.', 'connected');
      stopButton.disabled = false;
      stopButton.style.opacity = '1';
      setPipEnabled(true);
      setScreenEnabled(true);
      if (posterImg) posterImg.style.opacity = '0'; // live video takes the stage
      nameplate?.classList.add('live');
      anamClient.talk("Hi, I'm Kara, your design partner. Describe a website you want and I'll craft it, or point me at anything on the web to research. What are we making today?");
    });

    anamClient.addListener(AnamEvent.CONNECTION_CLOSED, stopConversation);
    anamClient.addListener(AnamEvent.MESSAGE_HISTORY_UPDATED, handleUserMessage);
    anamClient.addListener(AnamEvent.MESSAGE_HISTORY_UPDATED, renderHistory);
    anamClient.addListener(AnamEvent.TALK_STREAM_INTERRUPTED, () =>
      console.log('user interrupted the avatar')
    );

    await anamClient.streamToVideoElement('persona-video');
  } catch (err) {
    console.error('start error:', err);
    updateStatus(`Error: ${err.message}`, 'error');
    startButton.disabled = false;
  }
}

function stopConversation() {
  if (companionWin && !companionWin.closed) companionWin.close(); // restores the video element
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  setPipEnabled(false);
  stopScreenShare();
  setScreenEnabled(false);
  if (anamClient) {
    anamClient.stopStreaming();
    anamClient = null;
  }
  videoElement.srcObject = null;
  if (posterImg) posterImg.style.opacity = '1';
  nameplate?.classList.remove('live');
  renderHistory([]);
  updateBanner({ state: 'idle' });
  updateStatus('Ready when you are', 'normal');
  startButton.disabled = false;
  stopButton.disabled = true;
  stopButton.style.opacity = '0.55';
}

startButton.addEventListener('click', startConversation);
stopButton.addEventListener('click', stopConversation);
if (pipButton) pipButton.addEventListener('click', togglePip);
if (screenButton) screenButton.addEventListener('click', toggleScreenShare);
window.addEventListener('beforeunload', stopConversation);
subscribeEvents(); // push channel: research results + announcements land even before voice starts
// test hooks (harmless in production)
window.__cara = { conversationId, refreshDeliverables, addDeliverable, showDraft };
