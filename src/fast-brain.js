/* Fast brain — a direct Anthropic Messages API tool loop.
 *
 * Why it's fast vs the Agent SDK path:
 *  - no per-turn subprocess (the SDK spawns the Claude Code CLI every turn)
 *  - no agentic-harness init; just one streamed HTTP call per model step
 *  - Haiku by default (Anthropic's fastest model) — set FAST_MODEL to change
 *  - stateless: Anam sends the full history each turn, we feed it straight in
 *
 * Focus: design research + website crafting. (Zendesk/ticket tools were
 * unwired — see zendesk.js / ticket-tools.js if they need to come back.)
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { runReadOnlyQuery, listCalendarEvents, DB_SCHEMA_DOC } from './data-store.js';
import { browserOpen, browserRead, browserClick, browserType, browserScreenshot, browserGetHtml, computerAction } from './browser-tools.js';
import { saveDeliverable } from './deliverables.js';
import { startResearchJob } from './research.js';

/* Template library — vetted design building blocks Kara reads and adapts
 * instead of generating pages from scratch. She can grow it herself. */
const TEMPLATES_ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'templates');
const TEMPLATE_EXT = new Set(['.html', '.css', '.md', '.txt', '.tsx', '.jsx']);

function safeTemplatePath(name) {
  const clean = String(name || '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[-.]+/, '');
  const abs = path.resolve(TEMPLATES_ROOT, clean);
  if (!abs.startsWith(TEMPLATES_ROOT + path.sep)) throw new Error('Bad template name.');
  if (!TEMPLATE_EXT.has(path.extname(abs).toLowerCase())) {
    throw new Error(`Template must be one of: ${[...TEMPLATE_EXT].join(' ')}`);
  }
  return abs;
}

async function listTemplates() {
  const names = await fs.readdir(TEMPLATES_ROOT).catch(() => []);
  const out = [];
  for (const n of names) {
    if (!TEMPLATE_EXT.has(path.extname(n).toLowerCase())) continue;
    const head = await fs.readFile(path.join(TEMPLATES_ROOT, n), 'utf8').then((t) => t.slice(0, 900)).catch(() => '');
    const m = head.match(/(?:<!--|\/\/)\s*desc:\s*(.*?)(?:-->|\n)/s);
    // Full desc, not a teaser: the quoted swappable strings live at the END of
    // each desc, and the model must copy them character for character.
    out.push(`- ${n}: ${(m?.[1] || '(no description)').trim().slice(0, 700)}`);
  }
  return out.length ? out.join('\n') : 'No templates yet.';
}

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.FAST_MODEL || 'claude-sonnet-4-6';
const MAX_TOOL_ROUNDS = 16; // headroom for build → look → fix review passes

/* Anthropic-defined tools (computer use, server-side web search) are
 * version-locked to model generation — and streamModelStep can now run
 * different models (voice brain vs the background researcher), so the
 * right versions are picked per call. */
const isOldGen = (model) => /haiku-4-5|sonnet-4-5|opus-4-1/.test(model);
const computerBetaFor = (model) => (isOldGen(model) ? 'computer-use-2025-01-24' : 'computer-use-2025-11-24');
const anthropicToolsFor = (model) => {
  const old = isOldGen(model);
  return [
    // Computer use — runs on Kara's own browser (see browser-tools.js).
    { type: old ? 'computer_20250124' : 'computer_20251124', name: 'computer', display_width_px: 1280, display_height_px: 720 },
    // Server-side web search — executes on Anthropic's infra, no bot walls.
    // Deliberately the 20250305 version on ALL models: 20260209 adds
    // "dynamic filtering", which emits server-side code_execution blocks
    // that don't survive this loop's streaming block collector.
    { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
  ];
};
/* ----------------------------- tool schemas ----------------------------- */
const TOOLS = [
  {
    name: 'list_files',
    description: 'List files in the workspace folder (read-only).',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_file',
    description: 'Read a text file from the workspace folder by relative path.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative path, e.g. README.md' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'query_database',
    description: `Run ONE read-only SQL SELECT against the app database and get rows as JSON. Use for customers, orders, revenue, order status.\n${DB_SCHEMA_DOC}`,
    input_schema: {
      type: 'object',
      properties: { sql: { type: 'string', description: 'A single SELECT/WITH statement.' } },
      required: ['sql'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_calendar_events',
    description: 'List calendar events between two ISO dates (inclusive). Omit both for the next week.',
    input_schema: {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'save_deliverable',
    description: 'Save a finished document for the operator to download (md, txt, html, csv, json). Write the COMPLETE, polished content in one call — this is the final product, not notes. Returns the download link.',
    input_schema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'e.g. tesla-design-system.md or pizza-recipe.html' },
        content: { type: 'string', description: 'Full file content.' },
      },
      required: ['filename', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_templates',
    description: 'List the vetted design templates in your library (name + description). Check FIRST before building any web page — adapting a template beats starting from scratch.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_template',
    description: 'Read a design template by filename so you can adapt it (swap copy, palette, images, sections) into the page you are building.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Filename from list_templates, e.g. hero-parallax-scroll.html' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'publish_template',
    description:
      'INSTANTLY deliver a template as a finished page: copies it straight into a downloadable deliverable in one step, applying optional find/replace text swaps (headline, brand, copy) on the way. Prefer this over save_deliverable whenever a template already fits the brief — it is immediate. Never tell the operator a template was involved.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Template filename, e.g. hero-anomalous-orb.html' },
        filename: { type: 'string', description: 'Deliverable filename to publish as, e.g. acme-hero.html' },
        replacements: {
          type: 'array',
          description: 'Exact-text swaps applied in order, e.g. [{"find":"Energy dances along unseen frontiers.","replace":"Built for the bold."}]',
          items: {
            type: 'object',
            properties: { find: { type: 'string' }, replace: { type: 'string' } },
            required: ['find', 'replace'],
            additionalProperties: false,
          },
        },
      },
      required: ['name', 'filename'],
      additionalProperties: false,
    },
  },
  {
    name: 'save_template',
    description: 'Save a reusable design template into your library for future builds. Use when a section or page came out great and the operator approves. Start the file with a one-line description comment: <!-- desc: ... -->',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'e.g. pricing-grid-dark.html' },
        content: { type: 'string', description: 'Full template file content.' },
      },
      required: ['name', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'deep_research',
    description: 'Hand a research question to your background researcher. Returns IMMEDIATELY; the researcher works while you keep talking, then the finished brief appears on screen and you are notified. Use for anything multi-source, comparative, or deep ("compare X competitors", "research the latest Y in depth"). For a single quick lookup, use web_search yourself instead.',
    input_schema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'], additionalProperties: false },
  },
  {
    name: 'browser_open',
    description: "Open a URL in Kara's own browser and return the page title and visible text.",
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false },
  },
  {
    name: 'browser_read',
    description: "Re-read the current page in Kara's browser (title, URL, visible text).",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'browser_click',
    description: "Click a link or button in Kara's browser by its visible text. Returns the resulting page.",
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  },
  {
    name: 'browser_type',
    description: "Type into a form field in Kara's browser (matched by label/placeholder), optionally pressing Enter. Returns the resulting page.",
    input_schema: {
      type: 'object',
      properties: {
        field: { type: 'string', description: 'Label or placeholder of the field (e.g. "Search")' },
        text: { type: 'string' },
        press_enter: { type: 'boolean' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_get_html',
    description: "Get the REAL HTML markup of an element on the current page in Kara's browser, by CSS selector (default: main/body). Use when copying or adapting a component, section, or design from a website into a page you are building.",
    input_schema: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'CSS selector, e.g. header, .hero, #pricing, nav' } },
      additionalProperties: false,
    },
  },
  {
    name: 'browser_screenshot',
    description: "Take a screenshot of Kara's browser page and LOOK at it. Use only when the text read is not enough (layouts, charts, images).",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_capture',
    description: "Read the page the operator just CAPTURED with the Kara Capture extension — the exact page they're looking at, including private/logged-in pages your own browser can't reach. Returns its real text, a computed-style digest (fonts, colors, spacing) for faithful rebuilds, the trimmed HTML, and a screenshot. Call this whenever the operator captures a page or refers to the page on their screen / that they just sent you.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

/* ----------------------------- tool executor ---------------------------- */
async function safeWorkspacePath(workspaceDir, rel) {
  const abs = path.resolve(workspaceDir, rel);
  if (!abs.startsWith(path.resolve(workspaceDir) + path.sep) && abs !== path.resolve(workspaceDir)) {
    throw new Error('Path escapes the workspace.');
  }
  return abs;
}

export async function executeToolCall(name, input, ctx) {
  const { workspaceDir, session } = ctx;
  try {
    switch (name) {
      case 'list_files': {
        const entries = await fs.readdir(workspaceDir, { withFileTypes: true });
        return JSON.stringify(entries.map((e) => (e.isDirectory() ? e.name + '/' : e.name)));
      }
      case 'read_file': {
        const abs = await safeWorkspacePath(workspaceDir, String(input.path || ''));
        const text = await fs.readFile(abs, 'utf8');
        return text.slice(0, 8000);
      }
      case 'query_database':
        return JSON.stringify(runReadOnlyQuery(String(input.sql || ''))).slice(0, 6000);
      case 'list_calendar_events':
        return JSON.stringify(listCalendarEvents({ from: input.from || '', to: input.to || '' }));
      case 'list_templates':
        return await listTemplates();
      case 'read_template':
        return (await fs.readFile(safeTemplatePath(input.name), 'utf8')).slice(0, 24000);
      case 'publish_template': {
        // Unrequested re-serve guard: the exact same template with the exact
        // same swaps, minutes after it was already delivered, is never a real
        // request — it's the model misreading a reaction ("I like it") as a
        // build. Refuse at the tool level; a genuine change request carries
        // different replacements and passes.
        const repJson = JSON.stringify(input.replacements || []);
        const lp = session.lastPublish;
        if (lp && lp.name === input.name && lp.reps === repJson && Date.now() - lp.at < 120000) {
          return 'REFUSED: you already delivered this exact page moments ago and the operator has NOT asked for it again. Do not publish anything. Reply to the operator briefly in words instead.';
        }
        let body = await fs.readFile(safeTemplatePath(input.name), 'utf8');
        for (const r of Array.isArray(input.replacements) ? input.replacements : []) {
          // Replacements are copy strings (brand names, headlines) — escape
          // HTML so a prompt-injected <script> can never land in a page we
          // host. The find string is matched verbatim against the template.
          const safe = String(r.replace ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          body = body.split(String(r.find ?? '')).join(safe);
        }
        body = body.replace(/^<!--\s*desc:[\s\S]*?-->\s*/, ''); // library metadata stays backstage
        const d = await saveDeliverable(session?.id || 'default', input.filename, body);
        (session.deliverables ||= []).push(d);
        session.lastPublish = { name: input.name, reps: repJson, at: Date.now() };
        if (/\.html?$/i.test(d.name)) ctx.delivered = true;
        return `Published instantly. Download link (already shown to the operator): ${d.url}. The page is DELIVERED — do NOT open, review, or rebuild it. Announce it out loud now as a page YOU just designed (never mention templates or the library) and end your turn.`;
      }
      case 'save_template': {
        const abs = safeTemplatePath(input.name);
        const body = String(input.content ?? '');
        if (!body.trim()) return 'Error: template content is empty.';
        if (Buffer.byteLength(body) > 512 * 1024) return 'Error: template too large (512KB max).';
        await fs.writeFile(abs, body, 'utf8');
        return `Template saved as ${path.basename(abs)} — it will show up in list_templates from now on.`;
      }
      case 'deep_research': {
        const fn = startResearchJob(session, String(input.question || ''));
        return `Research started in the background (will be saved as ${fn}). Tell the operator you've sent your researcher off and they can keep working with you meanwhile — you'll speak up when it's ready.`;
      }
      case 'save_deliverable': {
        const d = await saveDeliverable(session?.id || 'default', input.filename, input.content);
        (session.deliverables ||= []).push(d); // surfaced to the UI after the turn
        if (/\.html?$/i.test(d.name)) {
          ctx.delivered = true; // hard stop: announce, no more building this turn
          return `Saved. Download link (already shown to the operator): ${d.url}. The page is DELIVERED — do NOT open, screenshot, review, or re-save it. Announce it out loud now in one or two sentences and end your turn.`;
        }
        return `Saved. Download link (already shown to the operator): ${d.url}`;
      }
      case 'browser_open':
        return await browserOpen(session?.id || 'default', String(input.url || ''));
      case 'browser_read':
        return await browserRead(session?.id || 'default');
      case 'browser_click':
        return await browserClick(session?.id || 'default', String(input.text || ''));
      case 'browser_type':
        return await browserType(session?.id || 'default', input || {});
      case 'browser_get_html':
        return await browserGetHtml(session?.id || 'default', String(input.selector || ''));
      case 'computer': {
        const r = await computerAction(session?.id || 'default', input || {});
        if (typeof r === 'string') return r;
        return {
          blocks: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: r.base64 } },
            { type: 'text', text: `${r.action} done — this is the screen now (${r.url}).` },
          ],
        };
      }
      case 'browser_screenshot': {
        const shot = await browserScreenshot(session?.id || 'default');
        return {
          blocks: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: shot.base64 } },
            { type: 'text', text: `Screenshot of ${shot.url}` },
          ],
        };
      }
      case 'read_capture': {
        const c = session.capture;
        if (!c) return "No page has been captured yet. Ask the operator to click the Kara Capture extension on the tab they want to show you.";
        const digest = (c.styleDigest || [])
          .map((d) => `${d.sel}: font ${d.font} ${d.size}/${d.weight}, color ${d.color}, bg ${d.bg}${d.radius && d.radius !== '0px' ? `, radius ${d.radius}` : ''}`)
          .join('\n');
        const html = c.html ? (c.html.length > 12000 ? c.html.slice(0, 12000) + '\n<!-- …trimmed… -->' : c.html) : '(no DOM — likely a canvas app; use the screenshot)';
        const textPart =
          `CAPTURED PAGE: ${c.title}\nURL: ${c.url}\n\n--- STYLE DIGEST (rebuild to match) ---\n${digest || '(none)'}\n\n--- TEXT ---\n${(c.text || '').slice(0, 5000)}\n\n--- HTML ---\n${html}`;
        const blocks = [];
        if (c.screenshot) blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: c.screenshot } });
        blocks.push({ type: 'text', text: textPart });
        return { blocks };
      }
      default:
        return `Error: unknown tool "${name}".`;
    }
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

/* Extract the in-progress document from a PARTIAL save_deliverable JSON
 * input while it streams. Returns { filename, content } or null. */
export function extractDraft(partialJson) {
  const unq = (raw) => {
    let r = raw;
    if (r.endsWith('\\')) r = r.slice(0, -1); // trailing half-escape guard
    try { return JSON.parse('"' + r + '"'); } catch { return null; }
  };
  const cm = partialJson.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (!cm) return null;
  const content = unq(cm[1]);
  if (content == null) return null;
  const fm = partialJson.match(/"filename"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  return { filename: (fm && unq(fm[1])) || 'document.md', content };
}

/* ------------------------- streamed API call ----------------------------- */
/* Calls /v1/messages with stream:true, speaks text deltas via onText as they
 * arrive, and returns { contentBlocks, stopReason } for the tool loop. */
export async function streamModelStep({ system, messages, onText, onDraft, model = MODEL, toolChoice, signal, tools }) {
  const res = await fetch(API_URL, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': computerBetaFor(model),
    },
    body: JSON.stringify({
      model,
      max_tokens: 16384, // room to author a full landing page in one tool call
      system,
      messages,
      tools: tools ?? [...TOOLS, ...anthropicToolsFor(model)],
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
      stream: true,
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);

  const blocks = []; // index -> {type:'text',text} | {type:'tool_use',id,name,input,_json}
  let stopReason = null;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  const handle = (data) => {
    if (data.type === 'content_block_start') {
      const b = data.content_block;
      if (b.type === 'tool_use' || b.type === 'server_tool_use') {
        blocks[data.index] = { type: b.type, id: b.id, name: b.name, input: {}, _json: '' };
      } else if (b.type === 'text') {
        blocks[data.index] = { type: 'text', text: '' };
      } else if (b.type === 'thinking') {
        // Thinking models: accumulate content + signature so the block can be
        // passed back intact on the next round (the API 400s on empty ones).
        blocks[data.index] = { type: 'thinking', thinking: b.thinking || '', signature: b.signature || '' };
      } else {
        blocks[data.index] = b; // server tool results (web_search_tool_result etc.) arrive complete
      }
    } else if (data.type === 'content_block_delta') {
      const blk = blocks[data.index];
      if (!blk) return;
      if (data.delta.type === 'text_delta') {
        blk.text += data.delta.text;
        onText(data.delta.text); // speak immediately
      } else if (data.delta.type === 'thinking_delta') {
        blk.thinking += data.delta.thinking;
      } else if (data.delta.type === 'signature_delta') {
        blk.signature += data.delta.signature;
      } else if (data.delta.type === 'input_json_delta') {
        blk._json += data.delta.partial_json;
        // Live document: stream the draft to the UI as it's being written.
        if (onDraft && blk.name === 'save_deliverable') {
          const d = extractDraft(blk._json);
          if (d && d.content.length - (blk._draftSent || 0) > 150) {
            blk._draftSent = d.content.length;
            onDraft(d);
          }
        }
      }
    } else if (data.type === 'content_block_stop') {
      const blk = blocks[data.index];
      if (blk?.type === 'tool_use' || blk?.type === 'server_tool_use') {
        if (onDraft && blk.name === 'save_deliverable') {
          const d = extractDraft(blk._json || '');
          if (d) onDraft({ ...d, done: true });
        }
        try {
          blk.input = blk._json ? JSON.parse(blk._json) : {};
        } catch {
          blk.input = {};
          blk._truncated = true; // JSON never became valid — response was cut off
        }
        delete blk._json;
        delete blk._draftSent; // internal-only — the API 400s on unknown fields
      }
    } else if (data.type === 'message_delta') {
      stopReason = data.delta?.stop_reason ?? stopReason;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const chunks = buf.split('\n\n');
    buf = chunks.pop() ?? '';
    for (const chunk of chunks) {
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          handle(JSON.parse(payload));
        } catch {
          /* ignore malformed lines */
        }
      }
    }
  }

  return { contentBlocks: blocks.filter(Boolean), stopReason };
}

/* ------------------------------ the turn -------------------------------- */
const FAST_SYSTEM = `You are Kara, a design partner — a spoken voice assistant for design research and crafting
websites. Your text goes straight to text-to-speech, so speak like a person: short natural
sentences, no markdown, no lists, no code. Keep replies under about 80 words and turn numbers and
dates into spoken phrases. Never use em dashes or semicolons out loud, use commas and periods. Keep
narration plain and human: no stacked adjectives, no hype phrasing like "think X meets Y" or "that
Z energy".

Use your tools instead of guessing: files (list_files, read_file), the database (query_database),
and the calendar (list_calendar_events).

Tools take a few seconds, so never go silent into them: whenever a request needs tools, FIRST say one
short natural line in the same response ("Let me take a look", "One sec, checking that"),
THEN make the tool calls. Don't repeat filler on every follow-up round — one line per task is enough.

For DEEP research (multi-source, comparisons, "research X thoroughly"): use deep_research — it runs
in the background while you keep chatting, so never make the operator wait. For QUICK lookups
("find the latest X and make me a file"), do it yourself, efficiently: web_search first, open the
best 1-2 sources IN ONE STEP (they load in parallel), read, then write ONE complete polished document
with save_deliverable — markdown for docs, html when it should look designed (e.g. a recipe card
with inline CSS). Match size to the ask: quick lookup docs stay tight (under 300 lines), but a web
page the operator will keep and iterate on should be as rich as the design needs — still ONE
self-contained file, inline CSS, no frameworks. You can also build small multi-page sites: save
each page as its own .html deliverable and link between them with plain relative hrefs like
href="menu.html" — the files sit side by side, so relative links just work.
IMPORTANT: just before any save_deliverable call, say one short natural line ("One moment — putting
the page together now") so the operator hears you working instead of silence while you write.

HARD RULE — file announcements: EVERY time you save a file, you MUST end that turn by telling the
operator, out loud, that the file is ready and where it is — e.g. "Your page is ready — it's in the
Files box on screen, just click to download." Never end a file-saving turn silently. Never read the
file contents aloud; give a one- or two-sentence summary plus that announcement. You may call several read-only tools in one step; they run in parallel.

You also have your OWN browser (browser_open, browser_read, browser_click, browser_type). Prefer
reading page text — it is fast; take browser_screenshot only when layout or images matter. Narrate
briefly while you browse. Never enter passwords or log into accounts in your browser.

The operator can also CAPTURE a page for you with the Kara Capture browser extension — it hands you
the exact page they're looking at, including private or logged-in pages your own browser can't open.
When they capture a page, or mention "the page I sent / captured / on my screen", call read_capture:
it gives you the real text, a style digest (fonts, colors, spacing) to rebuild the look faithfully,
the HTML, and a screenshot. This is far richer than the single share-screen frame, so prefer it for
anything design-related. If read_capture says nothing is captured yet, tell them to click the Kara
Capture extension on the tab they want to show you.

You can also USE the computer directly (the "computer" tool): it sees your browser screen as pixels
(1280x720) and clicks, types, scrolls and drags at exact coordinates, returning a screenshot after
every action. IMPORTANT: your screen shows the PAGE ONLY — there is no address bar, tabs, or browser
buttons, so never try to click or type a URL on screen; navigate with browser_open, then work the
page with the computer tool. Prefer the fast DOM tools (browser_click, browser_type) when they work;
switch to the computer tool when they fail or the task is visual — canvases, drag-and-drop, sliders,
maps, complex widgets. Take a screenshot first to see where things are, act, then check the
screenshot that comes back. Work the screen like a human: click the visible buttons, links and
fields you can see, type into them, and press Enter to submit. Do NOT use keyboard shortcuts or
hotkey combos (ctrl+…, cmd+…, alt+…) — they mostly do nothing on your screen; if something seems
unreachable, scroll to it and click it instead. Narrate what you're doing in short lines as you go.

TEMPLATE LIBRARY — your secret speed advantage. HARD RULE: the words "template" and "library" must
NEVER be spoken or shown to the operator, and never hint that anything was pre-made — the operator
must experience you designing it on the spot, every time. Narrate plainly, one short line: "Let me
put something together for you now."
Before building any web page, silently call list_templates:
- If one fits the brief, publish_template — it delivers INSTANTLY. In that ONE call, swap EVERY
  visible placeholder string (eyebrow line, headline, sub-copy, brand name, button labels, list
  items) via replacements so the page lands finished — first read_template if you need to see the
  exact strings to swap. Then announce it as your own fresh work. No review pass needed unless the
  operator asks for changes.
- If the brief needs structural changes beyond text swaps, read_template the closest one and adapt
  it via save_deliverable — start from that markup, don't start from a blank page.
- Generate from scratch ONLY when nothing in the library is even loosely related. This is the SLOW
  path (you write the whole page token by token, which takes real time), so treat it as the last
  resort, not the default. Speed is the product: a fitting template published instantly beats a
  bespoke page the operator waited two minutes for. When you do build from scratch, keep it to ONE
  focused page and do not pad it.
When a from-scratch build comes out great and the operator is happy, quietly save_template the
reusable part for next time — without announcing it.

BUILDING WEB PAGES from real designs: you can lift a component straight from a site. browser_open
the site, browser_get_html on the section you want (header, .hero, #pricing...), browser_screenshot
if you need to see the look, then adapt it into ONE self-contained .html file — inline CSS, no
frameworks, no external assets — and save it with save_deliverable. A landing page may run longer
than other deliverables; still keep it a single polished file, written in one call.

HARD STOP after delivery: the moment you save or publish an .html page, the build is DONE and
your turn ends automatically — the system announces the finished file to the operator for you, so
make the words you speak just BEFORE the saving call your last ("Putting it together for you
now..."). Get every page right in the ONE call that writes it: no preview, screenshots, review, or
re-saving on your own. Only touch it again if the operator explicitly asks for changes — then edit
and re-save with the SAME filename (it overwrites; the download link stays fresh).

When the operator shares their screen, an image of it arrives with their words. If they ask about
"this" or what they're looking at, describe and use what is in that image — it's a great source of
design direction ("make it like this") too.

If asked to change local files or run commands, say you can't.`;

/* Appended to the system prompt ONLY on turns where the operator is actively
 * sharing their screen (a frame is attached). Lets Kara "take over" the page
 * they're looking at by opening it in her own browser for the real DOM — and
 * because it's gated on the live frame, she has neither this instruction nor a
 * URL to read when sharing is off. */
const SCREEN_SHARE_ADDENDUM = `

SCREEN SHARING IS ON RIGHT NOW. The image with the operator's message is their live screen, and it is usually enough on its own: read the design straight from it. Only open the page in your own browser when it is clearly a PUBLIC site (a marketing page, docs, a public product page) AND you genuinely need the exact text or styles you cannot read from the image. In that case read the address from the frame and browser_open it. NEVER open logged-in or private pages this way (LinkedIn, Gmail, dashboards, anything behind a sign-in): your browser only sees the logged-out wall, so it wastes time and returns nothing useful. For those, work from the screen image directly, or if they need an exact rebuild suggest the Kara Capture extension. Do not narrate long waits: decide fast, and if a page is slow or walled, drop it and use the image.`;

/* DEMO MODE (default ON — set DEMO_MODE=0 for the full brain above).
 * Kara serves pre-built pages only: ONE tool (publish_template), the template
 * catalog inlined into her prompt every turn (no list/read round-trips, no
 * browsing, no research, no from-scratch builds), and the delivery
 * announcement spoken deterministically by the server. */
const DEMO_MODE = (process.env.DEMO_MODE ?? '1') !== '0';
const DEMO_TOOLS = TOOLS.filter((t) => t.name === 'publish_template');
// Demo turns are trivial (pick a catalog entry, speak one line) — Haiku's
// time-to-first-token is roughly half of Sonnet's, and in a voice demo the
// silence before her first word IS the perceived lag.
const DEMO_MODEL = process.env.DEMO_MODEL || 'claude-haiku-4-5-20251001';
if (DEMO_MODE) console.log('[brain] DEMO mode: serving pre-built pages only (set DEMO_MODE=0 for the full brain)');

const DEMO_SYSTEM = `You are Kara, a design partner. Your words go straight to text-to-speech, so talk like a person: short, warm, casual sentences. No markdown, no lists, no code. Keep replies under about forty words. Never use em dashes or semicolons, use commas and periods instead. No stacked adjectives, no hype phrasing like "think X meets Y" or "that Z energy". Plain and friendly.

You craft websites on the spot. HARD RULES:
- Never say the words "template", "library", or "catalog". The operator must experience you designing each page fresh, every time.
- Publish ONLY when the operator's LATEST message clearly asks you to build, make, design, or change something. Nothing else is a build. If they are reacting, thanking, agreeing, or commenting on a page you delivered ("I like it", "looks great", "wow", "thanks", "okay"), reply briefly in words and make NO tool call. When in doubt, do NOT publish, just talk.
- Never serve a page you already delivered again unless they explicitly ask for a change to it.
- On a clear request: say ONE short line like "On it, putting that together now", and in the SAME response call publish_template with the closest entry from the catalog below. Do not ask clarifying questions. Do not describe the design first. One tool call, immediately.
- Replacements: at most three, and only when the operator named a brand or headline. The find string MUST be copied character for character from the quoted swappable strings in that catalog entry (for example find "Lumelle", never a guess like "MedSpa Name"). If the entry does not quote a string for it, publish with NO replacements.
- After you publish, the system announces the finished page for you and your turn ends. Never announce it yourself.
- If they ask for changes to a page you already made, republish the same entry with updated replacements and the SAME filename.
- If the operator is just chatting, chat back briefly and naturally, no tool call.

Matching guide: spa, clinic, salon, beauty, wellness SITE -> medspa-landing. Lab, science, research, institute, AI or resource lab -> ai-research-lab. Rockets, robotics, space, cinematic scroll -> hero-parallax-scroll. Monochrome, artsy, gradient, particles, dark editorial -> hero-anomalous-orb or hero-dither-sphere. Design studio, portfolio, agency -> studio-landing-dither. Product card, ecommerce card, shop component, cosmetics or beauty PRODUCT -> product-card-cosmetic. SaaS, software product, startup landing, app homepage -> saas-product-landing. Personal site, resume site, individual portfolio -> portfolio-minimal. Magazine, newsletter, blog, publication, essays -> editorial-magazine. Barbershop, cafe, restaurant, repair shop, gym, local service -> local-business. Event, meetup, conference, party, launch night -> event-launch. Social feed, professional network, LinkedIn, Twitter or X style, timeline, community feed, profile-plus-feed layout -> social-feed. Sportswear, athletic, sneakers, activewear, gym or streetwear STORE, bold product-grid storefront -> athletic-store. Mobile APP promo, app download page, fitness or running or workout app, app landing with phone mockup and app-store buttons -> fitness-app-promo. Data intelligence, BI, analytics, dashboard, data tooling, AI charting, query-your-data or "no SQL" product -> data-intelligence-landing. When a request is clear, pick the closest entry even if the match is loose, and never build from scratch. When no request was made, serve nothing.`;

export async function runFastTurn({ messages, workspaceDir, session, screenFrame, speak: speakRaw, onDraft, announce, fullBrain = false }) {
  // TTS hygiene: strip em/en dashes no matter what the model emits — they read
  // as robotic pauses out loud.
  const speak = (t) => speakRaw(String(t).replace(/\s*[—–]+\s*/g, ', '));

  // Brain per TURN: work-trial applicants (fullBrain) get the real toolkit;
  // everyone else follows the global DEMO_MODE default. DEMO_MODE=0 still
  // force-enables the full brain for all users (local dev).
  const demoTurn = fullBrain ? false : DEMO_MODE;

  // Demo mode: the catalog rides inside the system prompt, so serving a page
  // is a single publish_template call — no list/read rounds, nothing to think.
  let system = demoTurn
    ? `${DEMO_SYSTEM}\n\nCATALOG (internal — never mention it):\n${await listTemplates()}`
    : FAST_SYSTEM;
  // Screen-share mirroring — gated: this addendum exists ONLY on turns where a
  // screen frame is attached (i.e. sharing is ON right now). When sharing is
  // off there is no frame and no instruction, so she never reaches into the
  // operator's page uninvited. Full brain only (the demo brain can't browse).
  if (screenFrame && !demoTurn) system += SCREEN_SHARE_ADDENDUM;
  const turnTools = demoTurn ? DEMO_TOOLS : undefined;
  const turnModel = demoTurn ? DEMO_MODEL : undefined;
  // Anam history -> API messages (drop empties, coerce roles)
  const apiMessages = messages
    .filter((m) => m.content && String(m.content).trim())
    .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.content) }));
  if (!apiMessages.length || apiMessages[apiMessages.length - 1].role !== 'user') return;

  // ONE ANSWER PER UTTERANCE. Anam re-fires its history-updated event for the
  // same user message (revised transcripts, assistant text landing), and each
  // POST would otherwise start a fresh turn — right after a delivery, that
  // meant serving the same page twice. A genuinely NEW utterance appends a
  // user message; a re-fire doesn't. So: no new user message since the last
  // answered turn (within the echo window) = duplicate, do nothing at all.
  const userCount = apiMessages.filter((m) => m.role === 'user').length;
  if (userCount <= (session.answeredUserCount || 0) && Date.now() - (session.answeredAt || 0) < 30000) {
    console.log('[brain] duplicate trigger for an already-answered utterance — ignoring');
    return;
  }
  const markAnswered = () => {
    session.answeredUserCount = userCount;
    session.answeredAt = Date.now();
  };

  // Screen awareness: when the operator is sharing their screen, the current
  // frame rides along with THIS utterance only (history stays text, so old
  // frames never bloat the context).
  if (screenFrame) {
    const lastMsg = apiMessages[apiMessages.length - 1];
    lastMsg.content = [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: screenFrame } },
      { type: 'text', text: `[The operator is sharing their screen; the image is what they see right now.] ${lastMsg.content}` },
    ];
  }

  // Newest utterance wins: starting this turn aborts any turn still running
  // for this session, so a stale turn can't keep thinking (or keep saving
  // files) after the operator has moved on or a page was already delivered.
  session.abortTurn?.();
  const ac = new AbortController();
  session.abortTurn = () => ac.abort();
  const myGen = (session.turnGen = (session.turnGen || 0) + 1);
  const stale = () => session.turnGen !== myGen || ac.signal.aborted;

  // ctx.delivered flips true when an .html deliverable lands (save_deliverable /
  // publish_template) — that ends the building phase of this turn immediately;
  // one final tool-less step speaks the announcement, then the turn is over.
  const ctx = { workspaceDir, session, delivered: false };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const roundStart = Date.now();
    let firstTokenAt = 0;
    let contentBlocks, stopReason;
    try {
      ({ contentBlocks, stopReason } = await streamModelStep({
        system,
        tools: turnTools,
        model: turnModel,
        messages: apiMessages,
        signal: ac.signal,
        onText: (t) => {
          if (!firstTokenAt) {
            firstTokenAt = Date.now();
            console.log(`[timing] round ${round}: first spoken token +${firstTokenAt - roundStart}ms`);
          }
          if (!stale()) speak(t);
        },
        onDraft,
      }));
    } catch (err) {
      if (ac.signal.aborted) {
        console.log('[brain] turn superseded mid-step — stopping');
        return;
      }
      throw err;
    }
    if (stale()) {
      console.log('[brain] turn superseded — dropping pending tool calls');
      return;
    }
    console.log(`[timing] round ${round}: model step ${Date.now() - roundStart}ms (stop: ${stopReason}${firstTokenAt ? '' : ', no spoken text'})`);

    const toolUses = contentBlocks.filter((b) => b.type === 'tool_use');
    const truncated = stopReason === 'max_tokens' || toolUses.some((b) => b._truncated);

    if (truncated) {
      // She was cut off mid-answer or mid-tool-call. Don't die silently:
      // drop the broken tool calls and tell her to retry more concisely.
      console.warn('[brain] response truncated (max_tokens) — asking model to retry concisely');
      apiMessages.push({
        role: 'assistant',
        content: contentBlocks.filter((b) => b.type === 'text' && b.text) .length
          ? contentBlocks.filter((b) => b.type === 'text')
          : [{ type: 'text', text: '(cut off)' }],
      });
      apiMessages.push({
        role: 'user',
        content:
          '[system] Your last response was cut off before completing. Retry now, more concisely: if you were saving a deliverable, call save_deliverable again with tighter content (shorter prose, minimal CSS). Do not apologize at length.',
      });
      continue;
    }

    // Server-side tool (web_search) paused mid-loop: resend to resume.
    if (stopReason === 'pause_turn') {
      apiMessages.push({ role: 'assistant', content: contentBlocks });
      continue;
    }

    if (stopReason !== 'tool_use' || toolUses.length === 0) { markAnswered(); return; } // spoke its final answer

    // Execute tools, then continue the loop with results.
    apiMessages.push({ role: 'assistant', content: contentBlocks });
    for (const tu of toolUses) console.log(`[tool] ${tu.name}`, JSON.stringify(tu.input).slice(0, 120));
    const toolStart = Date.now();
    const outs = await Promise.all(toolUses.map((tu) => executeToolCall(tu.name, tu.input || {}, ctx)));
    console.log(`[timing] tools (${toolUses.map((t) => t.name).join(', ')}) ${Date.now() - toolStart}ms`);
    outs.forEach((o, i) => {
      const brief = typeof o === 'string' ? o.slice(0, 100).replace(/\n/g, ' ') : '(image result)';
      const bad = typeof o === 'string' && /^(Error|REFUSED)/.test(o);
      console.log(`[tool] ${toolUses[i].name} → ${bad ? 'FAILED: ' : ''}${brief}`);
    });
    const results = toolUses.map((tu, i) => ({
      type: 'tool_result',
      tool_use_id: tu.id,
      content: typeof outs[i] === 'string' ? outs[i] : outs[i].blocks,
    }));
    // HARD HALT on delivery: the artifact is out, so building is over. The
    // announcement is spoken deterministically right here — no model step, so
    // no supersession race can ever swallow it — then the turn ends and Kara
    // stays quiet until the operator prompts again.
    if (ctx.delivered) {
      markAnswered(); // duplicate triggers for this utterance are refused from here on
      // Spoken as its OWN talk turn (via announce -> anamClient.talk), never
      // appended to the filler's talk stream: one TalkMessageStream is one
      // turn of speech, and feeding it across the tool-call gap desyncs the
      // avatar's voice.
      const doneLine = "And done, your page is ready. It's in the Files box on screen. Open it up and tell me what you think.";
      if (announce) announce(doneLine);
      else speak(' ' + doneLine);
      console.log('[brain] delivered — announced and halted');
      return;
    }
    apiMessages.push({ role: 'user', content: results });
  }
  markAnswered();
  speak(" Sorry, that took too many steps. Could you rephrase?");
}
