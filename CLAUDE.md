# Kara 3 — working notes for Claude

Voice-driven design partner demo: Anam avatar + Claude brain that serves
pre-built template pages on spoken request. Live at
https://drbinna--kara-3-kara.modal.run (Modal, single always-warm container).

## Layout

- `server.js` — entry point (root; Modal runs `node server.js`)
- `src/` — active core: `fast-brain.js` (both brains + tools), `research.js`,
  `browser-tools.js`, `data-store.js`, `deliverables.js`, `mcp-tools.js`, `sessions.js`
- `legacy/` — retired Zendesk-era code; nothing imports it, don't wire it back without asking
- `templates/` — the servable page catalog (see rules below)
- `public/` — static front-end (no framework, vanilla JS)
- `deliverables/`, `transcripts/` — runtime output, gitignored

## Run & verify

```bash
npm start                      # → http://localhost:8000
lsof -ti:8000 | xargs ps -o pid,etime  # ALWAYS check for zombie servers first —
                               # stale processes have survived restarts repeatedly
                               # and served old code, invalidating tests
curl -s -N -X POST localhost:8000/api/chat-stream -H 'Content-Type: application/json' \
  -d '{"conversationId":"t1","messages":[{"role":"user","content":"Build me a website for a medspa called Glow"}]}'
# expect: {"content":...} filler → {"control":{"announce":...}} → {"control":{"deliverable":...}}
# clean up: rm -rf deliverables/t1 transcripts/t1.log
```

## Invariants — do not break these

The demo loop is hardened in code against failure modes we hit in real
rehearsals. Before touching `runFastTurn` or `publish_template`, understand:

1. **One answer per utterance** (`markAnswered` / `answeredUserCount`): Anam
   re-fires history events for the same utterance with revised transcript text
   — dedupe by user-message COUNT, never by text equality.
2. **Newest utterance wins** (`session.abortTurn` / `turnGen`): a new request
   aborts in-flight turns mid-stream. Duplicate guard must run BEFORE the
   abort, or an echo can kill a legitimate turn.
3. **Delivery halts the turn**: after a publish, the canned announcement is
   spoken server-side (zero model calls) and shipped as `control.announce` —
   the client voices it via `anamClient.talk()` as its OWN turn. Never feed it
   into the open TalkMessageStream: one stream = one speech turn, and a gap
   mid-stream desyncs the avatar's voice/lips.
4. **No unrequested serves**: same template + same replacements within 120 s is
   refused at the tool level (`session.lastPublish`). Changed replacements pass
   (that's a legit copy-change request).
5. **Replacement values are HTML-escaped** in `publish_template` — hosted-XSS
   guard, since `/api/chat-stream` is public. Never remove.
6. **Demo mode** (`DEMO_MODE=1`, default): ONE tool (publish_template), catalog
   inlined in the system prompt, Haiku (`DEMO_MODEL`). Speed target: first
   spoken token ≤0.8 s. Full brain (`DEMO_MODE=0`) is Sonnet + everything.
7. Kara's speech: no em dashes/semicolons (a scrubber in `runFastTurn` enforces
   it), no hype phrasing. She must NEVER say "template", "library", "catalog".

## Template rules

- Self-contained single-file HTML, media inlined (base64 ok, deliverable cap 8 MB).
- First line: `<!-- desc: ... -->` — lead with "deliver ONLY via
  publish_template" for big files, then QUOTE the exact swappable strings
  (brand, headline, prices). The catalog shows up to 700 chars; models copy
  swap strings character-for-character from there, so they must be inside.
- Drop-in = live immediately (catalog read fresh each turn). Also add a routing
  hint to the matching guide in `DEMO_SYSTEM` (src/fast-brain.js).
- Workflow preference: build → stage at `deliverables/review/` → user reviews →
  only then save to `templates/`.

## Front-end rules

- `public/script.js` is loaded with a cache-buster: bump `script.js?v=N` in
  index.html on every script change.
- `script.js` requires these element IDs to exist (offstage div keeps unused
  ones): `persona-video`, `poster`, `status`, `start-button`, `stop-button`,
  `pip-button`, `screen-button`, `action-banner`, `chat-history`,
  `draft-panel` (+children).
- The Companion (document PiP) window is a SEPARATE document: main-page
  stylesheets don't apply there — inject CSS and inline styles explicitly.
- Hero video + logo are served from jsDelivr pinned to a commit SHA in
  index.html. When those assets change: commit first, re-pin URLs to the new
  SHA, then redeploy.

## Kara's likeness — hard rule

Her appearance stays identical across all generated assets. Relighting or
animating requires explicit user approval per asset, and every generation gets
a frame-extraction identity check against the source before presenting.
Asset pipeline lives outside the repo (/tmp during sessions); the canonical
loop is `public/kara-beam-loop.mp4` (palindrome bake:
`split[a][b];[b]reverse[r];[a][r]concat` — makes any clip seamlessly loopable).

## Deploy

```bash
fly deploy --ha=false         # single machine — NEVER let Fly create two
```
Live at https://kara-3.fly.dev (Fly app `kara-3`, org personal, region iad).
Secrets via `fly secrets set` (from .env). One always-warm machine
(`auto_stop_machines = "off"`, `min_machines_running = 1` in fly.toml) —
sessions/guards/files are in-process; do NOT scale horizontally without
externalizing state. `transcripts/` and `deliverables/` are symlinked onto the
Fly volume `kara_data` (see Dockerfile CMD) so they survive redeploys.
Load-tested: 50 concurrent conversations, flat memory. The user ceiling is the
Anam plan, not compute. The retired Modal deployment (`modal_app.py`,
drbinna--kara-3-kara.modal.run) may still be running — tear down when ready.

Auth: Clerk sign-in required on /api/session-token and /api/chat-stream
(src/auth.js, same instance as usegoblin.xyz). REQUIRE_AUTH=0 for local dev.

## External services available in sessions

- **Higgsfield MCP** (user's account, OAuth): generation (Seedance for
  identity-preserving video, nano-banana-pro for 4K images), upscale, etc.
  Always `get_cost:true` preflight; decline style presets (they restyle Kara).
- **Zero CLI**: pay-per-call APIs (FLUX, Stability, ESRGAN...) when Higgsfield
  lacks something. Watch for 413s on big payloads; tmpfiles.org for temp hosting.
