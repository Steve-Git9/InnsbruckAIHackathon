/**
 * presets.js
 * Curated, read-only teaching scenarios. Each preset is a COMPLETE simulation
 * config (same shape as DEFAULT_CONFIG) chosen to demonstrate one concept.
 * Users cannot add presets — they are code. Loaded via POST /api/control
 * { action: 'loadPreset', params: { presetId } }, which leaves the engine
 * paused at tick 0 so the user presses Start explicitly.
 */

export const PRESETS = [
  {
    id: 'bottleneck',
    label: 'Bottleneck (Assembly)',
    description: 'One slow station (M3 Assembly) becomes the clear bottleneck: parts pile up in front of it and the stations behind it sit idle.',
    config: {
      ticksPerSecond: 10,
      source: { interval: 2, materialStock: 200 },
      machines: [
        { id: 'M1', stationId: 'S1', name: 'Machining',   cycleTime: 3,                   inputBufferId: 'BUF0', outputBufferId: 'BUF1' },
        { id: 'M2', stationId: 'S2', name: 'Quality Check', cycleTime: 3, rejectRate: 0.05, inputBufferId: 'BUF1', outputBufferId: 'BUF2' },
        { id: 'M3', stationId: 'S3', name: 'Assembly',          cycleTime: 18,                  inputBufferId: 'BUF2', outputBufferId: 'BUF3' },
        { id: 'M4', stationId: 'S4', name: 'Packaging',       cycleTime: 2,                   inputBufferId: 'BUF3', outputBufferId: null   },
      ],
      buffers: [
        { id: 'BUF0', capacity: 4 },
        { id: 'BUF1', capacity: 3 },
        { id: 'BUF2', capacity: 3 },
        { id: 'BUF3', capacity: 2 },
      ],
    },
  },
  {
    id: 'max-throughput',
    label: 'Maximum Throughput',
    description: 'All stations share the same short cycle time and are fed in step — the highest sustainable throughput at near-full utilization, with no bottleneck or idle time.',
    config: {
      ticksPerSecond: 10,
      source: { interval: 2, materialStock: 200 },
      machines: [
        { id: 'M1', stationId: 'S1', name: 'Machining',   cycleTime: 2,                   inputBufferId: 'BUF0', outputBufferId: 'BUF1' },
        { id: 'M2', stationId: 'S2', name: 'Quality Check', cycleTime: 2, rejectRate: 0.05, inputBufferId: 'BUF1', outputBufferId: 'BUF2' },
        { id: 'M3', stationId: 'S3', name: 'Assembly',          cycleTime: 2,                   inputBufferId: 'BUF2', outputBufferId: 'BUF3' },
        { id: 'M4', stationId: 'S4', name: 'Packaging',       cycleTime: 2,                   inputBufferId: 'BUF3', outputBufferId: null   },
      ],
      buffers: [
        { id: 'BUF0', capacity: 4 },
        { id: 'BUF1', capacity: 4 },
        { id: 'BUF2', capacity: 4 },
        { id: 'BUF3', capacity: 4 },
      ],
    },
  },
  {
    id: 'starvation',
    label: 'Material Shortage (Source)',
    description: 'The source delivers too slowly — the machines spend most of their time starved (STARVED) and standing still.',
    config: {
      ticksPerSecond: 10,
      source: { interval: 12, materialStock: 200 },
      machines: [
        { id: 'M1', stationId: 'S1', name: 'Machining',   cycleTime: 4,                   inputBufferId: 'BUF0', outputBufferId: 'BUF1' },
        { id: 'M2', stationId: 'S2', name: 'Quality Check', cycleTime: 3, rejectRate: 0.05, inputBufferId: 'BUF1', outputBufferId: 'BUF2' },
        { id: 'M3', stationId: 'S3', name: 'Assembly',          cycleTime: 4,                   inputBufferId: 'BUF2', outputBufferId: 'BUF3' },
        { id: 'M4', stationId: 'S4', name: 'Packaging',       cycleTime: 2,                   inputBufferId: 'BUF3', outputBufferId: null   },
      ],
      buffers: [
        { id: 'BUF0', capacity: 4 },
        { id: 'BUF1', capacity: 3 },
        { id: 'BUF2', capacity: 3 },
        { id: 'BUF3', capacity: 2 },
      ],
    },
  },
];

// Returns a deep clone of the named preset's config, or undefined if unknown.
// Cloning protects the registry from mutation by the engine.
export function getPreset(id) {
  const preset = PRESETS.find(p => p.id === id);
  return preset ? JSON.parse(JSON.stringify(preset.config)) : undefined;
}
