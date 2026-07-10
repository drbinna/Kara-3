#!/usr/bin/env node
/* Work-trial email sender — Resend batch API, dry-run by default.
 *
 *   node trial/send.mjs --template invite --csv trial/data/wave1.csv          # dry run (prints, sends nothing)
 *   node trial/send.mjs --template invite --csv trial/data/wave1.csv --live   # actually send
 *
 * CSV columns: email,name (header row required; extra columns become template
 * vars). Templates live in trial/templates/<name>.md: first line `Subject: …`,
 * rest is the body (markdown-ish; blank-line paragraphs become <p>). {{name}}
 * placeholders substitute per row, falling back to "there" for a blank name.
 *
 * RESEND_API_KEY comes from the environment or ../.env (the SEND-ONLY key is
 * enough here). Applicant CSVs live in trial/data/ which is gitignored.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FROM = process.env.TRIAL_FROM || 'Obi at Goblin Labs <obi@mail.usegoblin.xyz>';
const REPLY_TO = process.env.TRIAL_REPLY_TO || 'obi@usegoblin.xyz';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); return i === -1 ? null : (args[i + 1] ?? true); };
const LIVE = args.includes('--live');
const templateName = flag('template');
const csvPath = flag('csv');
if (!templateName || !csvPath) {
  console.error('usage: node trial/send.mjs --template <name> --csv <file> [--live]');
  process.exit(1);
}

// Load RESEND_API_KEY from ../.env if not in the environment.
if (!process.env.RESEND_API_KEY) {
  try {
    const env = await fsp.readFile(path.join(__dirname, '..', '.env'), 'utf8');
    const m = env.match(/^RESEND_API_KEY=(.+)$/m);
    if (m) process.env.RESEND_API_KEY = m[1].trim();
  } catch {}
}
if (!process.env.RESEND_API_KEY) {
  console.error('RESEND_API_KEY not set (env or ../.env)');
  process.exit(1);
}

/* --- template --- */
const raw = await fsp.readFile(path.join(__dirname, 'templates', `${templateName}.md`), 'utf8');
const [subjectLine, ...bodyLines] = raw.split('\n');
const subjectTpl = subjectLine.replace(/^Subject:\s*/i, '').trim();
const bodyTpl = bodyLines.join('\n').trim();
if (!subjectTpl || !bodyTpl) { console.error('template needs a "Subject:" first line and a body'); process.exit(1); }

/* --- csv --- */
const csv = (await fsp.readFile(csvPath, 'utf8')).trim().split('\n').map((l) => l.split(',').map((c) => c.trim()));
const header = csv.shift().map((h) => h.toLowerCase());
const emailIdx = header.indexOf('email');
if (emailIdx === -1) { console.error('CSV needs an "email" column'); process.exit(1); }
const rows = csv
  .map((cols) => Object.fromEntries(header.map((h, i) => [h, cols[i] ?? ''])))
  .filter((r) => r.email && r.email.includes('@'));

const fill = (tpl, row) =>
  tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => row[k] || (k === 'name' ? 'there' : ''));

const toHtml = (md) =>
  md.split(/\n\s*\n/).map((p) => `<p style="margin:0 0 16px;line-height:1.6">${p.replace(/\n/g, '<br/>')}</p>`).join('\n');

/* --- send (batch endpoint takes up to 100; waves are ~50) --- */
const emails = rows.map((row) => ({
  from: FROM,
  reply_to: REPLY_TO,
  to: [row.email],
  subject: fill(subjectTpl, row),
  text: fill(bodyTpl, row),
  html: toHtml(fill(bodyTpl, row)),
}));

console.log(`${LIVE ? 'SENDING' : 'DRY RUN'}: template=${templateName} recipients=${emails.length}`);
if (!LIVE) {
  console.log('--- first rendered email ---');
  console.log('To:', emails[0]?.to[0], '| Subject:', emails[0]?.subject);
  console.log(emails[0]?.text.slice(0, 600));
  console.log(`--- (${emails.length} total; re-run with --live to send) ---`);
  process.exit(0);
}

for (let i = 0; i < emails.length; i += 100) {
  const batch = emails.slice(i, i + 100);
  const r = await fetch('https://api.resend.com/emails/batch', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(batch),
  });
  const out = await r.json();
  if (!r.ok) { console.error('batch failed:', JSON.stringify(out)); process.exit(1); }
  console.log(`batch ${i / 100 + 1}: sent ${out.data?.length ?? 0}`);
}
console.log('done');
