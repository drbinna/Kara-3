/* Per-conversation session store.
 *
 * Each browser session generates a conversationId and sends it on every
 * request. Everything that used to be global lives here per-conversation:
 *   - zendesk: the operator's own credentials (in-memory only, never on disk)
 *   - pending: the staged ticket change awaiting spoken confirmation
 *   - lastCommit: read-once flag driving the "sent" banner
 *
 * This is what makes multi-user safe: Alice's staged action and Bob's
 * confirmation are in different sessions and can never touch.
 */

const IDLE_EXPIRY_MS = 60 * 60 * 1000; // drop sessions idle for an hour
const sessions = new Map(); // conversationId -> session

export function getSession(conversationId) {
  const id = String(conversationId || 'default');
  let s = sessions.get(id);
  if (!s) {
    s = { id, zendesk: null, pending: null, lastCommit: null, lastSeen: Date.now() };
    sessions.set(id, s);
  }
  s.lastSeen = Date.now();
  return s;
}

export function takeLastCommit(session) {
  const c = session.lastCommit;
  session.lastCommit = null;
  return c;
}

export function sessionCount() {
  return sessions.size;
}

// Sweep idle sessions (also clears any credentials they held).
setInterval(() => {
  const cutoff = Date.now() - IDLE_EXPIRY_MS;
  for (const [id, s] of sessions) if (s.lastSeen < cutoff) sessions.delete(id);
}, 10 * 60 * 1000).unref();
