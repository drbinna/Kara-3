/* LinkedIn applicant collector — passive DOM harvester.
 *
 * HOW TO USE
 * 1. In your normal browser, open your job's Applicants page on LinkedIn.
 * 2. Open DevTools (Cmd+Option+J) -> Console tab -> paste this whole file -> Enter.
 *    (If Chrome asks, type "allow pasting" first — that's its self-XSS guard.)
 * 3. Click through applicants one by one, like you're reviewing them.
 *    Each time an email is visible on screen, it's captured automatically.
 *    A counter logs progress: [collector] 37 applicants captured
 * 4. When you've clicked through everyone, run:  exportApplicants()
 *    -> downloads applicants.csv (email,name)
 *
 * Nothing is sent anywhere; data stays in your browser (localStorage) until
 * you export. Selector-independent: scans visible text for emails, so it
 * survives LinkedIn's obfuscated/rotating class names.
 */
(() => {
  const KEY = 'goblin_applicants';
  const store = JSON.parse(localStorage.getItem(KEY) || '{}');
  const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const IGNORE = /linkedin\.com|@example\.|noreply|no-reply/i;

  const guessName = () => {
    // The applicant detail pane leads with their name as a heading.
    for (const h of document.querySelectorAll('h1, h2, h3')) {
      const t = h.innerText.trim();
      // Looks like a person's name: 2-5 words, no digits, not a UI label.
      if (t && t.split(/\s+/).length <= 5 && !/\d|applicant|job|search|message/i.test(t) && t.length < 60) {
        return t.replace(/,/g, ' ');
      }
    }
    return '';
  };

  const scan = () => {
    const emails = (document.body.innerText.match(EMAIL_RE) || []).filter((e) => !IGNORE.test(e));
    if (!emails.length) return;
    const name = guessName();
    let added = 0;
    for (const e of emails) {
      const k = e.toLowerCase();
      if (!store[k]) { store[k] = name; added++; }
      else if (name && !store[k]) store[k] = name;
    }
    if (added) {
      localStorage.setItem(KEY, JSON.stringify(store));
      console.log(`[collector] ${Object.keys(store).length} applicants captured`);
    }
  };

  new MutationObserver(() => scan()).observe(document.body, { childList: true, subtree: true });
  setInterval(scan, 1500);
  scan();

  window.exportApplicants = () => {
    const rows = ['email,name', ...Object.entries(store).map(([e, n]) => `${e},${n}`)];
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'applicants.csv';
    a.click();
    console.log(`[collector] exported ${Object.keys(store).length} applicants`);
  };
  window.resetApplicants = () => { localStorage.removeItem(KEY); console.log('[collector] cleared'); };

  console.log('[collector] armed. Click through applicants; run exportApplicants() when done.');
})();
