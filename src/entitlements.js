/* Work-trial entitlements — who gets the full brain.
 *
 * Applicants are allowlisted by EMAIL (that's what the hiring pipeline has),
 * one per line in APPLICANTS_FILE (default ./applicants.txt; on Fly it lives
 * on the volume at /data/applicants.txt so the list is editable with
 * `fly ssh console` — no redeploy). Lines starting with # are comments.
 *
 * The signed-in Clerk user id is resolved to their email addresses once via
 * Clerk's Backend API (CLERK_SECRET_KEY) and cached in-process — safe because
 * this app is deliberately a single machine. No secret key set = nobody is an
 * applicant, and everyone stays on the demo brain.
 */
import fsp from 'node:fs/promises';

const APPLICANTS_FILE = process.env.APPLICANTS_FILE || 'applicants.txt';
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY || '';
const CLERK_API = 'https://api.clerk.com/v1';

if (!CLERK_SECRET_KEY) {
  console.warn('[trial] CLERK_SECRET_KEY not set — applicant allowlist disabled, all users get the demo brain');
}

/* Allowlist: re-read at most once per minute so edits land without a restart. */
let allowlist = new Set();
let allowlistReadAt = 0;
async function getAllowlist() {
  if (Date.now() - allowlistReadAt < 60_000) return allowlist;
  allowlistReadAt = Date.now();
  try {
    const raw = await fsp.readFile(APPLICANTS_FILE, 'utf8');
    allowlist = new Set(
      raw
        .split('\n')
        .map((l) => l.trim().toLowerCase())
        .filter((l) => l && !l.startsWith('#')),
    );
  } catch {
    allowlist = new Set(); // no file yet = empty list, not an error
  }
  return allowlist;
}

/* userId -> emails, resolved once per process lifetime. Failures are NOT
 * cached, so a Clerk hiccup on one turn can recover on the next. */
const emailCache = new Map();
async function getUserEmails(userId) {
  if (emailCache.has(userId)) return emailCache.get(userId);
  const r = await fetch(`${CLERK_API}/users/${encodeURIComponent(userId)}`, {
    headers: { Authorization: `Bearer ${CLERK_SECRET_KEY}` },
  });
  if (!r.ok) throw new Error(`clerk users lookup failed: ${r.status}`);
  const user = await r.json();
  const emails = (user.email_addresses || [])
    .map((e) => String(e.email_address || '').toLowerCase())
    .filter(Boolean);
  emailCache.set(userId, emails);
  return emails;
}

/* Is this signed-in user a work-trial applicant? Fails closed (demo brain). */
export async function isApplicant(userId) {
  if (!userId || !CLERK_SECRET_KEY) return false;
  try {
    const [list, emails] = await Promise.all([getAllowlist(), getUserEmails(userId)]);
    return emails.some((e) => list.has(e));
  } catch (err) {
    console.warn(`[trial] applicant check failed for ${userId}: ${err.message}`);
    return false;
  }
}
