/**
 * sim-status.js
 * Pure helpers for classifying a simulation snapshot. Shared by the frontend
 * (app.js) and unit tests so the "finished" definition stays in one place.
 */

// True when the run has ended of its own accord: the engine auto-pauses once
// material is depleted AND the pipeline has fully drained. This mirrors the
// auto-pause condition in engine.js (_tick, STEP 5) exactly — keep them in sync.
export function isSimulationFinished(state) {
  if (!state || state.running) return false;
  if (state.source?.materialStock !== 0) return false;   // -1 = infinite, >0 = stock left
  const buffersEmpty  = state.buffers.every(b => b.load === 0);
  const machinesEmpty = state.machines.every(m => m.currentPartId == null);
  return buffersEmpty && machinesEmpty;
}

// In-flight transfer particles freeze while the sim is stopped so a manual pause
// holds the scene still for inspection. A *finished* run is the exception: there
// will be no resume, so frozen dots would linger forever — instead we let them
// glide to their destination and retire, leaving the line clean.
export function shouldFreezeParticles(state) {
  if (!state) return false;
  return !state.running && !isSimulationFinished(state);
}

// The "Start simulation" banner is a one-time prompt for a run that hasn't begun
// yet: paused at tick 0 (fresh load or after a reset). Once the sim has ticked it
// never shows again, so a later manual pause does not bring it back.
export function shouldShowStartBanner(state) {
  if (!state) return false;
  return !state.running && (state.tick ?? 0) === 0;
}
