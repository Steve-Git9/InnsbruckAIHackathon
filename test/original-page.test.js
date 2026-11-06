// The starter's original interface at /original/: served unchanged, and with its own simulation,
// so its controls never touch the CEO run of the main page.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const PORT = 4100 + Math.floor(Math.random() * 90);
const server = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
after(() => server.kill());
await Promise.race([
  new Promise((resolve, reject) => {
    server.stdout.on('data', d => { if (String(d).includes('running at')) resolve(); });
    server.on('exit', c => reject(new Error(`server exited early (${c})`)));
  }),
  new Promise((_, rej) => setTimeout(() => rej(new Error('server did not start')), 15000)),
]);
const base = `http://127.0.0.1:${PORT}`;

test('/original redirects to /original/, which serves the starter page and its scripts', async () => {
  const r = await fetch(`${base}/original`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/original/');
  const page = await fetch(`${base}/original/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Multi-Machine Production Line Simulation/);
  assert.doesNotMatch(html, /AI shift advisor/);                    // the starter has no CEO interface
  for (const f of ['app.js', 'style.css', 'sim-status.js', 'suggestions-view.js']) {
    assert.equal((await fetch(`${base}/original/${f}`)).status, 200, f);
  }
  assert.match(await (await fetch(`${base}/`)).text(), /href="\/original\/"/);   // the header button
});

test('the original page has its own simulation (same cookie, separate engine)', async () => {
  const first = await fetch(`${base}/api/state`);
  const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0];
  const fromOriginal = { Cookie: cookie, Referer: `${base}/original/`, 'Content-Type': 'application/json' };
  const fromMain = { Cookie: cookie, Referer: `${base}/`, 'Content-Type': 'application/json' };

  // a CEO run in the main page
  await fetch(`${base}/api/control`, { method: 'POST', headers: fromMain, body: JSON.stringify({ action: 'runScenario', params: { scenario: 'standard', shifts: 1, instant: true } }) });
  const mainTick = (await (await fetch(`${base}/api/state`, { headers: fromMain })).json()).tick;
  assert.ok(mainTick >= 480);

  // the original page starts from tick 0 and its reset does not touch the main run
  assert.equal((await (await fetch(`${base}/api/state`, { headers: fromOriginal })).json()).tick, 0);
  await fetch(`${base}/api/control`, { method: 'POST', headers: fromOriginal, body: JSON.stringify({ action: 'reset' }) });
  assert.equal((await (await fetch(`${base}/api/state`, { headers: fromMain })).json()).tick, mainTick);
  assert.equal((await (await fetch(`${base}/api/results`, { headers: fromMain })).json()).status, 'done');
});
