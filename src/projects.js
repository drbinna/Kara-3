/* Per-user project history — user feature request (Chinedu/Christian U.,
 * 2026-07-15): "I wish Kara could save my projects so I can see what I built
 * in previous sessions."
 *
 * Every deliverable Kara publishes is indexed by the signed-in Clerk user so
 * returning users can browse their past builds. The index lives on the
 * deliverables volume (deliverables/_projects/<userId>.json), so it survives
 * redeploys alongside the files it points at. Single-process writes only —
 * do not scale horizontally without externalizing this (same constraint as
 * sessions, see fly.toml notes).
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { DELIVERABLES_ROOT } from './deliverables.js';

const DIR = path.join(DELIVERABLES_ROOT, '_projects');
const MAX_ENTRIES = 200; // per user — plenty, and keeps the JSON tiny

const fileFor = (userId) =>
  path.join(DIR, String(userId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) + '.json');

export async function recordProject(userId, { name, url, conversationId }) {
  if (!userId || !name || !url) return;
  await fs.mkdir(DIR, { recursive: true });
  const f = fileFor(userId);
  let list = [];
  try {
    list = JSON.parse(await fs.readFile(f, 'utf8'));
    if (!Array.isArray(list)) list = [];
  } catch { /* first project for this user */ }
  list = list.filter((p) => p.url !== url); // a re-publish refreshes its slot
  list.unshift({ name, url, conversationId, savedAt: new Date().toISOString() });
  await fs.writeFile(f, JSON.stringify(list.slice(0, MAX_ENTRIES)), 'utf8');
}

export async function listProjects(userId) {
  if (!userId) return [];
  try {
    const list = JSON.parse(await fs.readFile(fileFor(userId), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
