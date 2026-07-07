# Cara — Goblin Labs Operator

A real-time voice operator: an Anam avatar with a Claude brain that reads the
workspace, database, and calendar, and drives Zendesk by voice behind a spoken
confirmation gate.

**Onboarding & multi-user:** each operator connects their *own* Zendesk
(subdomain, email, API token) in the browser; credentials are verified live
against `/users/me`, held in server memory keyed by a per-session conversation
id, never written to disk, and expire with the session. The confirmation gate
is keyed the same way, so one operator's "confirm" can never fire another's
staged change (tested). "Skip — demo tickets" runs against the built-in mocks.

A real-time [Anam](https://anam.ai) avatar whose "brain" is the
[Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview) —
the same agent loop, file tools, and context management that power Claude Code.
The avatar answers from read-only sources — a workspace folder (files), a SQLite
database (customers/orders), and a calendar (events) — and can also **write to
Zendesk** (change a ticket's status, post a public reply), but only behind a
spoken confirmation gate: it stages the change, reads it back, and sends it to
Zendesk only after you say "confirm" out loud. Files, the database, and shell
stay read-only.

## How it maps to the architecture

```
Browser (public/)              Backend (server.js)                Agent SDK
─────────────────              ───────────────────                ─────────
Anam SDK renders the      →    POST /api/session-token       →    (mints token,
avatar, does speech-to-        disables Anam's brain               brain = us)
text and turn-taking           (llmId CUSTOMER_CLIENT_V1)

User speaks →                  POST /api/chat-stream         →    query({ prompt,
MESSAGE_HISTORY_UPDATED   →    runs the agent loop,               options }) reads
fires with the history         streams assistant text             workspace files
                                                                   with Read/Glob/Grep
createTalkMessageStream() ←    newline-delimited {content}   ←    assistant text
speaks each chunk              chunks                             blocks stream out
```

Three seams, all in `server.js`:

1. **`/api/session-token`** — mints an Anam token with `llmId: 'CUSTOMER_CLIENT_V1'`,
   which turns Anam's built-in brain off and makes us responsible for replies.
2. **Read-only guard** — `allowedTools` auto-approves `Read`, `Glob`, `Grep`;
   `canUseTool` hard-denies everything else, so a spoken sentence can never
   trigger a write or a shell command.
3. **`/api/chat-stream`** — runs `query()` and forwards each assistant **text**
   block as a `{content}` chunk. Tool-use blocks stay silent, which naturally
   gives you "let me check…" followed by the answer.

## Custom tools — answering from beyond files

The avatar reaches non-file data through **in-process MCP tools** (`mcp-tools.js`),
which run inside this same Node process — no separate server to host. Two are wired up:

- **`query_database`** — runs a read-only SQL `SELECT` against a seeded SQLite
  database (`data/app.db`: `customers` + `orders`). The connection is opened
  `readonly: true` and the handler rejects anything but a single `SELECT`/`WITH`,
  so a spoken sentence can't mutate data even if the model tried.
- **`list_calendar_events`** — returns events in a date range. It reads an
  in-memory list generated relative to today so the demo is always "live."

Both are defined with `tool(name, description, zodShape, handler)`, bundled with
`createSdkMcpServer({ name: 'data', ... })`, and registered in `server.js` via
`mcpServers: { data: dataServer }`. The agent sees them as
`mcp__data__query_database` and `mcp__data__list_calendar_events` — those exact
names are in `allowedTools` **and** the read-only guard's allow-set, which is what
lets them run without a permission prompt.

The data access lives in `data-store.js` with **no SDK import**, so it's plain,
testable code. Swapping in real systems is a one-file change:

- **Real database** — point `data-store.js` at Postgres/MySQL (e.g. `pg`) instead
  of SQLite; keep the SELECT-only guard.
- **Real calendar** — replace `listCalendarEvents` with a Google Calendar call
  (`googleapis` → `calendar.events.list`) returning the same `{title, start, end,
  location}` shape. That adds OAuth setup, which is why the scaffold ships with a
  local stand-in.


## Write tier — Zendesk behind a spoken confirmation gate

The avatar can change Zendesk tickets, but never in a single step. The write is
split into two tools so a spoken word can't fire a mutation by accident:

- **`stage_ticket_update`** (auto-approved, no external effect) — records the
  intended `{ status, comment }` for a ticket and returns a summary to read back.
- **`commit_ticket_update`** (the actual `PUT` to Zendesk) — deliberately **left
  out of `allowedTools`**, so every call routes through `canUseTool`, which allows
  it *only* when something is staged **and** the latest user utterance matched the
  confirmation phrase (`server.js`, `CONFIRM_RE`). This is a code gate, not a
  prompt the model could talk its way past.

So the demo flow is two turns:

1. "Solve ticket 4302 and reply that it's fixed." → the agent reads the ticket,
   stages the change, and says "I'll mark #4302 solved and post '…'. Say confirm
   and I'll send it." A **pending** banner appears. Nothing has been written.
2. "Confirm." → the gate opens, `commit_ticket_update` runs the Zendesk `PUT`, and
   the banner turns to **sent**. Saying "cancel" instead clears the staged change.

The pending/sent banner is driven by `{control}` lines the backend interleaves
with the spoken `{content}` chunks; the browser renders control lines instead of
speaking them.

### Live vs mock

`zendesk.js` runs in **mock** mode (in-memory tickets) unless you set
`ZENDESK_SUBDOMAIN`, `ZENDESK_EMAIL`, and `ZENDESK_API_TOKEN` — then it hits the
real API with Basic auth (`{email}/token:{api_token}`). Mock mode means you can
rehearse and film the whole demo offline; flip to live by adding the three env
vars. **Use a Zendesk sandbox for the demo** — the avatar is genuinely writing.

## Setup

Requires **Node.js 18+**. The Agent SDK bundles its Claude Code runtime, so
there's nothing else to install.

```bash
npm install
cp .env.example .env      # then paste your two API keys
npm start                 # → http://localhost:8000
```

Get keys: Anam at https://anam.ai/api-key · Anthropic at https://console.anthropic.com

Open the page, click **Start conversation**, and try:

- "Summarize the README out loud." (workspace files)
- "How many orders shipped, and what's the total?" (database)
- "What's on my calendar this week?" (calendar)
- "What tickets are open?" → "Solve ticket 4302 and reply that it's fixed." →
  "Confirm." (the two-turn Zendesk write — watch the banner go pending → sent)
- "Edit the README for me." (it should refuse — files stay read-only)

The sample `workspace/` folder is there so the demo works immediately. Point
`WORKSPACE_DIR` at any real folder to use your own.

## Test the brain first (no avatar, no microphone)

Before wiring up Anam, prove the agent + tools + gate work with just your
Anthropic key:

```bash
npm run test:brain
```

It spawns the server on its own port and plays four spoken turns through the real
`/api/chat-stream` endpoint — read a ticket list, stage a write, a non-confirming
turn (the gate must hold), then "confirm." It prints what Cara says and the banner
state after each, and PASS/FAIL for each expectation. Runs against mock Zendesk
unless `ZENDESK_*` is set, so it needs only `ANTHROPIC_API_KEY`. The model isn't
perfectly deterministic; if a check flukes, re-run once. This isolates the brain,
so if the avatar later won't talk you already know the agent side is good.

## The one gotcha to expect: latency

Anam is built for ~180 ms conversational latency; an agent that reads files
takes seconds. This scaffold handles it by streaming the agent's prose as it
reasons — so the avatar talks through the pause instead of freezing. Keep the
system prompt nudging short, spoken replies (it's in `server.js`).

## Upgrade path (in rough order)

- **Harden the gate for production.** The confirmation is matched on the latest
  utterance with a regex; for higher stakes, add a spoken read-back of a code word
  the agent generates, require the ticket id in the confirmation, and log every
  commit. Keep `commit_ticket_update` out of `allowedTools` so it always routes
  through `canUseTool`.
- **Per-conversation sessions.** `agentSessionId` and the gate state in `gate.js`
  are single-user. Send a `conversationId` from the client and key both by it so
  multiple users don't share a staged action.
- **More write actions.** Reuse the stage → confirm → commit pattern for other
  systems (refunds, calendar edits). Each mutating tool stays out of `allowedTools`
  and gets its own gate branch in `canUseTool`.
- **Smoother speech.** Enable partial-message streaming for token-level chunks
  instead of per-block, if the per-block cadence feels chunky.

## Notes on versions

Both SDKs move fast. This was built against Anam's client-side custom-LLM
pattern (`createTalkMessageStream` / `streamMessageChunk`) and
`@anthropic-ai/claude-agent-sdk` ~0.3.x (`query()` async generator, `tool()` +
`createSdkMcpServer()` for in-process tools, Zod schemas). The custom tools also
pull in `better-sqlite3` (the seeded demo DB) and `zod`. The `model: 'sonnet'`
alias avoids pinning a model version that could go stale. The Zendesk client uses
the stable v2 Ticketing API (`PUT /tickets/{id}.json` with a `comment` object). If
an import breaks, check each SDK's changelog first.
