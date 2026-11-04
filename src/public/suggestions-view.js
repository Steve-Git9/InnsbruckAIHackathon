/**
 * suggestions-view.js
 * Pure helpers for rendering the bottleneck-suggestion banner.
 */

// A structural fingerprint of the current suggestion set. The banner is only
// rebuilt when this changes, so the DOM (and its spawn button) survives across
// SSE frames — otherwise a click whose mousedown→mouseup straddles a 250ms
// rebuild is silently dropped, forcing the user to click several times.
//
// Deliberately excludes live numbers (e.g. the utilization % inside `reason`):
// those change every frame but must not trigger a rebuild.
export function suggestionSignature(suggestions) {
  return (suggestions ?? [])
    .map(s => s.type === 'add-parallel-machine' ? `m:${s.stationId}` : s.type)
    .join('|');
}
