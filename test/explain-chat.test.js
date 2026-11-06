// Explanation chat and token tally: the advisor's follow-up prompt, the usage file, and the server
// endpoint end to end against a fake LLM proxy on localhost (no network, no real tokens).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createAdvisor, CHAT_SYSTEM, MAX_FOLLOW_UPS } from '../src/advisor/advisor.js';
import { readUsage, recordUsage } from '../src/advisor/llm.js';

const summary = {
  scenario: { id: 'demand-swing', label: 'Demand swing' }, shifts: 20,
  orders: { ordered: 600, shippedOnTime: 340, serviceLevel: 0.57, late: 260, backlogEnd: 5 },
  perShift: [{ shift: 1, orders: 61, shippedOnTime: 30, backlog: 31, produced: 30, stock: 0 }],
};
const fakeChat = (answer, usage = { promptTokens: 900, completionTokens: 60, totalTokens: 960 }) => {
  const calls = [];
  const fn = async (messages, opts = {}) => { calls.push(messages); opts.onUsage?.(usage); return answer; };
  fn.calls = calls;
  return fn;
};

test('explain returns the text, the token usage and the number check', async () => {
  const r = await createAdvisor({ chat: fakeChat('260 orders were late: 57% on time.') }).explain(summary);
  assert.equal(r.text, '260 orders were late: 57% on time.');
  assert.equal(r.usage.totalTokens, 960);
  assert.deepEqual(r.grounding, { numbers: 2, ungrounded: [] });
});

test('ask sends the facts, the explanation and the earlier turns, then the question', async () => {
  const chat = fakeChat('M3 was the bottleneck; 42.5% is my estimate.');
  const conv = { explanation: 'First explanation.', turns: [{ question: 'Q1?', answer: 'A1.' }] };
  const r = await createAdvisor({ chat }).ask(summary, conv, '  Why were orders late?  ');
  const m = chat.calls[0];
  assert.deepEqual(m.map(x => x.role), ['system', 'user', 'assistant', 'user', 'assistant', 'user']);
  assert.equal(m[0].content, CHAT_SYSTEM);
  assert.ok(m[1].content.startsWith('FACTS:\n'));
  assert.equal(m[2].content, 'First explanation.');
  assert.equal(m[5].content, 'Why were orders late?');
  assert.deepEqual(r.grounding.ungrounded, [42.5]);       // a number the facts do not have is flagged
  await assert.rejects(createAdvisor({ chat }).ask(summary, conv, '   '), /empty/);
  await assert.rejects(createAdvisor({ chat }).ask(summary, conv, 'x'.repeat(501)), /too long/);
});

test('the token tally adds up calls and keeps a per-day count', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'usage-')), 'u.json');
  assert.equal(readUsage(file).calls, 0);
  recordUsage({ promptTokens: 100, completionTokens: 20, totalTokens: 120 }, file, new Date('2026-11-05T10:00:00Z'));
  recordUsage({ promptTokens: 50, completionTokens: 5, totalTokens: 55 }, file, new Date('2026-11-06T10:00:00Z'));
  recordUsage(undefined, file, new Date('2026-11-06T11:00:00Z'));        // an answer without usage still counts as a call
  const t = readUsage(file);
  assert.equal(t.calls, 3);
  assert.equal(t.totalTokens, 175);
  assert.equal(t.promptTokens, 150);
  assert.deepEqual(t.byDay, { '2026-11-05': { calls: 1, totalTokens: 120 }, '2026-11-06': { calls: 2, totalTokens: 55 } });
  assert.equal(t.firstCall, '2026-11-05T10:00:00.000Z');
});

// ── endpoint, against a fake proxy ────────────────────────────────────────────
let proxyCalls = 0;
const proxy = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    proxyCalls += 1;
    const followUp = JSON.parse(body).messages.some(m => m.role === 'assistant');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: {
      content: followUp ? `Answer ${proxyCalls}.` : 'Explanation of the run.',
      usage: { promptTokens: 400, completionTokens: 25, totalTokens: 425 },
    } }));
  });
});
await new Promise(r => proxy.listen(0, '127.0.0.1', r));
const usageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
const PORT = 3990 + Math.floor(Math.random() * 9);
const server = spawn(process.execPath, ['src/server.js'], {
  env: {
    ...process.env, PORT: String(PORT), CLIENT_ID: 'test', CLIENT_SECRET: 'test',
    LLM_BASE_URL: `http://127.0.0.1:${proxy.address().port}`, LLM_USAGE_FILE: path.join(usageDir, 'u.json'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
after(() => { server.kill(); proxy.close(); });
await Promise.race([
  new Promise((resolve, reject) => {
    server.stdout.on('data', d => { if (String(d).includes('running at')) resolve(); });
    server.on('exit', c => reject(new Error(`server exited early (${c})`)));
  }),
  new Promise((_, rej) => setTimeout(() => rej(new Error('server did not start')), 15000)),
]);

const base = `http://127.0.0.1:${PORT}`;
async function api(p, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(base + p, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { res, json: await res.json(), cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] };
}

test('endpoint: explanation, follow-ups with the conversation kept on the server, limits, reset on a new run', async () => {
  const run = await api('/api/control', { method: 'POST', body: { action: 'runScenario', params: { scenario: 'standard', shifts: 2, instant: true } } });
  const cookie = run.cookie;

  const early = await api('/api/advisor/explain', { method: 'POST', body: { question: 'Why?' }, cookie });
  assert.equal(early.res.status, 409);                                    // no explanation yet

  const first = await api('/api/advisor/explain', { method: 'POST', body: {}, cookie });
  assert.equal(first.res.status, 200);
  assert.equal(first.json.text, 'Explanation of the run.');
  assert.equal(first.json.followUpsLeft, MAX_FOLLOW_UPS);
  assert.deepEqual(first.json.sessionTokens, { calls: 1, totalTokens: 425 });

  const q = await api('/api/advisor/explain', { method: 'POST', body: { question: 'Which machine limited the output?' }, cookie });
  assert.equal(q.res.status, 200);
  assert.match(q.json.text, /^Answer/);
  assert.equal(q.json.followUpsLeft, MAX_FOLLOW_UPS - 1);
  assert.equal(q.json.sessionTokens.totalTokens, 850);

  assert.equal((await api('/api/advisor/explain', { method: 'POST', body: { question: '   ' }, cookie })).res.status, 400);
  assert.equal((await api('/api/advisor/explain', { method: 'POST', body: { question: 'x'.repeat(501) }, cookie })).res.status, 400);

  for (let i = 1; i < MAX_FOLLOW_UPS; i++) {
    assert.equal((await api('/api/advisor/explain', { method: 'POST', body: { question: `Q${i}` }, cookie })).res.status, 200);
  }
  assert.equal((await api('/api/advisor/explain', { method: 'POST', body: { question: 'One more' }, cookie })).res.status, 429);

  const usage = await api('/api/advisor/usage', { cookie });
  assert.equal(usage.json.session.calls, MAX_FOLLOW_UPS + 1);
  assert.equal(usage.json.allRuns.calls, MAX_FOLLOW_UPS + 1);           // the server wrote the tally file

  // a new run starts a new chat: follow-ups need a new explanation first
  await api('/api/control', { method: 'POST', body: { action: 'runScenario', params: { scenario: 'standard', shifts: 2, instant: true } }, cookie });
  assert.equal((await api('/api/advisor/explain', { method: 'POST', body: { question: 'Why?' }, cookie })).res.status, 409);
});
