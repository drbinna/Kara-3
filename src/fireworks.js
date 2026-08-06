/* Fireworks (Kimi K3) provider — same contract as the Anthropic step:
 * takes internal Anthropic-shaped {system, messages, tools, onText, onDraft},
 * returns { contentBlocks, stopReason } in the internal block shapes.
 *
 * Kimi K3 is a thinking model: streamed deltas carry `reasoning_content`
 * (its chain of thought — NEVER spoken) separately from `content` (the
 * reply Kara says out loud). Tool calls stream as OpenAI `tool_calls`
 * argument fragments, which also feed the live document panel.
 */
import { extractDraft } from './fast-brain.js';

const FW_URL = 'https://api.fireworks.ai/inference/v1/chat/completions';
export const FIREWORKS_MODEL =
  process.env.FIREWORKS_MODEL || 'accounts/fireworks/routers/kimi-k3-fast';

/* ---- request-side translation ---- */

function toOpenAiTools(tools) {
  // Only local function tools translate; Anthropic server-side tools
  // (web_search_20*, computer_20*) don't exist on Fireworks.
  return (tools || [])
    .filter((t) => t && t.name && t.input_schema)
    .map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
}

function imagePart(block) {
  return {
    type: 'image_url',
    image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
  };
}

function toOpenAiMessages(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const toolCalls = m.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      // thinking / server_tool blocks are Anthropic-internal — dropped here.
      out.push({ role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      continue;
    }
    // user message: may mix text, images, and tool_results
    const parts = [];
    const toolMsgs = [];
    const trailingImages = [];
    for (const b of m.content) {
      if (b.type === 'text') parts.push({ type: 'text', text: b.text });
      else if (b.type === 'image') parts.push(imagePart(b));
      else if (b.type === 'tool_result') {
        const inner = Array.isArray(b.content) ? b.content : [{ type: 'text', text: String(b.content ?? '') }];
        const text = inner.filter((x) => x.type === 'text').map((x) => x.text).join('\n') || '(no output)';
        toolMsgs.push({ role: 'tool', tool_call_id: b.tool_use_id, content: text });
        // OpenAI tool messages are text-only: screenshots ride as a follow-up
        // user message so the model still SEES them.
        for (const x of inner) if (x.type === 'image') trailingImages.push(imagePart(x));
      }
    }
    for (const t of toolMsgs) out.push(t);
    if (parts.length) out.push({ role: 'user', content: parts });
    if (trailingImages.length) {
      out.push({ role: 'user', content: [{ type: 'text', text: '(screenshot from the tool call above)' }, ...trailingImages] });
    }
  }
  return out;
}

function toOpenAiToolChoice(tc) {
  if (!tc) return undefined;
  if (tc.type === 'tool' && tc.name) return { type: 'function', function: { name: tc.name } };
  if (tc.type === 'any') return 'required';
  return 'auto';
}

/* ---- the step ---- */

export async function fireworksModelStep({ system, messages, onText, onDraft, toolChoice, signal, tools }) {
  const res = await fetch(FW_URL, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.FIREWORKS_API_KEY}`,
    },
    body: JSON.stringify({
      model: FIREWORKS_MODEL,
      max_tokens: 16384, // reasoning + a full document share this budget
      messages: toOpenAiMessages(system, messages),
      tools: toOpenAiTools(tools),
      ...(toolChoice ? { tool_choice: toOpenAiToolChoice(toolChoice) } : {}),
      stream: true,
    }),
  });
  if (!res.ok) throw new Error(`Fireworks API ${res.status}: ${await res.text()}`);

  const blocks = [];
  let textBlock = null; // single accumulated text block
  const toolByIndex = new Map(); // OpenAI tool_calls index -> internal block
  let finish = null;

  const handle = (data) => {
    const choice = data.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finish = choice.finish_reason;
    const d = choice.delta || {};
    // d.reasoning_content = chain of thought — intentionally dropped, never spoken.
    if (d.content) {
      if (!textBlock) { textBlock = { type: 'text', text: '' }; blocks.push(textBlock); }
      textBlock.text += d.content;
      onText(d.content);
    }
    for (const tc of d.tool_calls || []) {
      let blk = toolByIndex.get(tc.index);
      if (!blk) {
        blk = { type: 'tool_use', id: tc.id || `call_${tc.index}_${Date.now()}`, name: '', input: {}, _json: '' };
        toolByIndex.set(tc.index, blk);
        blocks.push(blk);
      }
      if (tc.id) blk.id = tc.id;
      if (tc.function?.name) blk.name = blk.name || tc.function.name;
      if (tc.function?.arguments) {
        blk._json += tc.function.arguments;
        if (onDraft && blk.name === 'save_deliverable') {
          const draft = extractDraft(blk._json);
          if (draft && draft.content.length - (blk._draftSent || 0) > 150) {
            blk._draftSent = draft.content.length;
            onDraft(draft);
          }
        }
      }
    }
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { handle(JSON.parse(payload)); } catch { /* ignore malformed lines */ }
    }
  }

  // finalize tool blocks into the internal shape
  for (const blk of toolByIndex.values()) {
    if (onDraft && blk.name === 'save_deliverable') {
      const draft = extractDraft(blk._json || '');
      if (draft) onDraft({ ...draft, done: true });
    }
    try { blk.input = blk._json ? JSON.parse(blk._json) : {}; }
    catch { blk.input = {}; blk._truncated = true; }
    delete blk._json;
    delete blk._draftSent;
  }

  const stopReason =
    finish === 'tool_calls' ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end_turn';
  return { contentBlocks: blocks, stopReason };
}
