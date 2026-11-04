/**
 * llm.js
 * Server-side client of the hackathon LLM proxy (mirrors api.py). The credentials
 * never leave the server and never appear in an error message.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_BASE = 'https://ca-backend-mciai-prod.mangoforest-0c569892.swedencentral.azurecontainerapps.io';
const TIMEOUT_MS = 30_000;

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

export async function chat(messages, { temperature = 0.2, maxTokens = 600 } = {}) {
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
      body: JSON.stringify({ model: 'gpt-4o', messages: foldSystem(messages), temperature, maxTokens }),
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
  if (typeof text !== 'string' || !text) throw new Error('The AI service sent an empty answer');
  return text;
}
