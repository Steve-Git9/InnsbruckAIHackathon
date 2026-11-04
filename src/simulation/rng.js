/**
 * rng.js
 * Seeded random numbers. Every random process of the simulation draws from its
 * own named stream (`reject:M2`, `fail:M3:PWF`, ...), derived from the run seed
 * and the stream name. Switching one process on or off therefore never shifts
 * the draws of another one (common random numbers), which keeps A/B comparisons
 * between scenarios fair.
 */

// 32-bit FNV-1a hash of a string
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// mulberry32: small, fast, good enough for a simulation. Returns () => [0,1).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// seed 0 is a valid seed: only null/undefined fall back to 1
export function normaliseSeed(seed) {
  return seed ?? 1;
}

export function makeStream(seed, name) {
  return mulberry32(hash32(`${normaliseSeed(seed)}|${name}`));
}

// Lazily creates and caches one stream per name for a run.
export class StreamSet {
  constructor(seed) {
    this.seed = normaliseSeed(seed);
    this._streams = new Map();
  }
  get(name) {
    let s = this._streams.get(name);
    if (!s) {
      s = makeStream(this.seed, name);
      this._streams.set(name, s);
    }
    return s;
  }
}
