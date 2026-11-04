import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Machine, MachineState } from '../src/simulation/entities.js';

test('Machine exposes station + buffer wiring from config', () => {
  const m = new Machine({
    id: 'M3', stationId: 'S3', name: 'Assembly', cycleTime: 15,
    inputBufferId: 'BUF2', outputBufferId: 'BUF3',
  });
  assert.equal(m.stationId, 'S3');
  assert.equal(m.inputBufferId, 'BUF2');
  assert.equal(m.outputBufferId, 'BUF3');
  assert.equal(m.state, MachineState.IDLE);
});

test('Machine outputBufferId may be null (Sink)', () => {
  const m = new Machine({ id: 'M4', stationId: 'S4', name: 'V', cycleTime: 2,
    inputBufferId: 'BUF3', outputBufferId: null });
  assert.equal(m.outputBufferId, null);
});
