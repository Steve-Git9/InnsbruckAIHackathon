/**
 * app.js
 * Frontend logic: SSE client, SVG pipeline renderer, control panel, metrics dashboard.
 *
 * No build step, no framework — pure ES modules so you can read every line.
 * The SSE stream pushes { state, metrics } every 500 ms; we redraw the SVG and
 * update the DOM on each push.
 */

import { shouldFreezeParticles, shouldShowStartBanner } from './sim-status.js';
import { suggestionSignature } from './suggestions-view.js';

// ── Layout constants (SVG coordinate system: 0 0 1400 300) ──────────────────

const SVG_W  = 1200;
const SVG_H  = 300;

// Y-centres for the main line and the scrap branch
const MAIN_Y  = 130;
const SCRAP_Y = 240;

// Widths / heights for element shapes
const SRC_W  = 80;  const SRC_H  = 80;
const MACH_W = 110; const MACH_H = 80;
const BUF_W  = 70;  const BUF_H  = 60;
const SINK_W = 70;  const SINK_H = 70;

// Column spacing for the computed layout.
const COL_GAP = 34;   // horizontal gap between columns
const VGAP    = 16;   // vertical gap between stacked parallel machines
const X0      = 20;   // left margin

// Populated by computeLayout()/buildPipeline(): the active layout for this frame.
// { columns, pos:{ source, sink, scrap, buffers:{id->{x,y}}, machines:{id->{x,y,cx,cy}} },
//   connectors:[{ id, destBufferId, line|path geometry }], srcBufId, viewBox }
let layout = null;

// Build a left→right column layout from the simulation state. Parallel machines
// in a station stack vertically, centered on the main line.
function computeLayout(state) {
  const bufById = {};
  for (const b of state.buffers) bufById[b.id] = b;

  // The source-fed buffer is the one no machine produces.
  const produced = new Set(state.machines.map(m => m.outputBufferId).filter(id => id != null));
  const srcBuf = state.buffers.find(b => !produced.has(b.id)) ?? state.buffers[0];

  // Group machines into stations by input buffer.
  const stationByInput = {};
  for (const m of state.machines) (stationByInput[m.inputBufferId] ??= []).push(m);

  // Walk the chain: SOURCE, then [buffer, station]..., then SINK.
  const columns = [{ kind: 'source' }];
  let curId = srcBuf?.id;
  const seen = new Set();
  while (curId != null && !seen.has(curId)) {
    seen.add(curId);
    columns.push({ kind: 'buffer', buffer: bufById[curId] });
    const machines = stationByInput[curId] ?? [];
    if (machines.length === 0) break;
    columns.push({ kind: 'station', machines, stationId: machines[0].stationId });
    curId = machines[0].outputBufferId;
  }
  columns.push({ kind: 'sink' });

  const widthOf = (c) =>
    c.kind === 'source' ? SRC_W :
    c.kind === 'buffer' ? BUF_W :
    c.kind === 'station' ? MACH_W : SINK_W;

  let x = X0;
  for (const c of columns) { c.x = x; x += widthOf(c) + COL_GAP; }
  const totalW = x - COL_GAP + X0;

  const pos = { machines: {}, buffers: {}, source: null, sink: null, scrap: null };
  let minY = MAIN_Y - SRC_H / 2;
  let maxY = MAIN_Y + SRC_H / 2;

  for (const c of columns) {
    if (c.kind === 'source')  pos.source = { x: c.x };
    else if (c.kind === 'sink') pos.sink = { x: c.x };
    else if (c.kind === 'buffer') pos.buffers[c.buffer.id] = { x: c.x, y: MAIN_Y - BUF_H / 2 };
    else if (c.kind === 'station') {
      const k = c.machines.length;
      c.machines.forEach((m, j) => {
        const cy = MAIN_Y + (j - (k - 1) / 2) * (MACH_H + VGAP);
        const y  = cy - MACH_H / 2;
        pos.machines[m.id] = { x: c.x, y, cx: c.x + MACH_W / 2, cy };
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y + MACH_H);
      });
    }
  }

  // Scrap sink sits below the lowest element, under the first rejecting station.
  // There is a single shared scrap sink even when several stations are quality
  // gates; each gate still gets its own scrap connector below, the sink just
  // anchors under the first one.
  const rejectCol = columns.find(c => c.kind === 'station' && c.machines.some(m => m.rejectRate > 0));
  const scrapY = maxY + 40;
  const scrapX = rejectCol ? rejectCol.x : totalW / 2;
  pos.scrap = { x: scrapX, y: scrapY };
  maxY = scrapY + SINK_H;

  // Connectors.
  const connectors = [];
  if (pos.source && pos.buffers[srcBuf.id]) {
    connectors.push({
      id: 'conn-src-b0', destBufferId: srcBuf.id,
      x1: pos.source.x + SRC_W, y1: MAIN_Y, x2: pos.buffers[srcBuf.id].x, y2: MAIN_Y,
    });
  }
  for (const m of state.machines) {
    const mp = pos.machines[m.id];
    const inBuf = pos.buffers[m.inputBufferId];
    if (inBuf) connectors.push({
      id: `conn-in-${m.id}`, destBufferId: null,
      x1: inBuf.x + BUF_W, y1: MAIN_Y, x2: mp.x, y2: mp.cy,
    });
    if (m.outputBufferId == null) {
      connectors.push({
        id: `conn-out-${m.id}`, destBufferId: null,
        x1: mp.x + MACH_W, y1: mp.cy, x2: pos.sink.x, y2: MAIN_Y,
      });
    } else {
      const outBuf = pos.buffers[m.outputBufferId];
      if (outBuf) connectors.push({
        id: `conn-out-${m.id}`, destBufferId: m.outputBufferId,
        x1: mp.x + MACH_W, y1: mp.cy, x2: outBuf.x, y2: MAIN_Y,
      });
    }
    if (m.rejectRate > 0) {
      const sy = pos.scrap.y + SINK_H / 2;
      connectors.push({
        id: `conn-scrap-${m.id}`, destBufferId: null, isPath: true,
        d: `M ${mp.cx} ${mp.y + MACH_H} L ${mp.cx} ${sy} L ${pos.scrap.x} ${sy}`,
      });
    }
  }

  const vbY = minY - 20;
  return {
    columns, pos, connectors, srcBufId: srcBuf.id,
    viewBox: { x: 0, y: vbY, w: totalW, h: (maxY - vbY) + 20 },
  };
}

// Filled by cacheConnectorGeometry(); { connectorId -> (t) => {x, y} }
const connectorPointAt = {};
// Filled by cacheConnectorGeometry(); { connectorId -> totalLength (px) }
const connectorLength = {};

function cacheConnectorGeometry() {
  for (const { id } of layout.connectors) {
    const node = document.getElementById(id);
    if (!node) continue;

    if (node.tagName === 'line') {
      const x1 = parseFloat(node.getAttribute('x1'));
      const y1 = parseFloat(node.getAttribute('y1'));
      const x2 = parseFloat(node.getAttribute('x2'));
      const y2 = parseFloat(node.getAttribute('y2'));
      connectorLength[id]  = Math.hypot(x2 - x1, y2 - y1);
      connectorPointAt[id] = (t) => ({ x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t });
    } else {
      const len = node.getTotalLength();
      connectorLength[id]  = len;
      connectorPointAt[id] = (t) => {
        const p = node.getPointAtLength(len * t);
        return { x: p.x, y: p.y };
      };
    }
  }
}

// ── Transfer detection (pure: prev/next state -> particle spawn events) ──
// Each event: { connectorId, kind: 'good'|'scrap', count }

function detectTransfers(prev, next) {
  if (!prev || !next) return [];
  const events = [];

  // Source → source-fed buffer
  const srcDelta = (next.source?.totalGenerated ?? 0) - (prev.source?.totalGenerated ?? 0);
  if (srcDelta > 0) events.push({ connectorId: 'conn-src-b0', kind: 'good', count: srcDelta });

  const prevMach = {};
  for (const m of prev.machines) prevMach[m.id] = m;

  // Scrap is a single global counter; split this frame's scrap across the
  // rejecting machines proportionally to how many parts each processed.
  const scrapDelta = (next.scrap?.partsReceived ?? 0) - (prev.scrap?.partsReceived ?? 0);
  const rejectDeltas = {};
  let sumReject = 0;
  for (const m of next.machines) {
    if (m.rejectRate > 0) {
      const d = Math.max(0, m.partsProcessed - (prevMach[m.id]?.partsProcessed ?? 0));
      rejectDeltas[m.id] = d;
      sumReject += d;
    }
  }

  for (const m of next.machines) {
    const pm = prevMach[m.id];

    // Pull animation: a new part entered this machine (currentPartId changed).
    if (m.currentPartId != null && pm && pm.currentPartId !== m.currentPartId) {
      events.push({ connectorId: `conn-in-${m.id}`, kind: 'good', count: 1 });
    }

    const dProcessed = m.partsProcessed - (pm?.partsProcessed ?? 0);
    if (dProcessed <= 0) continue;

    if (m.rejectRate > 0) {
      const myScrap = sumReject > 0 ? Math.round(scrapDelta * (rejectDeltas[m.id] / sumReject)) : 0;
      const myGood  = Math.max(0, dProcessed - myScrap);
      if (myScrap > 0) events.push({ connectorId: `conn-scrap-${m.id}`, kind: 'scrap', count: myScrap });
      if (myGood  > 0) events.push({ connectorId: `conn-out-${m.id}`,   kind: 'good',  count: myGood });
    } else {
      events.push({ connectorId: `conn-out-${m.id}`, kind: 'good', count: dProcessed });
    }
  }

  return events;
}

// ── Status descriptions (short, human-readable) ──────────────────────────────
const STATE_DESCRIPTION = {
  PROCESSING: 'Processing',
  IDLE:       'Idle',
  STARVED:    'Starved',
  BLOCKED:    'Blocked',
};

// ── State ────────────────────────────────────────────────────────────────────

let lastState   = null;
let lastMetrics = null;
let prevStateForDiff = null;
let selectedMachineId = null;   // null = panel closed; otherwise 'M1'..'M4'

const sparklineData = [];   // rolling window of throughput values
const SPARKLINE_LEN = 60;

// ── SVG helpers ──────────────────────────────────────────────────────────────

const svg = document.getElementById('pipeline-svg');

function el(tag, attrs = {}) {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function txt(content, attrs = {}) {
  const t = el('text', { 'font-family': 'monospace', 'font-size': '11', fill: '#e2e8f0', ...attrs });
  t.textContent = content;
  return t;
}

// ── Initial SVG draw (static skeleton) ───────────────────────────────────────
// We draw the structure once; dynamic parts get IDs and are updated every frame.

function buildPipeline(state) {
  svg.innerHTML = '';   // clear on reset / structure change

  layout = computeLayout(state);
  const vb = layout.viewBox;
  svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);

  // ── Connectors ─────────────────────────────────────────────────────────────
  for (const c of layout.connectors) {
    const node = c.isPath
      ? el('path', { id: c.id, d: c.d, class: 'pipe-connector' })
      : el('line', { id: c.id, x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2, class: 'pipe-connector' });
    svg.appendChild(node);
  }

  // ── Particle overlay (above connectors, below stations) ─────────────────────
  const defs = el('defs');
  const glow = el('filter', { id: 'part-glow', x: '-50%', y: '-50%', width: '200%', height: '200%' });
  glow.appendChild(el('feGaussianBlur', { stdDeviation: '2.2' }));
  defs.appendChild(glow);
  svg.appendChild(defs);

  const particleLayer = el('g', { id: 'particle-layer', filter: 'url(#part-glow)' });
  svg.appendChild(particleLayer);

  cacheConnectorGeometry();

  particlePool = [];
  particles    = [];
  ensureParticleNodes(32);
  startParticleLoop();

  // ── Stations / buffers / endpoints ──────────────────────────────────────────
  drawSource(layout.pos.source);
  for (const b of state.buffers) drawBuffer(b, layout.pos.buffers[b.id]);
  for (const m of state.machines) drawMachine(m, layout.pos.machines[m.id]);
  drawSink(layout.pos.sink);
  drawScrapSink(layout.pos.scrap);
}

// ─── Draw helpers ─────────────────────────────────────────────────────────────

function drawSource(p) {
  const x = p.x;
  const y = MAIN_Y - SRC_H / 2;
  const g = el('g', { id: 'elem-SOURCE' });

  g.appendChild(el('rect', { x, y, width: SRC_W, height: SRC_H, rx: 6,
    fill: '#1a1d27', stroke: '#4f46e5', 'stroke-width': 1.5 }));
  g.appendChild(el('rect', { id: 'src-stock-bg', x: x + 8, y: y + SRC_H - 20, width: SRC_W - 16, height: 10,
    rx: 3, fill: '#252836' }));
  g.appendChild(el('rect', { id: 'src-stock-fill', x: x + 8, y: y + SRC_H - 20, width: SRC_W - 16, height: 10,
    rx: 3, fill: '#6366f1' }));
  g.appendChild(txt('SOURCE', { x: x + SRC_W / 2, y: y + 18, 'text-anchor': 'middle', 'font-size': '10', fill: '#818cf8' }));
  g.appendChild(txt('', { id: 'src-stock-text', x: x + SRC_W / 2, y: y + 38, 'text-anchor': 'middle', 'font-size': '11' }));

  svg.appendChild(g);
}

function drawBuffer(buf, p) {
  const id = buf.id, x = p.x, y = p.y;
  const g = el('g', { id: `elem-${id}` });

  g.appendChild(el('rect', { x, y, width: BUF_W, height: BUF_H, rx: 5,
    fill: '#1a1d27', stroke: '#2e3347', 'stroke-width': 1.2 }));
  g.appendChild(txt(id, { x: x + BUF_W / 2, y: y + 13, 'text-anchor': 'middle', 'font-size': '9', fill: '#64748b' }));
  g.appendChild(txt('0/0', { id: `buf-load-${id}`, x: x + BUF_W / 2, y: y + BUF_H - 5, 'text-anchor': 'middle', 'font-size': '10' }));
  g.appendChild(el('g', { id: `buf-slots-${id}` }));

  svg.appendChild(g);
}

function drawMachine(m, p) {
  const id = m.id, name = m.name;
  const x = p.x, y = p.y;
  const g = el('g', { id: `elem-${id}` });
  g.addEventListener('click', () => openMachineDetail(id));

  g.appendChild(el('rect', { id: `mach-rect-${id}`, x, y, width: MACH_W, height: MACH_H,
    rx: 8, class: 'machine-rect IDLE', fill: '#1a1d27', stroke: '#2e3347', 'stroke-width': 1.5 }));

  const shortName = name.length > 17 ? name.slice(0, 16) + '…' : name;
  g.appendChild(txt(shortName, { x: x + MACH_W / 2, y: y + 11, 'text-anchor': 'middle',
    'font-size': '9.5', fill: '#94a3b8' }));
  g.appendChild(txt(id, { x: x + MACH_W / 2, y: y + 22, 'text-anchor': 'middle',
    'font-size': '9', fill: '#64748b' }));

  // Progress arc (circle)
  const cx = x + MACH_W / 2;
  const cy = y + MACH_H / 2 + 6;
  const r  = 20;
  const circ = 2 * Math.PI * r;

  // Background circle
  g.appendChild(el('circle', { cx, cy, r, fill: 'none', stroke: '#252836', 'stroke-width': 4 }));

  // Progress arc — dasharray trick: stroke-dashoffset controls how much is shown
  const arc = el('circle', {
    id: `mach-arc-${id}`, cx, cy, r, fill: 'none',
    stroke: '#22c55e', 'stroke-width': 4,
    'stroke-dasharray': circ.toFixed(2),
    'stroke-dashoffset': circ.toFixed(2),  // 0% progress initially
    transform: `rotate(-90 ${cx} ${cy})`,  // start arc at 12 o'clock
  });
  g.appendChild(arc);

  // Utilization % inside the circle
  g.appendChild(txt('0%', { id: `mach-util-${id}`, cx, cy,
    x: cx, y: cy + 4, 'text-anchor': 'middle', 'font-size': '9', fill: '#94a3b8' }));

  // State badge (bottom-left of machine rect)
  g.appendChild(el('rect', { id: `mach-badge-bg-${id}`, x: x + 4, y: y + MACH_H - 18, width: 50, height: 14,
    rx: 7, fill: '#1e293b' }));
  g.appendChild(txt('IDLE', { id: `mach-badge-${id}`, x: x + 29, y: y + MACH_H - 7,
    'text-anchor': 'middle', 'font-size': '8', fill: '#94a3b8' }));

  // Bottleneck marker (hidden by default — shown when this machine is the bottleneck)
  const bnG = el('g', { id: `mach-bn-${id}`, class: 'mach-bn-marker', visibility: 'hidden' });
  const badgeW = 78;
  const badgeH = 18;
  const badgeX = x + MACH_W / 2 - badgeW / 2;
  const badgeY = y - badgeH - 10;            // sits above the machine
  bnG.appendChild(el('rect', {
    x: badgeX, y: badgeY, width: badgeW, height: badgeH, rx: 9,
    fill: '#7c2d12', stroke: '#f97316', 'stroke-width': 1.2,
  }));
  // Warning glyph + label
  bnG.appendChild(txt('⚠ BOTTLENECK', {
    x: x + MACH_W / 2, y: badgeY + badgeH - 5,
    'text-anchor': 'middle', 'font-size': '10', 'font-weight': '700',
    fill: '#fdba74', 'font-family': 'Inter, system-ui, sans-serif',
  }));
  // Arrow pointing down to the machine
  const arrowTopY = badgeY + badgeH;
  const arrowTipY = y - 1;
  const arrowCx   = x + MACH_W / 2;
  bnG.appendChild(el('polygon', {
    points: `${arrowCx - 5},${arrowTopY} ${arrowCx + 5},${arrowTopY} ${arrowCx},${arrowTipY}`,
    fill: '#f97316',
  }));
  g.appendChild(bnG);

  svg.appendChild(g);
}

function drawSink(p) {
  const x = p.x, y = MAIN_Y - SINK_H / 2;
  const g = el('g', { id: 'elem-SINK' });
  g.appendChild(el('rect', { x, y, width: SINK_W, height: SINK_H, rx: 6,
    fill: '#1a1d27', stroke: '#22c55e', 'stroke-width': 1.5 }));
  g.appendChild(txt('SINK', { x: x + SINK_W / 2, y: y + 16, 'text-anchor': 'middle', 'font-size': '10', fill: '#86efac' }));
  g.appendChild(txt('0', { id: 'sink-count', x: x + SINK_W / 2, y: y + 40, 'text-anchor': 'middle',
    'font-size': '20', fill: '#22c55e', 'font-weight': 'bold' }));
  g.appendChild(txt('parts', { x: x + SINK_W / 2, y: y + SINK_H - 6, 'text-anchor': 'middle', 'font-size': '9', fill: '#4ade80' }));
  svg.appendChild(g);
}

function drawScrapSink(p) {
  const x = p.x, y = p.y;
  const g = el('g', { id: 'elem-SCRAP' });
  g.appendChild(el('rect', { x, y, width: SINK_W, height: SINK_H, rx: 6,
    fill: '#1a1d27', stroke: '#ef4444', 'stroke-width': 1.5 }));
  g.appendChild(txt('SCRAP', { x: x + SINK_W / 2, y: y + 16, 'text-anchor': 'middle', 'font-size': '10', fill: '#f87171' }));
  g.appendChild(txt('0', { id: 'scrap-count', x: x + SINK_W / 2, y: y + 40, 'text-anchor': 'middle',
    'font-size': '20', fill: '#ef4444', 'font-weight': 'bold' }));
  g.appendChild(txt('scrapped', { x: x + SINK_W / 2, y: y + SINK_H - 6, 'text-anchor': 'middle', 'font-size': '9', fill: '#fca5a5' }));
  g.appendChild(txt('', { id: 'scrap-rate-label', x: x + SINK_W / 2, y: y - 6, 'text-anchor': 'middle', 'font-size': '10', fill: '#f87171' }));
  svg.appendChild(g);
}

// ── Dynamic update: redraw state each frame ───────────────────────────────────

function updatePipeline(state, metrics) {
  if (!state) return;

  // ── Source ─────────────────────────────────────────────────────────────────
  const src         = state.source;
  const stockFill   = document.getElementById('src-stock-fill');
  const stockText   = document.getElementById('src-stock-text');
  const initialStock = 200; // keep in sync with DEFAULT_CONFIG — used for bar scaling

  if (stockFill) {
    const ratio = src.materialStock < 0 ? 1 : Math.min(src.materialStock / initialStock, 1);   // -1 = infinite
    const maxW  = SRC_W - 16;
    stockFill.setAttribute('width', (ratio * maxW).toFixed(1));
    stockFill.setAttribute('fill', ratio > 0.3 ? '#6366f1' : ratio > 0.1 ? '#f59e0b' : '#ef4444');
  }
  if (stockText) {
    stockText.textContent = stockLabel(src.materialStock);
  }

  // ── Buffers ────────────────────────────────────────────────────────────────
  for (const buf of state.buffers) {
    updateBufferSlots(buf);
  }

  // ── Machines ───────────────────────────────────────────────────────────────
  const metricsMap = {};
  if (metrics && metrics.machines) {
    for (const m of metrics.machines) metricsMap[m.id] = m;
  }

  for (const m of state.machines) {
    updateMachine(m, metricsMap[m.id]);
  }

  // ── Connector colours (blocked = destination buffer full) ──────────────────
  const bufMap = {};
  for (const b of state.buffers) bufMap[b.id] = b;
  for (const c of layout.connectors) {
    if (!c.destBufferId) continue;
    const buf = bufMap[c.destBufferId];
    setConnectorBlocked(c.id, !!buf && buf.load >= buf.capacity);
  }

  // ── Sink / Scrap counts ────────────────────────────────────────────────────
  setTextContent('sink-count',  state.sink.partsReceived);
  setTextContent('scrap-count', state.scrap.partsReceived);

  // Per-machine reject rates are shown in each machine's detail panel; the
  // shared scrap sink no longer carries a single rate label.
  setTextContent('scrap-rate-label', '');

  // ── Machine detail panel (if open) ─────────────────────────────────────────
  updateMachineDetail();

  // ── Header tick ────────────────────────────────────────────────────────────
  setTextContent('tick-counter', state.tick);
  // Simulated elapsed time in seconds = ticks / ticksPerSecond (independent of the
  // wall-clock speed multiplier). Falls back to 10 tps if the field is absent.
  const tps = state.ticksPerSecond || 10;
  setTextContent('time-counter', (state.tick / tps).toFixed(1));
  const dot   = document.getElementById('status-dot');
  const label = document.getElementById('status-label');
  if (dot && label) {
    if (state.running) {
      dot.className   = 'status-dot running';
      label.textContent = 'Running';
    } else {
      dot.className   = 'status-dot';
      label.textContent = 'Paused';
    }
  }

  // ── Start banner (shown only before the run has begun) ──────────────────────
  const startBanner = document.getElementById('start-banner');
  if (startBanner) startBanner.hidden = !shouldShowStartBanner(state);
}

function updateBufferSlots(buf) {
  const slotGroup = document.getElementById(`buf-slots-${buf.id}`);
  const loadLabel = document.getElementById(`buf-load-${buf.id}`);
  if (!slotGroup) return;

  if (loadLabel) loadLabel.textContent = `${buf.load}/${buf.capacity}`;

  // Rebuild slots (capacity might have changed via slider)
  slotGroup.innerHTML = '';
  const cap   = buf.capacity;
  const bp    = layout?.pos.buffers[buf.id];
  if (!bp) return;
  const elemX = bp.x;
  const elemY = bp.y;

  // Determine slot sizing to fit within buffer box
  const slotSize = Math.min(14, (BUF_W - 10) / cap - 3);
  const totalW   = cap * slotSize + (cap - 1) * 3;
  const startX   = elemX + (BUF_W - totalW) / 2;
  const slotY    = elemY + BUF_H / 2 - slotSize / 2 - 4;

  const fillRatio = cap > 0 ? buf.load / cap : 0;

  for (let i = 0; i < cap; i++) {
    const occupied = i < buf.load;
    const sx = startX + i * (slotSize + 3);
    let cls = occupied ? 'buf-slot-full' : 'buf-slot-empty';
    if (occupied && fillRatio > 0.99) cls += ' alert';
    else if (occupied && fillRatio > 0.75) cls += ' warn';

    slotGroup.appendChild(el('rect', {
      x: sx, y: slotY, width: slotSize, height: slotSize, rx: 2, class: cls,
    }));
  }
}

function updateMachine(m, mMetrics) {
  const arcEl    = document.getElementById(`mach-arc-${m.id}`);
  const badgeEl  = document.getElementById(`mach-badge-${m.id}`);
  const badgeBg  = document.getElementById(`mach-badge-bg-${m.id}`);
  const utilEl   = document.getElementById(`mach-util-${m.id}`);
  const rectEl   = document.getElementById(`mach-rect-${m.id}`);

  if (!arcEl) return;

  // Progress arc: stroke-dashoffset goes from full-circumference (0%) to 0 (100%)
  const r    = 20;
  const circ = 2 * Math.PI * r;
  const progress = m.cycleTime > 0 ? 1 - (m.ticksLeft / m.cycleTime) : 0;
  const offset   = circ * (1 - Math.max(0, Math.min(1, progress)));
  arcEl.setAttribute('stroke-dashoffset', offset.toFixed(2));

  // Arc colour by state
  const arcColours = { PROCESSING: '#22c55e', IDLE: '#2e3347', STARVED: '#f59e0b', BLOCKED: '#ef4444' };
  arcEl.setAttribute('stroke', arcColours[m.state] ?? '#2e3347');

  // State badge
  if (badgeEl) {
    badgeEl.textContent = m.state;
    const textColours = { PROCESSING: '#86efac', IDLE: '#94a3b8', STARVED: '#fde68a', BLOCKED: '#fca5a5' };
    badgeEl.setAttribute('fill', textColours[m.state] ?? '#94a3b8');
  }
  if (badgeBg) {
    const bgColours = { PROCESSING: '#166534', IDLE: '#1e293b', STARVED: '#713f12', BLOCKED: '#7f1d1d' };
    badgeBg.setAttribute('fill', bgColours[m.state] ?? '#1e293b');
  }

  // Machine rect stroke by state + bottleneck + selection
  const isBottleneck = mMetrics?.bottleneck ?? false;
  const bnMarker = document.getElementById(`mach-bn-${m.id}`);
  if (bnMarker) bnMarker.setAttribute('visibility', isBottleneck ? 'visible' : 'hidden');

  if (rectEl) {
    const isSelected   = selectedMachineId === m.id;
    let stateClass = `machine-rect ${m.state}`;
    if (isBottleneck) stateClass = 'machine-rect bottleneck';
    if (isSelected)   stateClass += ' selected';
    rectEl.setAttribute('class', stateClass);
    const strokeColours = { PROCESSING: '#22c55e', IDLE: '#2e3347', STARVED: '#f59e0b', BLOCKED: '#ef4444' };
    const baseStroke   = isBottleneck ? '#f97316' : (strokeColours[m.state] ?? '#2e3347');
    rectEl.setAttribute('stroke', isSelected ? '#818cf8' : baseStroke);
  }

  // Utilization
  if (utilEl && mMetrics) {
    utilEl.textContent = (mMetrics.utilization * 100).toFixed(0) + '%';
  }
}

// ── Machine detail panel ─────────────────────────────────────────────────────

function openMachineDetail(id) {
  selectedMachineId = id;
  const panel = document.getElementById('machine-detail');
  if (panel) panel.hidden = false;

  // Wire the reject-rate slider once; it always targets the selected machine.
  const rejectSlider = document.getElementById('md-reject-slider');
  if (rejectSlider && !rejectSlider.dataset.wired) {
    rejectSlider.dataset.wired = '1';
    rejectSlider.addEventListener('input', e => {
      const v = parseInt(e.target.value, 10);
      const valEl = document.getElementById('md-reject-val');
      if (valEl) valEl.textContent = v + '%';
      if (selectedMachineId) postControl({ machineId: selectedMachineId, rejectRate: v / 100 });
    });
  }

  // Push an immediate render so the panel populates before the next SSE frame
  updateMachineDetail();
  if (lastState) {
    // Re-run machine rect update so the selection ring appears immediately
    const metricsMap = {};
    if (lastMetrics?.machines) for (const m of lastMetrics.machines) metricsMap[m.id] = m;
    for (const m of lastState.machines) updateMachine(m, metricsMap[m.id]);
  }
}

function closeMachineDetail() {
  const prev = selectedMachineId;
  selectedMachineId = null;
  const panel = document.getElementById('machine-detail');
  if (panel) panel.hidden = true;
  if (prev && lastState) {
    const metricsMap = {};
    if (lastMetrics?.machines) for (const m of lastMetrics.machines) metricsMap[m.id] = m;
    for (const m of lastState.machines) updateMachine(m, metricsMap[m.id]);
  }
}

function updateMachineDetail() {
  if (!selectedMachineId || !lastState) return;
  const panel = document.getElementById('machine-detail');
  if (!panel || panel.hidden) return;

  const m = lastState.machines.find(x => x.id === selectedMachineId);
  if (!m) return;
  const removeBtn = document.getElementById('md-remove');
  if (removeBtn) {
    const stationMachines = lastState.machines.filter(x => x.stationId === m.stationId);
    // The original (first-listed) station machine cannot be removed.
    removeBtn.disabled = stationMachines.length <= 1 || stationMachines[0].id === m.id;
  }
  const mm = lastMetrics?.machines?.find(x => x.id === selectedMachineId);

  setTextContent('md-id',   m.id);
  setTextContent('md-name', m.name);

  const bn = document.getElementById('md-bottleneck');
  if (bn) bn.hidden = !(mm?.bottleneck);

  const stateEl = document.getElementById('md-state');
  if (stateEl) {
    stateEl.textContent = m.state;
    stateEl.className   = `state-badge state-${m.state}`;
  }
  setTextContent('md-state-desc', STATE_DESCRIPTION[m.state] ?? '');

  setTextContent('md-part', m.currentPartId != null ? `#${m.currentPartId}` : '—');

  // Cycle progress
  const elapsed = m.cycleTime - m.ticksLeft;
  setTextContent('md-cycle-text', `${Math.max(0, elapsed)} / ${m.cycleTime} ticks`);
  const fill = document.getElementById('md-cycle-fill');
  if (fill) {
    const ratio = m.cycleTime > 0 ? Math.max(0, Math.min(1, elapsed / m.cycleTime)) : 0;
    fill.style.width = (ratio * 100).toFixed(1) + '%';
    const fillColours = { PROCESSING: '#22c55e', IDLE: '#64748b', STARVED: '#f59e0b', BLOCKED: '#ef4444' };
    fill.style.background = fillColours[m.state] ?? '#64748b';
  }

  // Stats
  setTextContent('md-util',      ((mm?.utilization ?? 0) * 100).toFixed(1) + '%');
  setTextContent('md-processed', m.partsProcessed);
  setTextContent('md-wait',      (mm?.avgQueueWait ?? 0).toFixed(1) + ' ticks');

  // Quality gate: editable reject-rate slider, shown for every machine.
  const rejectSlider = document.getElementById('md-reject-slider');
  const rejectValEl  = document.getElementById('md-reject-val');
  const pct = Math.round((m.rejectRate ?? 0) * 100);
  if (rejectValEl) rejectValEl.textContent = pct + '%';
  if (rejectSlider && document.activeElement !== rejectSlider) {
    rejectSlider.value = pct;
  }

  // Time breakdown stacked bar
  const total = m.ticksProcessing + m.ticksBlocked + m.ticksStarved + m.ticksIdle;
  setTextContent('md-total-ticks', `${total} ticks`);
  const segs = {
    processing: total > 0 ? m.ticksProcessing / total : 0,
    blocked:    total > 0 ? m.ticksBlocked    / total : 0,
    starved:    total > 0 ? m.ticksStarved    / total : 0,
    idle:       total > 0 ? m.ticksIdle       / total : 0,
  };
  const stack = document.getElementById('md-stack');
  if (stack) {
    stack.children[0].style.width = (segs.processing * 100).toFixed(2) + '%';
    stack.children[1].style.width = (segs.blocked    * 100).toFixed(2) + '%';
    stack.children[2].style.width = (segs.starved    * 100).toFixed(2) + '%';
    stack.children[3].style.width = (segs.idle       * 100).toFixed(2) + '%';
  }
  setTextContent('md-pct-processing', (segs.processing * 100).toFixed(0) + '%');
  setTextContent('md-pct-blocked',    (segs.blocked    * 100).toFixed(0) + '%');
  setTextContent('md-pct-starved',    (segs.starved    * 100).toFixed(0) + '%');
  setTextContent('md-pct-idle',       (segs.idle       * 100).toFixed(0) + '%');
}

function setConnectorBlocked(id, blocked) {
  const el = document.getElementById(id);
  if (!el) return;
  el.setAttribute('class', blocked ? 'pipe-connector blocked' : 'pipe-connector');
  el.setAttribute('stroke', blocked ? '#ef4444' : '#2e3347');
}

function setTextContent(id, value) {
  const e = document.getElementById(id);
  if (e) e.textContent = value;
}

// ── Metrics dashboard update ──────────────────────────────────────────────────

function updateMetricsDashboard(metrics, state) {
  if (!metrics) return;

  setTextContent('m-throughput',  metrics.throughput.toFixed(1));
  setTextContent('m-leadtime',    metrics.avgLeadTime.toFixed(1));
  setTextContent('m-in-system',   metrics.partsInSystem);
  setTextContent('m-scrapped',    metrics.scrappedParts);

  const lt = metrics.leadTimeStats;
  if (lt) {
    setTextContent('m-leadtime-spread', `p50 ${lt.p50} · p95 ${lt.p95} · σ ${lt.stdDev}`);
  }
  // Flow efficiency as a percentage (value-added ratio).
  setTextContent('m-flow-efficiency', `${(metrics.flowEfficiency * 100).toFixed(0)}%`);

  // Sparkline data — only advance while running so the chart freezes on pause
  if (state && state.running) {
    sparklineData.push(metrics.throughput);
    if (sparklineData.length > SPARKLINE_LEN) sparklineData.shift();
    drawSparkline();
  }

  // Machine table
  const tbody = document.getElementById('machine-table-body');
  if (!tbody || !metrics.machines) return;
  tbody.innerHTML = '';

  for (const m of orderedMachines(metrics.machines)) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${m.id}</strong> — ${m.name}${m.bottleneck ? '<span class="bottleneck-badge">Bottleneck</span>' : ''}</td>
      <td><span class="state-badge state-${m.currentState}">${m.currentState}</span> <span class="state-desc">${STATE_DESCRIPTION[m.currentState] ?? ''}</span></td>
      <td>${(m.utilization * 100).toFixed(1)}%</td>
      <td>${m.throughput.toFixed(1)}</td>
      <td>${m.avgQueueWait.toFixed(1)} ticks</td>
      <td>${m.blockedTime} ticks</td>
      <td>${m.starvedTime} ticks</td>
      <td>${m.bottleneck ? '&#9888; Yes' : '—'}</td>
    `;
    tbody.appendChild(tr);
  }
}

// ── Sparkline canvas chart ─────────────────────────────────────────────────────

function drawSparkline() {
  const canvas = document.getElementById('sparkline');
  if (!canvas) return;
  const ctx    = canvas.getContext('2d');
  const W      = canvas.offsetWidth;
  const H      = canvas.offsetHeight;
  canvas.width  = W;
  canvas.height = H;

  ctx.clearRect(0, 0, W, H);

  if (sparklineData.length < 2) return;

  const max  = Math.max(...sparklineData, 1);
  const step = W / (SPARKLINE_LEN - 1);

  ctx.beginPath();
  ctx.strokeStyle = '#6366f1';
  ctx.lineWidth   = 2;
  ctx.lineJoin    = 'round';

  for (let i = 0; i < sparklineData.length; i++) {
    const x = i * step;
    const y = H - (sparklineData[i] / max) * (H - 4) - 2;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Fill area under the line
  ctx.lineTo((sparklineData.length - 1) * step, H);
  ctx.lineTo(0, H);
  ctx.closePath();
  ctx.fillStyle = 'rgba(99,102,241,0.15)';
  ctx.fill();
}

// ── Particle engine ───────────────────────────────────────────────────────
// In-flight particles travelling between stations. Driven by rAF.

const PARTICLE_DURATION_MS = 400;   // travel time at 1× sim speed
const PARTICLE_RADIUS      = 3.5;
const POOL_GROWTH          = 16;
const POOL_MAX_SIZE        = 256;

let particleSimState = null;   // latest server snapshot, used for jam checks
let particleSimPaused = false;
let particlePool = [];      // { node: <circle> head, tail: <circle>, inUse: boolean }
let particles    = [];      // active Particle objects
let lastFrameTs  = 0;
let rafHandle    = null;

function ensureParticleNodes(n) {
  const layer = document.getElementById('particle-layer');
  while (particlePool.length < n) {
    const tail = el('circle', { r: PARTICLE_RADIUS * 1.6, class: 'particle-tail hidden' });
    const head = el('circle', { r: PARTICLE_RADIUS,         class: 'particle hidden' });
    layer.appendChild(tail);
    layer.appendChild(head);   // head drawn over tail
    particlePool.push({ node: head, tail, inUse: false });
  }
}

function acquireParticleNode() {
  for (const slot of particlePool) {
    if (!slot.inUse) {
      slot.inUse = true;
      slot.node.classList.remove('hidden');
      slot.tail.classList.remove('hidden');
      return slot;
    }
  }
  if (particlePool.length >= POOL_MAX_SIZE) return null;
  ensureParticleNodes(Math.min(POOL_MAX_SIZE, particlePool.length + POOL_GROWTH));
  return acquireParticleNode();
}

function releaseParticleNode(slot) {
  slot.inUse = false;
  slot.node.classList.add('hidden');
  slot.tail.classList.add('hidden');
}

function isDestBufferFull(connectorId) {
  if (!particleSimState || !layout) return false;
  const conn = layout.connectors.find(c => c.id === connectorId);
  if (!conn || !conn.destBufferId) return false;
  const buf = particleSimState.buffers.find(b => b.id === conn.destBufferId);
  return buf ? buf.load >= buf.capacity : false;
}

function spawnParticle({ connectorId, kind, delayMs = 0 }) {
  if (!connectorPointAt[connectorId]) return;
  const slot = acquireParticleNode();
  if (!slot) return;   // pool exhausted; drop this spawn
  if (kind === 'scrap') slot.node.classList.add('scrap');
  else                  slot.node.classList.remove('scrap');
  if (kind === 'scrap') slot.tail.classList.add('scrap');
  else                  slot.tail.classList.remove('scrap');

  const now = performance.now();
  particles.push({
    slot,
    connectorId,
    kind,
    startedAt: now + delayMs,
    duration:  PARTICLE_DURATION_MS,
  });
}

function spawnFromEvents(events) {
  for (const ev of events) {
    for (let i = 0; i < ev.count; i++) {
      spawnParticle({
        connectorId: ev.connectorId,
        kind: ev.kind,
        delayMs: i * 80,    // stagger when multiple in one frame
      });
    }
  }
}

function advanceParticles(now) {
  if (particles.length === 0) return;

  // Group jammed particles per-connector so we can assign stack indexes.
  const jamStackCounters = {};   // connectorId -> next stackIndex

  // Walk in spawn order (oldest first) so older particles sit deeper
  // into the jam (closer to the buffer wall).
  for (let i = 0; i < particles.length; i++) {
    const p   = particles[i];
    const fn  = connectorPointAt[p.connectorId];
    if (!fn) {
      releaseParticleNode(p.slot);
      particles.splice(i, 1);
      i--;
      continue;
    }

    const raw = (now - p.startedAt) / p.duration;
    let   t   = Math.max(0, Math.min(1, raw));

    const blocked = isDestBufferFull(p.connectorId);
    if (blocked && t > 0.85) {
      const idx = jamStackCounters[p.connectorId] ?? 0;
      jamStackCounters[p.connectorId] = idx + 1;
      // Older particles get smaller idx -> sit closer to the buffer.
      t = Math.max(0.55, 0.85 - idx * 0.06);
      p.jammed = true;
    } else {
      p.jammed = false;
    }

    const pt = fn(t);
    p.slot.node.setAttribute('cx', pt.x.toFixed(2));
    p.slot.node.setAttribute('cy', pt.y.toFixed(2));
    const tailT = Math.max(0, t - 0.08);
    const tailPt = fn(tailT);
    p.slot.tail.setAttribute('cx', tailPt.x.toFixed(2));
    p.slot.tail.setAttribute('cy', tailPt.y.toFixed(2));
  }

  // Retire un-jammed particles that finished traveling.
  for (let i = particles.length - 1; i >= 0; i--) {
    const p   = particles[i];
    const raw = (performance.now() - p.startedAt) / p.duration;
    if (!p.jammed && raw >= 1) {
      releaseParticleNode(p.slot);
      particles.splice(i, 1);
    }
  }
}

function particleLoop(ts) {
  const dt = lastFrameTs > 0 ? ts - lastFrameTs : 0;
  lastFrameTs = ts;

  if (particleSimPaused && dt > 0) {
    // Freeze: roll every active particle's clock forward by dt.
    for (const p of particles) p.startedAt += dt;
  }

  advanceParticles(ts);
  rafHandle = requestAnimationFrame(particleLoop);
}

function startParticleLoop() {
  if (rafHandle != null) return;
  rafHandle = requestAnimationFrame(particleLoop);
}

function resetParticles() {
  for (const p of particles) releaseParticleNode(p.slot);
  particles = [];
}

// ── Spawn suggestion banner ─────────────────────────────────────────────────

// Escape a generated string for safe interpolation into an HTML attribute value.
function escapeAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

let lastSuggestionSig = null;

function updateSuggestionBanner(metrics) {
  const banner = document.getElementById('suggestion-banner');
  if (!banner) return;
  const suggestions = metrics?.suggestions ?? [];

  // Skip the rebuild when the set of suggestions is structurally unchanged, so
  // the spawn button isn't destroyed and recreated every SSE frame (which would
  // eat clicks that land mid-rebuild). Live numbers in the tooltip refresh on
  // the next structural change.
  const sig = suggestionSignature(suggestions);
  if (sig === lastSuggestionSig) return;
  lastSuggestionSig = sig;

  if (suggestions.length === 0) {
    banner.hidden = true;
    banner.innerHTML = '';
    return;
  }
  banner.hidden = false;
  banner.innerHTML = suggestions.map((s, i) => {
    if (s.type === 'no-internal-constraint') {
      return `<div class="sg-row sg-note">` +
        `<span class="sg-text">ℹ ${s.reason}</span>` +
      `</div>`;
    }
    return `<div class="sg-row">` +
      `<span class="sg-text">⚠ ${s.label} <span class="info-icon" data-tip="${escapeAttr(s.reason)}">i</span></span>` +
      `<button class="sg-btn" data-station="${s.stationId}" data-idx="${i}" type="button">+ Add parallel machine</button>` +
    `</div>`;
  }).join('');
  banner.querySelectorAll('.sg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      postControl({ stationId: btn.dataset.station }, 'spawnMachine');
    });
  });
}

// Group machines by station in pipeline (first-appearance) order, sorted within
// a station by id, so parallel machines (M3, M3b, M3c) stay together instead of
// appearing in raw config order (where spawns are appended after later stations).
// Assumes the original station machines appear in pipeline order in the array
// (true for the current linear config); for a non-linear line, derive order from
// the buffer chain instead (see engine.js _assignStationOrder).
function orderedMachines(machines) {
  const stationFirstIndex = new Map();
  machines.forEach((m, i) => {
    if (!stationFirstIndex.has(m.stationId)) stationFirstIndex.set(m.stationId, i);
  });
  return [...machines].sort((a, b) => {
    const sa = stationFirstIndex.get(a.stationId);
    const sb = stationFirstIndex.get(b.stationId);
    return sa !== sb ? sa - sb : a.id.localeCompare(b.id);
  });
}

// ── Control panel ─────────────────────────────────────────────────────────────

function buildControlSliders(state) {
  // Machine cycle time sliders
  const machineSliders = document.getElementById('machine-sliders');
  // Remove all children except the label span
  [...machineSliders.children].forEach(c => {
    if (!c.classList.contains('section-label')) c.remove();
  });

  for (const m of orderedMachines(state.machines)) {
    const div = document.createElement('div');
    div.className = 'slider-group';
    div.innerHTML = `
      <label>${m.id} cycle time <span id="val-ct-${m.id}">${m.cycleTime}</span></label>
      <input type="range" id="ct-${m.id}" min="1" max="15" step="1" value="${m.cycleTime}" />
    `;
    machineSliders.appendChild(div);
    div.querySelector('input').addEventListener('input', e => {
      const v = parseInt(e.target.value, 10);
      document.getElementById(`val-ct-${m.id}`).textContent = v;
      postControl({ machineId: m.id, cycleTime: v });
    });
  }

  // Buffer capacity sliders
  const bufferSliders = document.getElementById('buffer-sliders');
  [...bufferSliders.children].forEach(c => {
    if (!c.classList.contains('section-label')) c.remove();
  });

  for (const b of state.buffers) {
    const div = document.createElement('div');
    div.className = 'slider-group';
    div.innerHTML = `
      <label>${b.id} capacity <span id="val-cap-${b.id}">${b.capacity}</span></label>
      <input type="range" id="cap-${b.id}" min="1" max="10" step="1" value="${b.capacity}" />
    `;
    bufferSliders.appendChild(div);
    div.querySelector('input').addEventListener('input', e => {
      const v = parseInt(e.target.value, 10);
      document.getElementById(`val-cap-${b.id}`).textContent = v;
      postControl({ bufferId: b.id, bufferCapacity: v });
    });
  }
}

// ── API calls ─────────────────────────────────────────────────────────────────

async function postControl(params, action) {
  try {
    await fetch('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, params }),
    });
  } catch (e) {
    console.error('control error', e);
  }
}

// ── Event wiring ──────────────────────────────────────────────────────────────

document.getElementById('btn-play').addEventListener('click', () => postControl({}, 'play'));
document.getElementById('btn-pause').addEventListener('click', () => postControl({}, 'pause'));
document.getElementById('btn-start')?.addEventListener('click', () => postControl({}, 'play'));

async function applyReset(action) {
  await postControl({}, action);
  const newState = await fetch('/api/state').then(r => r.json());
  lastState = newState;
  buildPipeline(newState);
  builtMachineKey = newState.machines.map(m => m.id).join(',');
  prevStateForDiff = newState;
  resetParticles();
  buildControlSliders(newState);
  syncSourceSliders(newState);
}


document.getElementById('btn-reset').addEventListener('click', () => applyReset('reset'));
document.getElementById('btn-reset-defaults').addEventListener('click', () => applyReset('resetToDefaults'));

// ── Scenario presets ────────────────────────────────────────────────────────

// Transient confirmation message. Re-arming clearTimeout avoids a stale earlier
// toast hiding a newer one.
let toastTimer = null;
function showToast(message) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

// Loading a preset swaps the whole machine/buffer set, so we reuse the reset
// flow (rebuild pipeline + sliders from the fresh state) rather than just diffing.
async function loadPreset(presetId, label) {
  const res = await fetch('/api/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'loadPreset', params: { presetId } }),
  }).then(r => r.json()).catch(() => ({ ok: false }));

  if (!res.ok) { showToast('⚠ Could not load preset'); return; }

  const newState = await fetch('/api/state').then(r => r.json()).catch(() => null);
  if (!newState) { showToast('⚠ Preset loaded, but the view could not be updated'); return; }
  lastState = newState;
  buildPipeline(newState);
  builtMachineKey = newState.machines.map(m => m.id).join(',');
  prevStateForDiff = newState;
  resetParticles();
  buildControlSliders(newState);
  syncSourceSliders(newState);

  showToast(`✓ Preset “${label}” loaded – press start`);
}

// Fetch preset metadata once and render a button per scenario.
async function initPresetButtons() {
  const row = document.getElementById('preset-row');
  if (!row) return;
  let presets = [];
  try {
    presets = await fetch('/api/presets').then(r => r.json());
  } catch (_) { return; }
  for (const p of presets) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = p.label;
    btn.title = p.description;
    btn.dataset.presetId = p.id;
    btn.addEventListener('click', () => loadPreset(p.id, p.label));
    row.appendChild(btn);
  }
}
initPresetButtons();

// Export per-tick history. The browser keeps our session cookie on the
// navigation, so the server returns this session's recorded history.
function downloadExport(format) {
  const a = document.createElement('a');
  a.href = `/api/export?format=${format}`;
  a.rel  = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
document.getElementById('btn-export-csv').addEventListener('click', () => downloadExport('csv'));
document.getElementById('btn-export-json').addEventListener('click', () => downloadExport('json'));

// Speed buttons
document.querySelectorAll('.speed-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    postControl({ speed: parseInt(btn.dataset.speed, 10) });
  });
});

// Source controls. The material stock slider's right end (STOCK_INFINITE_POS) means infinite stock (-1).
const STOCK_INFINITE_POS = 510;
function stockLabel(stock) { return stock < 0 ? '∞' : stock; }

// Set the source sliders from the engine state (first frame, reset, preset).
function syncSourceSliders(state) {
  const stock = state.source.materialStock;
  document.getElementById('src-interval').value = state.source.interval;
  document.getElementById('val-src-interval').textContent = state.source.interval;
  document.getElementById('material-stock').value = stock < 0 ? STOCK_INFINITE_POS : stock;
  document.getElementById('val-material-stock').textContent = stockLabel(stock);
}

document.getElementById('src-interval').addEventListener('input', e => {
  const v = parseInt(e.target.value, 10);
  document.getElementById('val-src-interval').textContent = v;
  postControl({ sourceInterval: v });
});

document.getElementById('material-stock').addEventListener('input', e => {
  const pos = parseInt(e.target.value, 10);
  const v = pos >= STOCK_INFINITE_POS ? -1 : pos;
  document.getElementById('val-material-stock').textContent = stockLabel(v);
  postControl({ materialStock: v });
});


// ── SSE connection ────────────────────────────────────────────────────────────

function connectSSE() {
  const es = new EventSource('/api/events');

  es.addEventListener('message', e => {
    const { state, metrics } = JSON.parse(e.data);
    lastState   = state;
    lastMetrics = metrics;

    // First frame: show the engine's source settings on the sliders.
    if (builtMachineKey === null) syncSourceSliders(state);

    // Rebuild the SVG whenever the set of machines changes (spawn/remove/reset).
    const key = state.machines.map(m => m.id).join(',');
    if (key !== builtMachineKey) {
      buildPipeline(state);
      buildControlSliders(state);
      resetParticles();
      prevStateForDiff = state;          // baseline; no spurious deltas this frame
      builtMachineKey  = key;
      // Close the detail panel if its machine no longer exists.
      if (selectedMachineId && !state.machines.some(m => m.id === selectedMachineId)) {
        closeMachineDetail();
      }
    }

    // Particle flow: detect transfers between consecutive snapshots.
    const transfers = detectTransfers(prevStateForDiff, state);
    if (transfers.length > 0) spawnFromEvents(transfers);
    prevStateForDiff  = state;
    particleSimState  = state;
    // Freeze in-flight dots while paused for inspection, but NOT once the run has
    // finished — let the final transfers glide out so no dots linger on the line.
    particleSimPaused = shouldFreezeParticles(state);

    updatePipeline(state, metrics);
    updateMetricsDashboard(metrics, state);
    updateSuggestionBanner(metrics);
  });

  es.addEventListener('error', () => {
    // Reconnect after 2 seconds on error
    es.close();
    setTimeout(connectSSE, 2000);
  });
}

// ── Machine detail panel: close handlers ─────────────────────────────────────

document.getElementById('md-close')?.addEventListener('click', closeMachineDetail);
document.getElementById('md-spawn')?.addEventListener('click', () => {
  const m = lastState?.machines.find(x => x.id === selectedMachineId);
  if (m) postControl({ stationId: m.stationId }, 'spawnMachine');
});
document.getElementById('md-remove')?.addEventListener('click', () => {
  if (selectedMachineId) postControl({ machineId: selectedMachineId }, 'removeMachine');
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && selectedMachineId) closeMachineDetail();
});

// ── Boot ──────────────────────────────────────────────────────────────────────
// The pipeline is built from the first SSE frame (and rebuilt whenever the set
// of machines changes), since the layout is derived from state.

let builtMachineKey = null;   // machine-id signature of the currently-drawn layout

connectSSE();
