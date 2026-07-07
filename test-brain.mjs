/* Brain test — no Anam, no browser, no microphone.
 *
 * Spawns the server on a dedicated port and plays four "spoken" turns through
 * the real /api/chat-stream endpoint, so it exercises the actual confirmation
 * gate (canUseTool) — not a copy of it. Needs only ANTHROPIC_API_KEY in .env.
 * Zendesk runs in mock mode unless ZENDESK_* is set.
 *
 *   npm run test:brain      (or: node test-brain.mjs)
 */
import 'dotenv/config';
import { spawn } from 'node:child_process';

const PORT = process.env.TEST_PORT || 8137;
const BASE = `http://localhost:${PORT}`;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('\n✗ ANTHROPIC_API_KEY is not set. Add it to .env (see .env.example) and re-run.\n');
  process.exit(1);
}

let serverExited = false;

async function waitForServer(timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (serverExited) return false;
    try {
      const r = await fetch(`${BASE}/`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

// POST one turn and read the newline-delimited {content}/{control} stream.
async function runTurn(messages) {
  const res = await fetch(`${BASE}/api/chat-stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  });
  if (!res.ok) throw new Error(`chat-stream HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let speech = '';
  let banner = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.control) banner = obj.control;
        else if (obj.content) speech += obj.content;
      } catch {
        /* ignore partial/non-JSON lines */
      }
    }
  }
  return { speech: speech.trim(), banner };
}

let failures = 0;
function report(label, said, banner, expect) {
  console.log('\n' + '─'.repeat(64));
  console.log(`▶ ${label}`);
  console.log(`  Cara:   ${said || '(no speech)'}`);
  console.log(`  Banner: ${banner ? `${banner.state}${banner.text ? ' — ' + banner.text : ''}` : '(none)'}`);
  if (expect) {
    const ok = banner?.state === expect.state;
    console.log(`  Expect banner "${expect.state}": ${ok ? 'PASS ✓' : 'FAIL ✗'}  (${expect.why})`);
    if (!ok) failures++;
  }
}

async function main() {
  console.log(`\nStarting server on port ${PORT}  (Zendesk: ${process.env.ZENDESK_SUBDOMAIN ? 'LIVE' : 'mock'})…`);
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(`[server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  child.on('exit', (code) => {
    serverExited = true;
    if (code) console.error(`[server] exited early with code ${code}`);
  });

  const cleanup = () => child.kill('SIGTERM');
  process.on('SIGINT', () => {
    cleanup();
    process.exit(1);
  });

  try {
    if (!(await waitForServer())) {
      throw new Error('server did not become ready (see [server] output above — usually a missing dep or bad key)');
    }

    // Accumulate an Anam-style history and feed a "spoken" turn each call.
    const history = [];
    const say = async (label, text, expect) => {
      history.push({ role: 'user', content: text });
      const { speech, banner } = await runTurn(history);
      history.push({ role: 'assistant', content: speech });
      report(`${label}   you: "${text}"`, speech, banner, expect);
    };

    await say('Turn 1 — read a ticket list', 'What tickets are open right now?',
      { state: 'idle', why: 'a read touches nothing, so no pending action' });

    await say('Turn 2 — stage a write', 'Solve ticket 4302 and reply that the reset link is fixed.',
      { state: 'pending', why: 'must stage and ask, not write yet' });

    await say('Turn 3 — non-confirming turn (gate must hold)', 'Wait — remind me what that ticket was about?',
      { state: 'pending', why: 'no confirm word, so nothing may commit' });

    await say('Turn 4 — confirm out loud', 'Confirm, send it.',
      { state: 'done', why: 'now, and only now, the Zendesk write fires' });

    console.log('\n' + '═'.repeat(64));
    if (failures === 0) {
      console.log('✓ All checks passed. Brain, tools, and the spoken gate work end-to-end.');
      console.log('  The write stayed blocked through turn 3 and fired only on "confirm".');
    } else {
      console.log(`✗ ${failures} check(s) failed — read the turns above.`);
      console.log('  Note: the model is not perfectly deterministic; re-run once before digging in.');
    }
    console.log('');
  } catch (err) {
    console.error('\nTest error:', err.message, '\n');
    failures++;
  } finally {
    cleanup();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main();
