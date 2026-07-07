# Kara 3 — Voice-Driven Design Partner

A real-time voice demo: an [Anam](https://anam.ai) avatar with a Claude brain
that designs websites on request. Ask her for a landing page out loud and a
finished, polished page lands in her Files box seconds later. The front-end is
a cinematic living portrait — a seamless video loop of Kara under a volumetric
light beam — with her live avatar taking the stage when you start talking.

## What she does

Speak a brief ("build me a website for a medspa called Velle, light and airy,
with a treatment menu and booking") and Kara:

1. matches it to the closest page in her template catalog,
2. publishes it instantly with your brand name and copy swapped in,
3. announces it, and the file appears in the floating **Files** box —
   downloadable, self-contained HTML.

She presents every page as designed on the spot; the catalog is her
backstage secret.

## Architecture

```
Browser (public/)               Backend (server.js)             Brain (fast-brain.js)
─────────────────               ───────────────────             ─────────────────────
Anam SDK renders the avatar, →  POST /api/session-token      →  (mints token with
does speech-to-text and         disables Anam's built-in         llmId CUSTOMER_CLIENT_V1,
turn-taking                     brain — the brain is us          so replies come from us)

User speaks →                →  POST /api/chat-stream        →  direct Anthropic Messages
MESSAGE_HISTORY_UPDATED         streams {content} chunks        API tool loop (no
fires with full history         + {control} lines               subprocess), streaming
                                                                from the first token
createTalkMessageStream()   ←   spoken text                 ←   filler line + one
speaks chunks; control.announce                                 publish_template call
arrives as its own talk() turn
```

Two brains, switched by env:

- **Demo mode** (`DEMO_MODE=1`, the default) — template serving only. One tool
  (`publish_template`), the catalog inlined into the system prompt (no
  list/read round-trips), Haiku for a ~0.5 s first spoken token. She cannot
  browse, research, or build from scratch — by construction, not by prompt.
- **Full brain** (`DEMO_MODE=0`) — Sonnet with the whole toolkit: her own
  Playwright browser, computer use, server-side web search, a background
  deep-research agent, from-scratch page authoring, and the template library
  she can grow herself (`save_template`).

## Reliability guards (learned the hard way)

Voice UIs re-fire events and models improvise; the demo loop is hardened in
code, not just prompted:

- **One answer per utterance** — Anam re-fires history updates for the same
  user message (revised transcripts, assistant text landing). A turn is only
  accepted if the history contains *more* user messages than the last answered
  turn (30 s echo window).
- **Newest utterance wins** — a new request aborts any in-flight turn
  (`AbortController` per session), so a stale turn can't keep building or
  saving after you've moved on.
- **Delivery ends the turn** — the moment a page is published, the turn halts;
  the announcement ("And done, your page is ready…") is spoken deterministically
  by the server, shipped as a `control.announce` line that the client voices as
  its own `talk()` turn (feeding one TalkMessageStream across the tool-call gap
  desyncs the avatar's voice).
- **No unrequested serves** — re-publishing the same template with the same
  swaps within 2 minutes is refused at the tool level, so a reaction like
  "I love it" can never trigger a second delivery.
- **Transcripts** — every exchange is appended to `transcripts/<conversation>.log`
  (gitignored) for post-demo review.

## Front-end

- **Living portrait hero** — `public/kara-beam-loop.mp4`, a palindrome-baked
  seamless loop (locked camera; only the light and dust move, plus her blinks).
  Press **Start conversation** and it cross-fades into her live avatar.
- **Companion Mode** — a document picture-in-picture window carrying her live
  video *and* the file list, floating above every app.
- **Share screen** — one JPEG frame of your screen rides along with each
  utterance, so she can react to what you see.
- **Files box** — inline-dropdown-styled card on an iridescent foil surface
  (both vanilla ports): header with close button, smooth contained scrolling,
  staggered row entrances, auto-scroll to the newest artifact. Mirrored live
  into the Companion window.

## Template library

`templates/*.html` — self-contained single-file pages (styles, scripts, and
media inlined; the research-lab template embeds its hero video as base64).
Each starts with a `<!-- desc: ... -->` line: what it is, a hard rule to
deliver via `publish_template` only, and the exact swappable strings
(brand, headline, prices) quoted so the model copies them character for
character. Drop a new file in and it's servable immediately — the catalog is
read fresh every turn.

Ships with seven: three hero pages (particle orb, dithered sphere, SpaceX-style
parallax), two full sites (design studio, medspa), a dark research-lab site
with a cinematic video hero, and an interactive cosmetics product card.

## Setup

Requires **Node.js 18+**.

```bash
npm install               # postinstall pulls Chromium for the full brain's browser
cp .env.example .env      # paste your two API keys
npm start                 # → http://localhost:8000
```

Get keys: Anam at https://anam.ai/api-key · Anthropic at https://console.anthropic.com

Open the page, press **Start conversation**, allow the mic, and try one breath
per request, brand name included:

- "Build me a landing page for a deep tech startup called Helion, dark cosmic
  feel with particles."
- "Build me a complete website for a medspa called Velle Aesthetics, light and
  airy, with a treatment menu and client reviews."
- "Make me a product card for a beauty brand, a face serum, with a photo
  carousel and add to cart."
- Then: "Change the headline to 'Beyond orbit'" — she republishes the same
  file with the swap.

Reactions ("wow", "I love it") get conversation, never a re-serve.

## Extra brain surface (full mode)

`mcp-tools.js` + `data-store.js` wire in-process MCP tools: a read-only SQL
`SELECT` over a seeded SQLite DB (`data/app.db`) and a relative-to-today
calendar. `research.js` runs a background deep-research agent that announces
its finished brief through the server-sent-events push channel. Zendesk write
tools exist in the repo (`zendesk.js`, `ticket-tools.js`, `gate.js`) but are
**unwired** — the old spoken-confirmation ticket demo they belonged to has
been retired from this build.

## Latency notes

Anam targets ~180 ms conversational latency; a model turn takes seconds. The
demo brain closes the gap three ways: Haiku (halves time-to-first-token), the
catalog-in-prompt design (a serve is exactly one tool call), and a canned
server-side announcement (zero model time after delivery). Measured: first
spoken token ~0.5–0.8 s, page delivered ~1.5 s. What remains is Anam's own
speech-endpoint detection and voice startup.

## Notes on versions

Built against Anam's client-side custom-LLM pattern
(`createTalkMessageStream` / `streamMessageChunk` / `talk`) and the Anthropic
Messages API directly (streaming, tool use, `tool_choice`). The Claude Agent
SDK path (`BRAIN=agent`) is still present in `server.js` but the fast brain is
the default and the one the demo hardening applies to. If an import breaks,
check each SDK's changelog first.
