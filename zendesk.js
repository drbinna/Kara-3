/* Zendesk Ticketing client — per-user credential aware.
 *
 * Every function takes an optional `creds` ({subdomain, email, apiToken}).
 * Resolution order: creds argument (onboarded operator) → ZENDESK_* env
 * (shared server credentials) → in-memory MOCK (demo mode, offline rehearsal).
 */

const { ZENDESK_SUBDOMAIN, ZENDESK_EMAIL, ZENDESK_API_TOKEN } = process.env;
const ENV_CREDS =
  ZENDESK_SUBDOMAIN && ZENDESK_EMAIL && ZENDESK_API_TOKEN
    ? { subdomain: ZENDESK_SUBDOMAIN, email: ZENDESK_EMAIL, apiToken: ZENDESK_API_TOKEN }
    : null;

export const MODE = ENV_CREDS ? 'live' : 'mock'; // server-default mode (per-user creds override per call)

function resolve(creds) {
  const c = creds && creds.subdomain && creds.email && creds.apiToken ? creds : ENV_CREDS;
  if (!c) return { mode: 'mock' };
  return {
    mode: 'live',
    base: `https://${c.subdomain}.zendesk.com/api/v2`,
    auth: 'Basic ' + Buffer.from(`${c.email}/token:${c.apiToken}`).toString('base64'),
  };
}

async function zfetch(client, pathAndQuery, init = {}) {
  const res = await fetch(`${client.base}${pathAndQuery}`, {
    ...init,
    headers: { Authorization: client.auth, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`Zendesk ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/* Validate onboarding credentials by fetching the authenticated user.
 * Returns { ok, name?, email?, error? } — never throws. */
export async function verifyCredentials(creds) {
  const client = resolve(creds);
  if (client.mode !== 'live') return { ok: false, error: 'Incomplete credentials.' };
  try {
    const data = await zfetch(client, '/users/me.json');
    if (!data?.user?.id) return { ok: false, error: 'Credentials rejected by Zendesk.' };
    return { ok: true, name: data.user.name, email: data.user.email };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const OPEN_STATES = new Set(['new', 'open', 'pending', 'hold']);

/* ------------------------------- mock data ------------------------------- */
const mockTickets = [
  { id: 4302, subject: "Can't log in after password reset", requester: 'Dana Piraino — Acme Robotics', status: 'open', priority: 'high', description: 'I reset my password but the login page keeps rejecting the new one as invalid.', comments: [] },
  { id: 4310, subject: 'Charged twice for the Growth plan', requester: 'Miles Cho — Blue Harbor Foods', status: 'open', priority: 'urgent', description: 'My card was charged twice this month. Please refund one of them.', comments: [] },
  { id: 4315, subject: "Sensor firmware won't flash", requester: 'Tom Reyes — Northwind Sensors', status: 'open', priority: 'normal', description: 'NW-100 is stuck in the bootloader after the 0.3 update and never comes back.', comments: [] },
  { id: 4288, subject: 'Feature request: dark mode', requester: 'Priya Nair — Cedar Labs', status: 'pending', priority: 'low', description: 'Any chance of a dark theme for the dashboard? It is rough at night.', comments: [] },
];
const brief = (t) => ({ id: t.id, subject: t.subject, requester: t.requester, status: t.status, priority: t.priority });

/* --------------------------------- API ----------------------------------- */
export async function listOpenTickets(creds) {
  const client = resolve(creds);
  if (client.mode === 'mock') return mockTickets.filter((t) => OPEN_STATES.has(t.status)).map(brief);
  const data = await zfetch(client, `/search.json?query=${encodeURIComponent('type:ticket status<solved')}`);
  return (data.results || []).slice(0, 25).map((t) => ({
    id: t.id, subject: t.subject, requester: t.requester_id, status: t.status, priority: t.priority,
  }));
}

export async function getTicket(id, creds) {
  const client = resolve(creds);
  if (client.mode === 'mock') {
    const t = mockTickets.find((x) => x.id === Number(id));
    if (!t) throw new Error(`Ticket #${id} not found.`);
    return t;
  }
  const data = await zfetch(client, `/tickets/${id}.json`);
  return data.ticket;
}

export async function updateTicket(id, { status, comment } = {}, creds) {
  const client = resolve(creds);
  if (client.mode === 'mock') {
    const t = mockTickets.find((x) => x.id === Number(id));
    if (!t) throw new Error(`Ticket #${id} not found.`);
    if (status) t.status = status;
    if (comment) t.comments.push({ body: comment, public: true, at: new Date().toISOString() });
    return brief(t);
  }
  const ticket = {};
  if (status) ticket.status = status;
  if (comment) ticket.comment = { body: comment, public: true };
  const data = await zfetch(client, `/tickets/${id}.json`, { method: 'PUT', body: JSON.stringify({ ticket }) });
  return { id: data.ticket.id, subject: data.ticket.subject, status: data.ticket.status };
}

/* Demo trigger: inject a new mock ticket so the announcer has something to
 * announce on cue (rehearsal + filming). Mock pool only. */
let nextMockId = 4400;
export function injectMockTicket({ subject, requester, priority } = {}) {
  const t = {
    id: nextMockId++,
    subject: subject || 'Site is down — checkout failing for all users',
    requester: requester || 'Blue Harbor Foods — Ops',
    status: 'open',
    priority: priority || 'urgent',
    description: 'Injected demo ticket for the announcer.',
    comments: [],
  };
  mockTickets.push(t);
  return brief(t);
}
