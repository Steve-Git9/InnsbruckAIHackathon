/**
 * tokens.js
 * How many AI tokens has this app used? The hackathon proxy reports the tokens of each answer but has
 * no endpoint for the remaining quota, so the app keeps its own tally (.llm_usage.json, written by
 * src/advisor/llm.js after every answer: the UI chat, "How to improve", the advisor benchmark).
 *
 *   npm run tokens              -> the tally: calls and tokens, in total and per day
 *   npm run tokens -- --test    -> also sends one tiny request ("Say OK"): shows the credentials work
 *                                  and what one call costs (about 200 tokens)
 */
import { fileURLToPath } from 'node:url';
import { chat, readUsage, USAGE_FILE } from '../advisor/llm.js';

const n = (v) => Math.round(v).toLocaleString('en-US');

function printTally(t) {
  console.log(`AI token usage of this app (local tally: ${USAGE_FILE})`);
  if (t.calls === 0) {
    console.log('  No AI calls recorded yet.');
    return;
  }
  console.log(`  Calls:              ${n(t.calls)}`);
  console.log(`  Prompt tokens:      ${n(t.promptTokens)}`);
  console.log(`  Completion tokens:  ${n(t.completionTokens)}`);
  console.log(`  Total tokens:       ${n(t.totalTokens)}   (about ${n(t.totalTokens / t.calls)} per call)`);
  console.log(`  First / last call:  ${t.firstCall} / ${t.lastCall}`);
  const models = Object.entries(t.byModel ?? {});
  if (models.length) {
    console.log('  Per model (since the model was recorded):');
    for (const [m, d] of models) console.log(`    ${m.padEnd(18)} ${n(d.calls).padStart(5)} calls  ${n(d.totalTokens).padStart(10)} tokens`);
  }
  const days = Object.entries(t.byDay).sort(([a], [b]) => a.localeCompare(b));
  if (days.length) {
    console.log('  Per day:');
    for (const [day, d] of days) console.log(`    ${day}  ${n(d.calls).padStart(5)} calls  ${n(d.totalTokens).padStart(10)} tokens`);
  }
}

async function main() {
  if (process.argv.includes('--test')) {
    let usage = null;
    try {
      const text = await chat([{ role: 'user', content: 'Say OK' }], { maxTokens: 5, onUsage: (u) => { usage = u; } });
      console.log(`Test call OK: answer "${text.trim()}", ${n(usage.totalTokens)} tokens `
        + `(${n(usage.promptTokens)} prompt + ${n(usage.completionTokens)} completion)\n`);
    } catch (err) {
      console.log(`Test call failed: ${err.message}\n`);
      process.exitCode = 1;
    }
  }
  printTally(readUsage());
  console.log('\nThe proxy does not tell how many tokens are left: ask the hackathon organisers for the quota.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
