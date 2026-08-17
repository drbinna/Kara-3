/* Per-user project history — user feature request (Chinedu/Christian U.,
 * 2026-07-15): "I wish Kara could save my projects so I can see what I built
 * in previous sessions."
 *
 * Every deliverable Kara publishes is indexed by the signed-in Clerk user so
 * returning users can browse their past builds. The index lives in its OWN
 * volume-backed folder projects/<userId>.json (symlinked to /data/projects in
 * the Dockerfile, so it survives redeploys), separate from the deliverable
 * files it points at. Single-process writes only — do not scale horizontally
 * without externalizing this (same constraint as sessions, see fly.toml notes).
 *
 * Moved out of deliverables/_projects/ on 2026-08-17; legacy files are migrated
 * lazily on first access (see migrateLegacy).
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DELIVERABLES_ROOT } from './deliverables.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', 'projects');
const LEGACY_DIR = path.join(DELIVERABLES_ROOT, '_projects'); // pre-2026-08-17 home
const MAX_ENTRIES = 200; // per user — plenty, and keeps the JSON tiny

const safeId = (userId) => String(userId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
const fileFor = (userId) => path.join(DIR, safeId(userId) + '.json');
const legacyFileFor = (userId) => path.join(LEGACY_DIR, safeId(userId) + '.json');

/* One-time move of a user's index from the old deliverables/_projects/ home
 * into projects/. Idempotent: a no-op once the new file exists. */
async function migrateLegacy(userId) {
  const dst = fileFor(userId);
  try { await fs.access(dst); return; } catch { /* new file not there yet */ }
  try {
    const data = await fs.readFile(legacyFileFor(userId), 'utf8');
    await fs.mkdir(DIR, { recursive: true });
    await fs.writeFile(dst, data, 'utf8');
    await fs.unlink(legacyFileFor(userId)).catch(() => {});
  } catch { /* no legacy file — nothing to migrate */ }
}

async function readList(userId) {
  try {
    const list = JSON.parse(await fs.readFile(fileFor(userId), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export async function recordProject(userId, { name, url, conversationId }) {
  if (!userId || !name || !url) return;
  await fs.mkdir(DIR, { recursive: true });
  await migrateLegacy(userId);
  let list = await readList(userId);
  list = list.filter((p) => p.url !== url); // a re-publish refreshes its slot
  list.unshift({ name, url, conversationId, savedAt: new Date().toISOString() });
  await fs.writeFile(fileFor(userId), JSON.stringify(list.slice(0, MAX_ENTRIES)), 'utf8');
}

export async function listProjects(userId) {
  if (!userId) return [];
  await migrateLegacy(userId);
  return readList(userId);
}

/* Remove one project from the user's index by url. Returns the removed entry
 * (so the caller can also delete the underlying file), or null if not found. */
export async function deleteProject(userId, url) {
  if (!userId || !url) return null;
  await migrateLegacy(userId);
  const list = await readList(userId);
  const idx = list.findIndex((p) => p.url === url);
  if (idx === -1) return null;
  const [removed] = list.splice(idx, 1);
  await fs.writeFile(fileFor(userId), JSON.stringify(list), 'utf8');
  return removed;
}
