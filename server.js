import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { dataServer, DATA_TOOL_NAMES } from './src/mcp-tools.js';
import { getSession } from './src/sessions.js';
import { listProjects } from './src/projects.js';
import { startResearchJob } from './src/research.js';
import { runFastTurn } from './src/fast-brain.js';
import { warmBrowser } from './src/browser-tools.js';
import { DELIVERABLES_ROOT } from './src/deliverables.js';
import { requireAuth, authRequired, verifyToken } from './src/auth.js';
import { isApplicant } from './src/entitlements.js';
import fsp from 'node:fs/promises';

// Brain selection: 'fast' (default) = direct Messages API loop, no
// subprocess. 'agent' = the Claude Agent SDK harness (heavier, more general).
const BRAIN = (process.env.BRAIN || 'fast').toLowerCase() === 'agent' ? 'agent' : 'fast';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  ANAM_API_KEY,
  ANTHROPIC_API_KEY,
  ANAM_AVATAR_ID = '30fa96d0-26c4-4e55-94a0-517025942e18',
  ANAM_VOICE_ID = '6bfbe25a-979d-40f3-a92b-5394170af54b',
  ANAM_AVATAR_MODEL = 'cara-4',
  WORKSPACE_DIR = path.join(__dirname, 'workspace'),
  PORT = 8000,
} = process.env;

if (!ANAM_API_KEY) console.warn('[warn] ANAM_API_KEY is not set — /api/session-token will fail.');
if (!ANTHROPIC_API_KEY) console.warn('[warn] ANTHROPIC_API_KEY is not set — the brain will fail.');

const app = express();
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(express.json({ limit: '10mb' })); // screen frames ride in the body
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'), // dev: never serve a stale script
}));
app.use('/deliverables', express.static(DELIVERABLES_ROOT)); // Kara's authored files

/* ------------------------------------------------------------------ *
 * CAPTURE — the Kara Capture Chrome extension hands us the page the
 * operator is looking at (real DOM + style digest + screenshot), keyed to
 * their conversation. Cross-origin from chrome-extension://, so CORS + a
 * per-session captureKey (registered by the signed-in page) is the auth.
 * ------------------------------------------------------------------ */
const captureCors = (_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  next();
};
app.options('/api/capture', captureCors, (_req, res) => res.sendStatus(204));

// The signed-in Kara page registers its conversation's capture key here, so a
// stray extension can't inject captures into someone else's session.
app.post('/api/capture/pair', requireAuth, (req, res) => {
  const { conversationId, captureKey } = req.body || {};
  if (!conversationId || !captureKey) return res.status(400).json({ error: 'missing_fields' });
  const session = getSession(conversationId);
  session.captureKey = String(captureKey);
  if (req.userId) session.userId = req.userId;
  res.json({ ok: true });
});

app.post('/api/capture', captureCors, (req, res) => {
  const { conversationId, captureKey, url, title, text, html, styleDigest, screenshot } = req.body || {};
  if (!conversationId || !captureKey) return res.status(400).json({ error: 'missing_fields' });
  const session = getSession(conversationId);
  if (!session.captureKey || session.captureKey !== String(captureKey)) {
    return res.status(403).json({ error: 'bad_capture_key' });
  }
  session.capture = {
    url: String(url || ''), title: String(title || ''),
    text: String(text || ''), html: String(html || ''),
    styleDigest: Array.isArray(styleDigest) ? styleDigest : [],
    screenshot: typeof screenshot === 'string' ? screenshot : '',
    at: Date.now(),
  };
  // Nudge the client (and thus Kara) that a page just arrived.
  session.push?.({ type: 'capture', url: session.capture.url, title: session.capture.title });
  console.log(`[capture] ${session.id} <- ${session.capture.title || session.capture.url}`);
  res.json({ ok: true });
});

/* --- SEAM 1: Anam session token with the default brain OFF --- */
app.post('/api/session-token', requireAuth, async (_req, res) => {
  try {
    const r = await fetch('https://api.anam.ai/v1/auth/session-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ANAM_API_KEY}` },
      body: JSON.stringify({
        personaConfig: {
          name: 'Kara — Design Partner',
          avatarId: ANAM_AVATAR_ID,
          avatarModel: ANAM_AVATAR_MODEL,
          voiceId: ANAM_VOICE_ID,
          llmId: 'CUSTOMER_CLIENT_V1',
        },
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.sessionToken) {
      // Never return 200 without a token — that made Anam failures invisible
      // (client dialed with undefined and hung). Say what Anam actually said.
      console.error('[anam] session-token failed:', r.status, JSON.stringify(data).slice(0, 300));
      return res.status(502).json({
        error: 'anam_session_failed',
        anamStatus: r.status,
        detail: data?.message || data?.error || 'no sessionToken in Anam response',
      });
    }
    res.json({ sessionToken: data.sessionToken });
  } catch (err) {
    console.error('session-token error:', err);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

/* ------------------------------------------------------------------ *
 * PUSH CHANNEL — server-sent events, one stream per operator.
 * Background jobs (deep research) announce results through this.
 * ------------------------------------------------------------------ */
app.get('/api/events', async (req, res) => {
  // EventSource can't send an Authorization header, so the token rides as a
  // query param. Verified at open; the client reopens with a fresh token on
  // error, so short-lived Clerk JWTs still work across reconnects.
  const userId = await verifyToken(String(req.query.token || ''));
  if (authRequired && !userId) return res.status(401).end();
  const session = getSession(req.query.conversationId);
  console.log(`[events] push channel OPEN for ${session.id}`);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const push = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  push({ type: 'hello' });
  session.push = push; // background jobs (research) announce through this
  const keepAlive = setInterval(() => res.write(':ka\n\n'), 25000);
  req.on('close', () => { console.log(`[events] push channel CLOSED for ${session.id}`); clearInterval(keepAlive); if (session.push === push) session.push = null; });
});

/* Demo trigger: start a research job without voice (rehearsal/filming).
 * Hard-disabled in demo mode — it spins up the full Opus researcher and a
 * browser, which is not part of the public demo surface. */
app.post('/api/demo/research', requireAuth, (req, res) => {
  if ((process.env.DEMO_MODE ?? '1') !== '0') {
    return res.status(403).json({ error: 'disabled in demo mode' });
  }
  const { conversationId, question } = req.body || {};
  const session = getSession(conversationId);
  const filename = startResearchJob(session, String(question || 'latest AI agent trends'));
  res.json({ ok: true, filename });
});

/* List this session's deliverables (pull-based sync for the Files panel). */
app.get('/api/deliverables', async (req, res) => {
  const id = String(req.query.conversationId || '').replace(/[^a-zA-Z0-9-]/g, '');
  if (!id) return res.json({ files: [] });
  try {
    const dir = path.join(DELIVERABLES_ROOT, id);
    const names = await fsp.readdir(dir).catch(() => []);
    res.json({ files: names.map((n) => ({ name: n, url: `/deliverables/${id}/${n}` })) });
  } catch {
    res.json({ files: [] });
  }
});

/* Cross-session project history for the signed-in user (Chinedu's feature
 * request): every page Kara publishes is indexed per user in
 * deliverables/_projects/, so returning users can see what they've built. */
app.get('/api/projects', requireAuth, async (req, res) => {
  const uid = req.userId || (authRequired ? null : 'dev');
  res.json({ projects: await listProjects(uid) });
});

/* ------------------------------------------------------------------ *
 * PERMISSIONS (agent path) — read-only tools only.
 * ------------------------------------------------------------------ */
const READ_ONLY_BUILTINS = ['Read', 'Glob', 'Grep'];
const AUTO_APPROVED = [...READ_ONLY_BUILTINS, ...DATA_TOOL_NAMES];
const AUTO_SET = new Set(AUTO_APPROVED);

const SYSTEM_PROMPT = `You are Kara, a spoken voice assistant and design partner. Your text goes straight to a
text-to-speech avatar, so reply the way a person speaks: short, natural sentences, no markdown, no
lists, no code. Keep replies under about 80 words, and turn numbers and dates into spoken phrases.

Read-only sources — use them instead of guessing:
- The workspace folder (Read, Glob, Grep) for files.
- query_database for customers, orders, revenue, order status.
- list_calendar_events for the schedule.

If asked to change files or run commands, say plainly that you're in read-only mode for those.`;

/* --- SEAMS 2 + 3: the brain --- */
let agentSessionId;

app.post('/api/chat-stream', requireAuth, async (req, res) => {
  const { messages = [], conversationId, screenFrame } = req.body;
  const session = getSession(conversationId);
  if (req.userId) session.userId = req.userId; // ties transcripts to the applicant
  else if (!authRequired) session.userId = 'dev'; // local dev: project history still works
  // Work-trial applicants get the full brain for this turn; everyone else the
  // demo brain. Resolved per request (cached in-process) so the allowlist can
  // change mid-flight without a restart.
  session.fullBrain = await isApplicant(req.userId);
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const prompt = lastUser?.content?.trim();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (!prompt) return void res.end();

  const canUseTool = async (toolName, input) => {
    if (AUTO_SET.has(toolName)) return { behavior: 'allow', updatedInput: input };
    return { behavior: 'deny', message: `"${toolName}" is disabled in this scaffold.` };
  };

  const speak = (content) => {
    if (content) res.write(JSON.stringify({ content }) + '\n');
  };
  const control = (payload) => res.write(JSON.stringify({ control: payload }) + '\n');

  const finishTurn = () => {
    // Surface any files Kara authored this turn as download chips.
    if (Array.isArray(session.deliverables)) {
      for (const d of session.deliverables.splice(0)) control({ deliverable: d });
    }
    control({ state: 'idle' });
  };

  // Transcript log — one exchange per request, per conversation, so past
  // sessions can be reviewed after the browser tab is gone.
  const logTranscript = (caraText) => {
    const dir = path.join(__dirname, 'transcripts');
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const who = session.userId
      ? `You (${session.userId}${session.fullBrain ? ', trial' : ''})`
      : 'You';
    const line = `[${stamp}] ${who}:  ${String(prompt).replace(/\s+/g, ' ')}\n[${stamp}] Kara: ${caraText}\n\n`;
    fsp.mkdir(dir, { recursive: true })
      .then(() => fsp.appendFile(path.join(dir, `${session.id}.log`), line))
      .catch(() => {});
  };

  /* FAST BRAIN (default): direct Messages API tool loop — no subprocess,
   * token streaming from the first model token. */
  if (BRAIN === 'fast') {
    let spoken = '';
    const speakLogged = (content) => { spoken += content; speak(content); };
    try {
      await runFastTurn({
        messages, workspaceDir: WORKSPACE_DIR, session,
        fullBrain: session.fullBrain,
        screenFrame: screenFrame || null, speak: speakLogged,
        onDraft: (d) => control({ draft: d }), // live document panel
        // Delivery announcement: shipped as a control so the client speaks it
        // as its own talk turn instead of stuffing it into the filler stream.
        announce: (text) => { spoken += ' ' + text; control({ announce: text }); },
      });
    } catch (err) {
      console.error('fast-brain error:', err);
      speakLogged('Sorry, I hit a snag. Could you try that again?');
    } finally {
      logTranscript(spoken.trim() || '(no reply — duplicate or superseded turn)');
      finishTurn(); // chips flush even after an error
      res.end();
    }
    return;
  }

  /* AGENT BRAIN (BRAIN=agent): the Claude Agent SDK path. */
  try {
    const run = query({
      prompt,
      options: {
        cwd: WORKSPACE_DIR,
        model: 'sonnet',
        systemPrompt: SYSTEM_PROMPT,
        mcpServers: { data: dataServer },
        allowedTools: AUTO_APPROVED,
        canUseTool,
        maxTurns: 20,
        includePartialMessages: true, // emit token-level stream events for low-latency speech
        ...(agentSessionId ? { resume: agentSessionId } : {}),
      },
    });

    // With partial messages on, we speak text_delta tokens the moment they
    // arrive. The same text arrives again later inside the full assistant
    // message, so once any delta has been spoken we stop speaking whole
    // blocks — otherwise she'd say everything twice. If the SDK ever stops
    // emitting deltas (version drift), the block path kicks back in.
    let spokeViaDeltas = false;

    for await (const message of run) {
      if (message.type === 'system' && message.subtype === 'init') {
        agentSessionId = message.session_id ?? message.data?.session_id ?? agentSessionId;
      }
      if (message.type === 'stream_event') {
        const ev = message.event;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          spokeViaDeltas = true;
          speak(ev.delta.text); // token-level: she starts talking immediately
        }
      }
      if (message.type === 'assistant' && !spokeViaDeltas) {
        for (const block of message.message.content) {
          if (block.type === 'text') speak(block.text);
        }
      }
    }

    finishTurn();
  } catch (err) {
    console.error('agent error:', err);
    speak('Sorry, I ran into a problem. Could you try that again?');
  } finally {
    res.end();
  }
});

app.listen(PORT, () => {
  console.log('\n  Kara — Design Partner');
  console.log(`  ▸ open       http://localhost:${PORT}`);
  console.log(`  ▸ brain      ${BRAIN === 'fast' ? `FAST (direct API, ${process.env.FAST_MODEL || 'claude-sonnet-4-6'})` : 'AGENT (Claude Agent SDK)'}  — set BRAIN=agent|fast to switch`);
  console.log(`  ▸ research   ${process.env.RESEARCH_MODEL || 'claude-opus-4-7'} (background deep-research agent)`);
  console.log(`  ▸ focus      design research + website crafting (Zendesk unwired)`);
  console.log(`  ▸ workspace  ${WORKSPACE_DIR}  (read-only)`);
  console.log(`  ▸ auth       ${authRequired ? 'Clerk sign-in REQUIRED (set REQUIRE_AUTH=0 for local dev)' : 'OFF (REQUIRE_AUTH=0)'}`);
  warmBrowser().then((ok) => console.log(ok ? '  ▸ browser    warmed (Chromium ready)\n' : '  ▸ browser    unavailable — run: npx playwright install chromium\n'));
});
