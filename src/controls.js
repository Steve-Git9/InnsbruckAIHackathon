/**
 * controls.js
 * Thin wrappers around SimulationEngine control methods.
 * surfaces drive the engine identically.
 */

export function play(engine) {
  engine.play();
}

export function pause(engine) {
  engine.pause();
}

export function reset(engine) {
  engine.reset();
}

export function setSpeed(engine, multiplier) {
  if (typeof multiplier !== 'number' || !Number.isFinite(multiplier) || multiplier <= 0) {
    throw new Error('speed multiplier must be a positive finite number');
  }
  engine.setSpeed(multiplier);
}
