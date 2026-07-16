/* One-time backfill for per-user project history (run on the Fly machine):
 *   node scripts/backfill-projects.mjs
 *
 * Joins transcripts (which log the Clerk user id per conversation) against
 * the deliverables tree, and writes deliverables/_projects/<userId>.json
 * entries with real file mtimes. Idempotent: existing URLs are kept, only
 * missing ones are added.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = path.join(root, 'transcripts');
const D = path.join(root, 'deliverables');
const P = path.join(D, '_projects');

// conversationId -> userId (first user id seen in that transcript)
const convUser = new Map();
for (const f of await fs.readdir(T).catch(() => [])) {
  if (!f.endsWith('.log')) continue;
  const text = await fs.readFile(path.join(T, f), 'utf8').catch(() => '');
  const m = text.match(/\((user_[A-Za-z0-9]+)/);
  if (m) convUser.set(f.replace(/\.log$/, ''), m[1]);
}

const byUser = new Map(); // userId -> entries[]
for (const conv of await fs.readdir(D).catch(() => [])) {
  if (conv.startsWith('_')) continue;
  const userId = convUser.get(conv);
  if (!userId) continue;
  const dir = path.join(D, conv);
  for (const name of await fs.readdir(dir).catch(() => [])) {
    const st = await fs.stat(path.join(dir, name)).catch(() => null);
    if (!st?.isFile()) continue;
    (byUser.get(userId) ?? byUser.set(userId, []).get(userId)).push({
      name,
      url: `/deliverables/${conv}/${name}`,
      conversationId: conv,
      savedAt: st.mtime.toISOString(),
    });
  }
}

await fs.mkdir(P, { recursive: true });
for (const [userId, entries] of byUser) {
  const file = path.join(P, userId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) + '.json');
  let existing = [];
  try { existing = JSON.parse(await fs.readFile(file, 'utf8')); } catch {}
  const seen = new Set(existing.map((e) => e.url));
  const merged = [...existing, ...entries.filter((e) => !seen.has(e.url))]
    .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1))
    .slice(0, 200);
  await fs.writeFile(file, JSON.stringify(merged), 'utf8');
  console.log(`${userId}: ${merged.length} projects`);
}
console.log(`backfill complete — ${byUser.size} users`);
