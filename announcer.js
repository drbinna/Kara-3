/* The announcer — Kara speaks first.
 *
 * One watcher per connected operator: polls their Zendesk (their creds, or
 * the mock pool in demo mode), baselines the existing tickets on first poll,
 * then announces any NEW urgent/high ticket exactly once via the push channel.
 */
import { listOpenTickets } from './zendesk.js';

const INTERVAL_MS = Number(process.env.ANNOUNCE_MS || 8000);
const ANNOUNCE_PRIORITIES = new Set(['urgent', 'high']);

export function startWatcher(session, push) {
  let known = null; // null = not baselined yet (never announce pre-existing tickets)
  const tick = async () => {
    try {
      const tickets = await listOpenTickets(session.zendesk || null);
      const ids = new Set(tickets.map((t) => t.id));
      if (known) {
        for (const t of tickets) {
          if (session.announced?.has(t.id)) continue; // already announced instantly (demo button)
          if (!known.has(t.id) && ANNOUNCE_PRIORITIES.has(String(t.priority))) {
            push({
              type: 'announce',
              text: `Heads up — a new ${t.priority} priority ticket just came in from ${t.requester}: ${t.subject}. Want me to open it?`,
              ticket: t,
            });
          }
        }
      }
      known = ids;
    } catch {
      /* transient poll failures are fine; next tick retries */
    }
  };
  tick();
  const h = setInterval(tick, INTERVAL_MS);
  return () => clearInterval(h);
}
