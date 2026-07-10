/* Cara's own browser — server-side Playwright, DOM-first for speed.
 *
 * One shared Chromium, one page per operator session. Actions are
 * programmatic (no pixel-hunting), page content is returned as TEXT so the
 * model reads instantly; browser_screenshot exists for when vision helps.
 *
 * Playwright is loaded lazily so the server runs fine without it; the tools
 * return an instructive error until `npx playwright install chromium` is done.
 */

let pw = null;
let browser = null;
const pages = new Map(); // sessionId -> page

/* Real Google Chrome in NEW headless mode: invisible (no window steals the
 * screen from Cara), but with real Chrome's fingerprint — far fewer bot
 * walls than the bundled Chromium. Falls back to bundled Chromium if Chrome
 * isn't installed. */
async function launchBrowser() {
  try {
    return await pw.chromium.launch({ headless: true, channel: 'chrome' });
  } catch {
    return await pw.chromium.launch({ headless: true });
  }
}

async function getPage(sessionId) {
  if (!pw) {
    try {
      pw = await import('playwright');
    } catch {
      throw new Error(
        "Browsing isn't installed on this server. Run: npm install playwright && npx playwright install chromium"
      );
    }
  }
  if (!browser) {
    browser = await launchBrowser();
    browser.on('disconnected', () => { browser = null; pages.clear(); });
  }
  let page = pages.get(sessionId);
  if (!page || page.isClosed()) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    page = await ctx.newPage();
    page.setDefaultTimeout(8000);
    pages.set(sessionId, page);
  }
  return page;
}

/* Pre-launch the browser so the first search doesn't pay the cold start. */
export async function warmBrowser() {
  try {
    if (!pw) pw = await import('playwright');
    if (!browser) {
      browser = await launchBrowser();
      browser.on('disconnected', () => { browser = null; pages.clear(); });
    }
    return true;
  } catch {
    return false; // browsing stays lazily-disabled until playwright is installed
  }
}

async function summary(page, chars = 3500) {
  const title = await page.title().catch(() => '');
  const url = page.url();
  const text = await page
    .evaluate(() => document.body?.innerText || '')
    .catch(() => '');
  return `PAGE: ${title}\nURL: ${url}\n---\n${text.replace(/\n{3,}/g, '\n\n').slice(0, chars)}`;
}

export async function browserOpen(sessionId, url) {
  const page = await getPage(sessionId);
  const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  // Cap the wait tightly: a page that isn't ready in 6s (slow, walled, or
  // login-gated) should hand control back fast, not stall the whole turn.
  try {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 6000 });
  } catch {
    return `Couldn't load ${target} quickly (it may be slow or behind a login). Don't wait on it — work from what you already have.`;
  }
  return summary(page);
}

export async function browserRead(sessionId) {
  const page = await getPage(sessionId);
  return summary(page, 5000);
}

export async function browserClick(sessionId, text) {
  const page = await getPage(sessionId);
  const t = String(text).trim();
  // Try semantic targets first (fast + robust), fall back to raw text.
  const candidates = [
    page.getByRole('link', { name: t, exact: false }).first(),
    page.getByRole('button', { name: t, exact: false }).first(),
    page.getByText(t, { exact: false }).first(),
  ];
  let lastErr = null;
  for (const c of candidates) {
    try {
      await c.click({ timeout: 4000 });
      await page.waitForLoadState('domcontentloaded', { timeout: 6000 }).catch(() => {});
      return summary(page);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`Couldn't find anything clickable matching "${t}". ${lastErr?.message?.split('\n')[0] || ''}`);
}

export async function browserType(sessionId, { field, text, press_enter }) {
  const page = await getPage(sessionId);
  const f = String(field || '').trim();
  const named = f
    ? [
        page.getByLabel(f, { exact: false }).first(),
        page.getByPlaceholder(f, { exact: false }).first(),
        page.getByRole('textbox', { name: f, exact: false }).first(),
      ]
    : [];
  // Generic fallbacks ALWAYS apply — a wrong field name should degrade to
  // "the obvious input on the page", not fail outright.
  const candidates = [
    ...named,
    page.getByRole('searchbox').first(),
    page.locator('input[type="search"]:visible, input[type="text"]:visible, textarea:visible, input:not([type]):visible').first(),
  ];
  let lastErr = null;
  for (const c of candidates) {
    try {
      await c.fill(String(text ?? ''), { timeout: 2500 });
      if (press_enter) {
        await c.press('Enter');
        await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
      }
      return summary(page);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`Couldn't find a field matching "${f}". ${lastErr?.message?.split('\n')[0] || ''}`);
}

/* Real markup, not just text: outerHTML of the first element matching a CSS
 * selector (default: <main>, falling back to <body>). For copying/adapting
 * components into pages Cara is building. Trimmed so it fits the model. */
export async function browserGetHtml(sessionId, selector) {
  const page = await getPage(sessionId);
  const sel = String(selector || '').trim();
  const result = await page.evaluate((s) => {
    const el = s ? document.querySelector(s) : (document.querySelector('main') || document.body);
    if (!el) return null;
    const sheets = [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.href).slice(0, 5);
    return { html: el.outerHTML, sheets };
  }, sel);
  if (!result) throw new Error(`No element matches "${sel}" on this page. Try browser_read first to see the page, or a broader selector like header, main, footer.`);
  const html = result.html.length > 12000 ? result.html.slice(0, 12000) + '\n<!-- …trimmed at 12k chars — use a narrower selector for the rest… -->' : result.html;
  return `URL: ${page.url()}\nSELECTOR: ${sel || '(main/body)'}\nSTYLESHEETS: ${result.sheets.join(', ') || '(none linked)'}\n---\n${html}`;
}

export async function browserScreenshot(sessionId) {
  const page = await getPage(sessionId);
  const buf = await page.screenshot({ type: 'jpeg', quality: 60 });
  return { base64: buf.toString('base64'), url: page.url() };
}

/* ---------------- computer use — Anthropic's tool on Cara's browser -------
 * Implements the computer_2025* action set against the Playwright page:
 * pixel-coordinate mouse, keyboard, scroll, drag. Every action returns a
 * fresh screenshot so the model can verify what happened. Screen: 1280x720.
 */
const XKEY = {
  Return: 'Enter', KP_Enter: 'Enter', BackSpace: 'Backspace', Escape: 'Escape',
  Page_Down: 'PageDown', Page_Up: 'PageUp', Up: 'ArrowUp', Down: 'ArrowDown',
  Left: 'ArrowLeft', Right: 'ArrowRight', space: 'Space',
  ctrl: 'Control', control: 'Control', alt: 'Alt', shift: 'Shift',
  super: 'Meta', cmd: 'Meta', command: 'Meta', meta: 'Meta',
};
const pwKey = (k) => XKEY[k] || (k.length === 1 ? k : k.charAt(0).toUpperCase() + k.slice(1));
const pwCombo = (combo) => String(combo || '').split('+').map(pwKey).join('+');

export async function computerAction(sessionId, input) {
  const page = await getPage(sessionId);
  const { action, coordinate, start_coordinate, text, duration, scroll_direction, scroll_amount } = input || {};
  const [x, y] = Array.isArray(coordinate) ? coordinate.map(Number) : [];
  // Modifier keys held during click/scroll actions ride in `text` (e.g. "shift").
  const mods = text && /click|scroll/.test(String(action)) ? String(text).split('+').map(pwKey) : [];
  const withMods = async (fn) => {
    for (const m of mods) await page.keyboard.down(m);
    try { await fn(); } finally { for (const m of [...mods].reverse()) await page.keyboard.up(m); }
  };

  switch (action) {
    case 'screenshot': break;
    case 'cursor_position': return 'Cursor position is not tracked here — take a screenshot to see the page.';
    case 'left_click': await withMods(() => page.mouse.click(x, y)); break;
    case 'right_click': await withMods(() => page.mouse.click(x, y, { button: 'right' })); break;
    case 'middle_click': await withMods(() => page.mouse.click(x, y, { button: 'middle' })); break;
    case 'double_click': await withMods(() => page.mouse.click(x, y, { clickCount: 2 })); break;
    case 'triple_click': await withMods(() => page.mouse.click(x, y, { clickCount: 3 })); break;
    case 'mouse_move': await page.mouse.move(x, y); break;
    case 'left_mouse_down': { if (Number.isFinite(x)) await page.mouse.move(x, y); await page.mouse.down(); break; }
    case 'left_mouse_up': { if (Number.isFinite(x)) await page.mouse.move(x, y); await page.mouse.up(); break; }
    case 'left_click_drag': {
      const [sx, sy] = Array.isArray(start_coordinate) ? start_coordinate.map(Number) : [];
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      await page.mouse.move(x, y, { steps: 12 });
      await page.mouse.up();
      break;
    }
    case 'type': await page.keyboard.type(String(text ?? ''), { delay: 12 }); break;
    case 'key': await page.keyboard.press(pwCombo(text)); break;
    case 'hold_key': {
      const k = pwKey(String(text || ''));
      await page.keyboard.down(k);
      await page.waitForTimeout(Math.min((Number(duration) || 1) * 1000, 5000));
      await page.keyboard.up(k);
      break;
    }
    case 'wait': await page.waitForTimeout(Math.min((Number(duration) || 1) * 1000, 10000)); break;
    case 'scroll': {
      if (Number.isFinite(x)) await page.mouse.move(x, y);
      const amt = (Number(scroll_amount) || 3) * 120;
      const d = String(scroll_direction || 'down');
      await withMods(() => page.mouse.wheel(
        d === 'left' ? -amt : d === 'right' ? amt : 0,
        d === 'up' ? -amt : d === 'down' ? amt : 0,
      ));
      break;
    }
    default: throw new Error(`Unsupported computer action "${action}".`);
  }

  await page.waitForTimeout(300); // let the page settle before the verify shot
  const buf = await page.screenshot({ type: 'jpeg', quality: 60 });
  return { base64: buf.toString('base64'), url: page.url(), action: String(action) };
}

/* Web search now runs server-side on Anthropic's infrastructure (see the
 * web_search tool declaration in fast-brain.js) — no scraping, no bot walls. */
