/* The research subagent — a second, independent model loop that grinds
 * through the web in the background while Kara stays conversational.
 *
 * Lifecycle: deep_research tool → job starts, Kara replies immediately →
 * worker searches/reads with its own browser session → saves the brief as a
 * deliverable → announces completion over the operator's push channel.
 *
 * FAKE_RESEARCH=1 short-circuits to a canned brief after ~2s — for rehearsing
 * and filming the interaction without a multi-minute real run.
 */
import { streamModelStep, executeToolCall } from './fast-brain.js';
import { saveDeliverable } from './deliverables.js';

/* The researcher runs in the background, so latency doesn't matter — give it
 * the most capable model for real depth. Override with RESEARCH_MODEL. */
export const RESEARCH_MODEL = process.env.RESEARCH_MODEL || 'claude-opus-4-7';

const RESEARCH_SYSTEM = `You are a research analyst working for Kara, a Goblin Labs operator. You are NOT
speaking to anyone — your only output that matters is the final brief. Work efficiently: web_search,
open the 2-4 best sources IN ONE PARALLEL STEP, read, then produce the final brief as plain markdown
in your LAST message (no tool call): a title, key findings with specifics, and a short sources list.
Keep it under 250 lines.`;

// web_search is server-side now (runs inside the API call) — only client
// tools need to be allow-listed here.
const RESEARCH_TOOLS = new Set(['browser_open', 'browser_read', 'browser_click', 'browser_screenshot']);
const MAX_ROUNDS = 10;

function slugify(q) {
  return q.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'research-brief';
}

async function runResearch(session, question) {
  if (process.env.FAKE_RESEARCH) {
    await new Promise((r) => setTimeout(r, 2000));
    return `# ${question}\n\n(FAKE_RESEARCH rehearsal brief)\n\n- Finding one\n- Finding two\n\nSources: rehearsal mode.`;
  }
  // Researcher gets its own browser session so it never fights Kara's page.
  const researchCtx = { workspaceDir: '.', turnConfirmed: false, session: { ...session, id: `${session.id}-research` } };
  const messages = [{ role: 'user', content: `Research question: ${question}` }];
  let lastText = '';
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { contentBlocks, stopReason } = await streamModelStep({
      system: RESEARCH_SYSTEM,
      messages,
      onText: () => {}, // silent worker
      model: RESEARCH_MODEL,
    });
    lastText = contentBlocks.filter((b) => b.type === 'text').map((b) => b.text).join('') || lastText;
    // Server-side web_search paused mid-loop: resend to resume.
    if (stopReason === 'pause_turn') {
      messages.push({ role: 'assistant', content: contentBlocks });
      continue;
    }
    const toolUses = contentBlocks.filter((b) => b.type === 'tool_use');
    if (stopReason !== 'tool_use' || !toolUses.length) break;
    messages.push({ role: 'assistant', content: contentBlocks });
    // Every tool_use must get a tool_result (the API 400s otherwise), so
    // disallowed tools get a refusal string instead of being dropped.
    const outs = await Promise.all(toolUses.map((tu) =>
      RESEARCH_TOOLS.has(tu.name)
        ? executeToolCall(tu.name, tu.input || {}, researchCtx)
        : Promise.resolve(`Error: "${tu.name}" is not available to the researcher. Do not save files — write the final brief as plain markdown text in your next message.`)
    ));
    messages.push({
      role: 'user',
      content: toolUses.map((tu, i) => ({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: typeof outs[i] === 'string' ? outs[i] : outs[i].blocks,
      })),
    });
  }
  return lastText || `# ${question}\n\nResearch did not converge — try narrowing the question.`;
}

export function startResearchJob(session, question) {
  const filename = `${slugify(question)}.md`;
  (async () => {
    const startedAt = Date.now();
    try {
      const brief = await runResearch(session, question);
      const file = await saveDeliverable(session.id, filename, brief);
      const secs = Math.round((Date.now() - startedAt) / 1000);
      console.log(`[research] done in ${secs}s → ${file.url}`);
      session.push?.({ type: 'deliverable', file });
      session.push?.({
        type: 'announce',
        text: `My researcher just finished the brief on ${question}. It's on your screen — want the highlights?`,
      });
    } catch (err) {
      console.error('[research] failed:', err.message);
      session.push?.({ type: 'announce', text: `Sorry — the research on ${question} hit a snag: ${err.message.slice(0, 80)}. Want me to try again?` });
    }
  })();
  return filename;
}
