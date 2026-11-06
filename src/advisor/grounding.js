/**
 * grounding.js
 * Are the numbers in an AI answer in what the AI was given? Used by the explanation chat (a badge under
 * every answer) and by the advisor benchmark. Rounded and percent forms count as found
 * (0.569 -> 56.9% / 57%); small integers (counts, shift numbers, "M3") are ignored.
 */
const NUM = /\d[\d,]*(?:\.\d+)?/g;
const toNum = (s) => Number(s.replace(/,/g, ''));
export const IGNORE_BELOW = 13;      // small integers: counts, shift numbers, "M3", "2 minutes" ...

// Every number in the prompt, plus the forms the AI may legitimately write it in (percent, rounded)
export function allowedNumbers(promptText) {
  const set = new Set();
  const add = (v) => { if (Number.isFinite(v)) set.add(Math.abs(v)); };
  for (const m of String(promptText).match(NUM) ?? []) {
    const v = toNum(m);
    for (const x of [v, v * 100]) { add(x); add(Math.round(x)); add(Math.round(x * 10) / 10); }
  }
  return [...set];
}

export function groundingOf(reason, allowed) {
  const found = (String(reason).match(NUM) ?? []).map(toNum).filter(v => !(Number.isInteger(v) && v < IGNORE_BELOW));
  const ok = (v) => allowed.some(a => Math.abs(v - a) <= Math.max(0.05, 0.005 * a));
  const ungrounded = found.filter(v => !ok(v));
  return { numbers: found.length, ungrounded };
}
