/* Deliverables — files Kara authors for the operator to download.
 *
 * Written under ./deliverables/<sessionId>/, served statically by the server,
 * surfaced in the UI as download chips via {control:{deliverable}} messages.
 * Filenames are sanitized; content is capped; allowed types are text-ish only.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DELIVERABLES_ROOT = path.join(__dirname, '..', 'deliverables'); // repo-root, not src/

const ALLOWED_EXT = new Set(['.md', '.txt', '.html', '.csv', '.json']);
// Big enough for template-published pages with embedded media (the research-lab
// template alone is ~1.6MB of base64 video).
const MAX_BYTES = 8 * 1024 * 1024;

export async function saveDeliverable(sessionId, filename, content) {
  let name = String(filename || 'output.md')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '')
    .slice(0, 80) || 'output.md';
  if (!path.extname(name)) name += '.md';
  if (!ALLOWED_EXT.has(path.extname(name).toLowerCase())) {
    throw new Error(`Only ${[...ALLOWED_EXT].join(' ')} deliverables are supported.`);
  }
  const body = String(content ?? '');
  if (!body.trim()) throw new Error('Deliverable content is empty.');
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Error(`Deliverable too large (${MAX_BYTES / 1048576}MB max).`);

  const dir = path.join(DELIVERABLES_ROOT, String(sessionId).replace(/[^a-zA-Z0-9-]/g, ''));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), body, 'utf8');
  return { name, url: `/deliverables/${path.basename(dir)}/${name}` };
}
