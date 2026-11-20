import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const TOKEN = process.env.TELEGRAM_TOKEN, CHAT = process.env.TELEGRAM_CHAT_ID;
const BASE = process.env.TG_BASE || 'https://api.telegram.org';
const STATE = process.env.STATE_FILE || 'sent.json';
const OPEN_MS = +process.env.OPEN_MS || 40000, SCAN_MS = +process.env.SCAN_MS || 170000;

if (!TOKEN || !CHAT) { console.error('Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID secret'); process.exit(1); }

async function tg(text) {
  const r = await fetch(`${BASE}/bot${TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT, text })
  });
  if (!r.ok) throw new Error('Telegram ' + r.status + ' ' + await r.text());
}

if (process.argv.includes('--test')) {
  await tg('✅ Newman Bot is connected. New signals will arrive here.');
  console.log('test message sent'); process.exit(0);
}

let sent = []; try { sent = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}
const found = new Map();

// serve the app files locally (same files you host on GitHub Pages)
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
const srv = http.createServer((q, s) => {
  const p = path.join(process.cwd(), path.normalize(q.url.split('?')[0]).replace(/\/$/, '/index.html'));
  fs.readFile(p, (e, d) => {
    if (e) { s.writeHead(404); s.end(); }
    else { s.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' }); s.end(d); }
  });
});
await new Promise(r => srv.listen(8080, r));

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 420, height: 900 } });
page.on('pageerror', e => console.log('page error:', e.message));
await page.exposeFunction('nbSend', (t, body) => {
  if (/^(BUY|SELL) /.test(t) && /^Entry/.test(body)) found.set(t + '|' + body, { t, body });
});
// catch every alert the app raises
await page.addInitScript(() => {
  let n;
  Object.defineProperty(window, 'notify', { configurable: true,
    get() { return (t, b, g) => { try { window.nbSend(String(t), String(b)); } catch (e) {} try { n && n(t, b, g); } catch (e) {} }; },
    set(v) { n = v; } });
});

await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
// use the Macro desk strategy for every signal
const strat = await page.evaluate(() => {
  const s = document.getElementById('strat');
  s.value = 'macro'; s.dispatchEvent(new Event('change', { bubbles: true })); readCfg();
  return cfg.strat;
});
console.log('strategy:', strat);
await page.evaluate(() => document.getElementById('go').click());
await page.waitForFunction(() => typeof opened !== 'undefined' && opened, null, { timeout: OPEN_MS })
  .catch(() => console.log('warning: price feed did not open'));
await page.evaluate(() => document.getElementById('sgscan').click());
if (process.env.NB_SIM) await page.evaluate(() => notify('BUY Simulated 15m', 'Entry 100 | SL 99 | TP1 101', 'sim'));
await page.waitForFunction(() => /^Last scan/.test(document.getElementById('sgstat').textContent), null, { timeout: SCAN_MS })
  .catch(() => console.log('warning: scan did not finish in time'));
await page.waitForTimeout(5000);

const fresh = [...found.entries()].filter(([k]) => !sent.includes(k));
for (const [k, { t, body }] of fresh) {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  await tg(`${t.startsWith('BUY') ? '🟢' : '🔴'} ${t}\n${body.replace(/ \| /g, '\n')}\n\n${stamp}`);
  sent.push(k);
}
fs.writeFileSync(STATE, JSON.stringify(sent.slice(-300)));
console.log(`signals seen: ${found.size}, new sent: ${fresh.length}`);
await b.close(); srv.close();
