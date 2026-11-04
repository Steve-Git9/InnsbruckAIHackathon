import { test } from 'node:test';
import assert from 'node:assert/strict';

import { suggestionSignature } from '../src/public/suggestions-view.js';

// The signature drives whether the banner DOM is rebuilt. It must stay stable
// while the same stations are flagged (so the spawn button is never destroyed
// mid-click) yet change when the actual set of suggestions changes.

test('signature is stable across frames when the same stations are flagged', () => {
  const frame1 = [{ type: 'add-parallel-machine', stationId: 'S3', reason: '83% utilization' }];
  const frame2 = [{ type: 'add-parallel-machine', stationId: 'S3', reason: '87% utilization' }];
  // Only the live utilization number in `reason` changed — structure is identical.
  assert.equal(suggestionSignature(frame1), suggestionSignature(frame2));
});

test('signature changes when the set of flagged stations changes', () => {
  const a = [{ type: 'add-parallel-machine', stationId: 'S3' }];
  const b = [
    { type: 'add-parallel-machine', stationId: 'S3' },
    { type: 'add-parallel-machine', stationId: 'S1' },
  ];
  assert.notEqual(suggestionSignature(a), suggestionSignature(b));
});

test('empty vs note vs station suggestions are all distinct', () => {
  assert.equal(suggestionSignature([]), suggestionSignature([]));
  assert.notEqual(suggestionSignature([]), suggestionSignature([{ type: 'no-internal-constraint' }]));
  assert.notEqual(
    suggestionSignature([{ type: 'no-internal-constraint' }]),
    suggestionSignature([{ type: 'add-parallel-machine', stationId: 'S1' }]),
  );
});
