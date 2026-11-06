/**
 * llm.js
 * Server-side client of the hackathon LLM proxy (mirrors api.py). The credentials
 * never leave the server and never appear in an error message.
 * Every call's token usage (the proxy reports it per answer) is added to a local tally,
 * .llm_usage.json in the project root (git-ignored); `npm run tokens` prints it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_BASE = 'https://ca-backend-mciai-prod.mangoforest-0c569892.swedencentral.azurecontainerapps.io';
const TIMEOUT_MS = 60_000;                       // Claude Opus can take longer than gpt-4o on a long answer

// Models of the hackathon proxy (same endpoint, the model is a field of the request; see api.py / "api copy.py").
// The countermeasure pick stays on gpt-4o, the model the advisor benchmark (npm run eval:advisor) measured;
// the explanation chat uses Claude Opus 4.8. Both can be changed with an environment variable.
export const DEFAULT_MODEL = process.env.LLM_MODEL || 'gpt-4o';
export const EXPLAIN_MODEL = process.env.LLM_EXPLAIN_MODEL || 'claude-opus-4-8';
export const MODEL_LABELS = { 'gpt-4o': 'GPT-4o', 'claude-opus-4-8': 'Claude Opus 4.8' };

// KEY=VALUE lines of .env; # comments and blank lines ignored, quotes stripped
export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}

function credentials() {
  let id = process.env.CLIENT_ID, secret = process.env.CLIENT_SECRET;
  if (!id || !secret) {
    try {
      const env = parseEnv(fs.readFileSync(path.join(ROOT, '.env'), 'utf8'));
      id = id || env.CLIENT_ID;
      secret = secret || env.CLIENT_SECRET;
    } catch { /* no .env file */ }
  }
  return id && secret ? { id, secret } : null;
}

// The proxy accepts only the roles "user" and "assistant": system text goes in front of the first user message.
export function foldSystem(messages) {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const rest = messages.filter(m => m.role !== 'system').map(m => ({ ...m }));
  if (system) {
    const first = rest.find(m => m.role === 'user');
    if (first) first.content = `${system}\n\n${first.content}`;
    else rest.unshift({ role: 'user', content: system });
  }
  return rest;
}

// ── Token tally ──────────────────────────────────────────────────────────────
// The proxy has no endpoint for the remaining quota: it only reports the tokens of each answer.
export const USAGE_FILE = process.env.LLM_USAGE_FILE || path.join(ROOT, '.llm_usage.json');
const EMPTY_TALLY = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, firstCall: null, lastCall: null, byDay: {} };

export function readUsage(file = USAGE_FILE) {
  try { return { ...EMPTY_TALLY, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch { return { ...EMPTY_TALLY, byDay: {} }; }
}

// Adds one answer's usage ({ promptTokens, completionTokens, totalTokens }) to the tally; never throws
export function recordUsage(usage, file = USAGE_FILE, now = new Date(), model = null) {
  const u = {
    promptTokens: Number(usage?.promptTokens) || 0, completionTokens: Number(usage?.completionTokens) || 0,
    totalTokens: Number(usage?.totalTokens) || 0,
  };
  try {
    const t = readUsage(file);
    t.calls += 1;
    t.promptTokens += u.promptTokens; t.completionTokens += u.completionTokens; t.totalTokens += u.totalTokens;
    const stamp = now.toISOString();
    t.firstCall ??= stamp;
    t.lastCall = stamp;
    const day = stamp.slice(0, 10);
    const d = t.byDay[day] ?? { calls: 0, totalTokens: 0 };
    t.byDay[day] = { calls: d.calls + 1, totalTokens: d.totalTokens + u.totalTokens };
    if (model) {
      t.byModel ??= {};
      const m = t.byModel[model] ?? { calls: 0, totalTokens: 0 };
      t.byModel[model] = { calls: m.calls + 1, totalTokens: m.totalTokens + u.totalTokens };
    }
    fs.writeFileSync(file, JSON.stringify(t, null, 2));
  } catch { /* the tally is a convenience: a write error must not break an answer */ }
  return u;
}

// onUsage(usage) is called with this answer's token counts; model = a model of the proxy (default gpt-4o)
export async function chat(messages, { temperature = 0.2, maxTokens = 600, onUsage = null, model = DEFAULT_MODEL } = {}) {
  const cred = credentials();
  if (!cred) throw new Error('AI credentials missing');
  const base = (process.env.LLM_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${base}/api/v1/llm/chat`, {
      method: 'POST',
      headers: { 'X-Client-ID': cred.id, 'X-Client-Secret': cred.secret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: foldSystem(messages), temperature, maxTokens }),
      signal: ctl.signal,
    });
  } catch {
    throw new Error('The AI service is not reachable');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`The AI service returned an error (HTTP ${res.status})`);
  let json;
  try { json = await res.json(); } catch { throw new Error('The AI service sent an unreadable answer'); }
  const text = json?.data?.content;
  const usage = recordUsage(json?.data?.usage, USAGE_FILE, new Date(), model);
  if (onUsage) onUsage(usage);
  if (typeof text !== 'string' || !text) throw new Error('The AI service sent an empty answer');
  return text;
}
