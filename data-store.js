import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'app.db');

/* This string is handed to the model so it can write correct SQL. */
export const DB_SCHEMA_DOC = `SQLite tables:
customers(id, name, plan, created_at)
orders(id, customer_id -> customers.id, item, amount_usd, status, ordered_at)
- orders.status is one of 'shipped', 'processing', 'cancelled'
- *_at columns are ISO dates (YYYY-MM-DD)`;

/* ---- one-time seed so the demo works with zero setup ---- */
function seedDatabase() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, plan TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, item TEXT NOT NULL,
      amount_usd REAL NOT NULL, status TEXT NOT NULL, ordered_at TEXT NOT NULL
    );
  `);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM orders').get();
  if (n === 0) {
    const customers = [
      [1, 'Acme Robotics', 'Enterprise', '2025-11-02'],
      [2, 'Northwind Sensors', 'Growth', '2026-01-15'],
      [3, 'Blue Harbor Foods', 'Starter', '2026-03-20'],
      [4, 'Cedar Labs', 'Growth', '2026-05-08'],
    ];
    const orders = [
      [1, 1, 'NW-100 sensor pack', 4200.0, 'shipped', '2026-06-18'],
      [2, 1, 'Gateway hub', 890.0, 'shipped', '2026-06-24'],
      [3, 2, 'Firmware support', 1500.0, 'processing', '2026-06-27'],
      [4, 3, 'Starter kit', 320.0, 'shipped', '2026-06-25'],
      [5, 3, 'Extra probes', 140.0, 'cancelled', '2026-06-26'],
      [6, 4, 'NW-100 sensor pack', 4200.0, 'processing', '2026-06-29'],
      [7, 2, 'Gateway hub', 890.0, 'shipped', '2026-06-30'],
    ];
    const insC = db.prepare('INSERT INTO customers VALUES (?,?,?,?)');
    const insO = db.prepare('INSERT INTO orders VALUES (?,?,?,?,?,?)');
    db.transaction(() => {
      for (const c of customers) insC.run(...c);
      for (const o of orders) insO.run(...o);
    })();
  }
  db.close();
}
seedDatabase();

/* Read-only connection: the driver itself refuses writes. */
const readDb = new Database(DB_PATH, { readonly: true });

export function runReadOnlyQuery(sql) {
  const cleaned = String(sql).trim().replace(/;+\s*$/, '');
  if (!/^(select|with)\b/i.test(cleaned)) {
    throw new Error('Only SELECT/WITH queries are allowed.');
  }
  if (cleaned.includes(';')) {
    throw new Error('Please run one statement at a time.');
  }
  return readDb.prepare(cleaned).all();
}

/* ---- calendar: in-memory events relative to today so the demo is always "live" ----
 * To use a real calendar, replace listCalendarEvents with a Google Calendar
 * call (googleapis: calendar.events.list) that returns the same shape. */
const isoDate = (d) => d.toISOString().slice(0, 10);
const addDays = (base, n) => {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return d;
};

const today = new Date();
const CALENDAR = [
  { title: 'Team standup', start: `${isoDate(addDays(today, 0))}T09:30`, end: `${isoDate(addDays(today, 0))}T09:45`, location: 'Zoom' },
  { title: 'Design review — avatar UX', start: `${isoDate(addDays(today, 1))}T14:00`, end: `${isoDate(addDays(today, 1))}T15:00`, location: 'Room 2A' },
  { title: 'Northwind Sensors call', start: `${isoDate(addDays(today, 2))}T11:00`, end: `${isoDate(addDays(today, 2))}T11:30`, location: 'Phone' },
  { title: '1:1 with Sam', start: `${isoDate(addDays(today, 3))}T16:00`, end: `${isoDate(addDays(today, 3))}T16:30`, location: 'Room 1B' },
  { title: 'Sprint planning', start: `${isoDate(addDays(today, 6))}T10:00`, end: `${isoDate(addDays(today, 6))}T11:30`, location: 'Room 2A' },
];

export function listCalendarEvents({ from = '', to = '' } = {}) {
  const start = from || isoDate(today);
  const end = to || isoDate(addDays(today, 7));
  return CALENDAR
    .filter((e) => e.start.slice(0, 10) >= start && e.start.slice(0, 10) <= end)
    .sort((a, b) => a.start.localeCompare(b.start));
}
