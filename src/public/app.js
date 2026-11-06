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
import { PipelineView } from './pipeline-view.js';

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
  DOWN:       'Down (breakdown)',
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
  const t = el('text', { 'font-family': 'monospace', 'font-size': '11', fill: '#1f2430', ...attrs });
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
    fill: '#f6f3ec', stroke: '#4f46e5', 'stroke-width': 1.5 }));
  g.appendChild(el('rect', { id: 'src-stock-bg', x: x + 8, y: y + SRC_H - 20, width: SRC_W - 16, height: 10,
    rx: 3, fill: '#d9d3c5' }));
  g.appendChild(el('rect', { id: 'src-stock-fill', x: x + 8, y: y + SRC_H - 20, width: SRC_W - 16, height: 10,
    rx: 3, fill: '#6366f1' }));
  g.appendChild(txt('SOURCE', { x: x + SRC_W / 2, y: y + 18, 'text-anchor': 'middle', 'font-size': '10', fill: '#4f46e5' }));
  g.appendChild(txt('', { id: 'src-stock-text', x: x + SRC_W / 2, y: y + 38, 'text-anchor': 'middle', 'font-size': '11' }));
  // raw-material safety stock (ERP starting stock), shown when the run starts from it
  g.appendChild(txt('', { id: 'src-raw-text', x: x + SRC_W / 2, y: y - 8, 'text-anchor': 'middle', 'font-size': '10', fill: '#4f46e5' }));

  svg.appendChild(g);
}

function drawBuffer(buf, p) {
  const id = buf.id, x = p.x, y = p.y;
  const g = el('g', { id: `elem-${id}` });

  g.appendChild(el('rect', { x, y, width: BUF_W, height: BUF_H, rx: 5,
    fill: '#f6f3ec', stroke: '#b3ab98', 'stroke-width': 1.2 }));
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
    rx: 8, class: 'machine-rect IDLE', fill: '#f6f3ec', stroke: '#b3ab98', 'stroke-width': 1.5 }));

  const shortName = name.length > 17 ? name.slice(0, 16) + '…' : name;
  g.appendChild(txt(shortName, { x: x + MACH_W / 2, y: y + 11, 'text-anchor': 'middle',
    'font-size': '9.5', fill: '#5b6475' }));
  g.appendChild(txt(id, { x: x + MACH_W / 2, y: y + 22, 'text-anchor': 'middle',
    'font-size': '9', fill: '#64748b' }));

  // Progress arc (circle)
  const cx = x + MACH_W / 2;
  const cy = y + MACH_H / 2 + 6;
  const r  = 20;
  const circ = 2 * Math.PI * r;

  // Background circle
  g.appendChild(el('circle', { cx, cy, r, fill: 'none', stroke: '#d9d3c5', 'stroke-width': 4 }));

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
    x: cx, y: cy + 4, 'text-anchor': 'middle', 'font-size': '9', fill: '#5b6475' }));

  // State badge (bottom-left of machine rect)
  g.appendChild(el('rect', { id: `mach-badge-bg-${id}`, x: x + 4, y: y + MACH_H - 18, width: 50, height: 14,
    rx: 7, fill: '#ece8dd' }));
  g.appendChild(txt('IDLE', { id: `mach-badge-${id}`, x: x + 29, y: y + MACH_H - 7,
    'text-anchor': 'middle', 'font-size': '8', fill: '#5b6475' }));

  // Bottleneck marker (hidden by default — shown when this machine is the bottleneck)
  const bnG = el('g', { id: `mach-bn-${id}`, class: 'mach-bn-marker', visibility: 'hidden' });
  const badgeW = 78;
  const badgeH = 18;
  const badgeX = x + MACH_W / 2 - badgeW / 2;
  const badgeY = y - badgeH - 10;            // sits above the machine
  bnG.appendChild(el('rect', {
    x: badgeX, y: badgeY, width: badgeW, height: badgeH, rx: 9,
    fill: '#ffedd5', stroke: '#f97316', 'stroke-width': 1.2,
  }));
  // Warning glyph + label
  bnG.appendChild(txt('⚠ BOTTLENECK', {
    x: x + MACH_W / 2, y: badgeY + badgeH - 5,
    'text-anchor': 'middle', 'font-size': '10', 'font-weight': '700',
    fill: '#c2410c', 'font-family': 'Inter, system-ui, sans-serif',
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
    fill: '#f6f3ec', stroke: '#22c55e', 'stroke-width': 1.5 }));
  g.appendChild(txt('SINK', { x: x + SINK_W / 2, y: y + 16, 'text-anchor': 'middle', 'font-size': '10', fill: '#166534' }));
  g.appendChild(txt('0', { id: 'sink-count', x: x + SINK_W / 2, y: y + 40, 'text-anchor': 'middle',
    'font-size': '20', fill: '#22c55e', 'font-weight': 'bold' }));
  g.appendChild(txt('parts', { x: x + SINK_W / 2, y: y + SINK_H - 6, 'text-anchor': 'middle', 'font-size': '9', fill: '#16a34a' }));
  // finished-goods warehouse (orders mode): the ERP starting stock plus what the line made, minus what was shipped
  g.appendChild(txt('', { id: 'sink-fg-text', x: x + SINK_W / 2, y: y - 8, 'text-anchor': 'middle', 'font-size': '10', fill: '#166534' }));
  svg.appendChild(g);
}

function drawScrapSink(p) {
  const x = p.x, y = p.y;
  const g = el('g', { id: 'elem-SCRAP' });
  g.appendChild(el('rect', { x, y, width: SINK_W, height: SINK_H, rx: 6,
    fill: '#f6f3ec', stroke: '#ef4444', 'stroke-width': 1.5 }));
  g.appendChild(txt('SCRAP', { x: x + SINK_W / 2, y: y + 16, 'text-anchor': 'middle', 'font-size': '10', fill: '#b91c1c' }));
  g.appendChild(txt('0', { id: 'scrap-count', x: x + SINK_W / 2, y: y + 40, 'text-anchor': 'middle',
    'font-size': '20', fill: '#ef4444', 'font-weight': 'bold' }));
  g.appendChild(txt('scrapped', { x: x + SINK_W / 2, y: y + SINK_H - 6, 'text-anchor': 'middle', 'font-size': '9', fill: '#991b1b' }));
  g.appendChild(txt('', { id: 'scrap-rate-label', x: x + SINK_W / 2, y: y - 6, 'text-anchor': 'middle', 'font-size': '10', fill: '#b91c1c' }));
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
  setTextContent('src-raw-text', src.rawSafetyLevel > 0 ? `raw stock ${src.rawOnHand}/${src.rawSafetyLevel}` : '');
  setTextContent('sink-fg-text', state.orders ? `warehouse ${state.orders.stock} sets` : '');

  // Per-machine reject rates are shown in each machine's detail panel; the
  // shared scrap sink no longer carries a single rate label.
  setTextContent('scrap-rate-label', '');

  // ── Machine detail panel (if open) ─────────────────────────────────────────
  updateMachineDetail();

  // ── Header tick ────────────────────────────────────────────────────────────
  setTextContent('tick-counter', state.tick);
  // Shift clock: 1 tick = 1 minute, 480 ticks per shift. Tick n (1-based) lies in shift ceil(n/480).
  const TPS_SHIFT = 480;
  const shiftNo = state.tick > 0 ? Math.floor((state.tick - 1) / TPS_SHIFT) + 1 : 1;
  const shiftMin = state.tick > 0 ? ((state.tick - 1) % TPS_SHIFT) + 1 : 0;
  setTextContent('shift-counter', shiftNo);
  setTextContent('shift-minute', `(min ${shiftMin}/${TPS_SHIFT})`);
  const out = state.outage;
  const inOutage = !!out && state.tick > out.startTick && state.tick <= out.endTick;
  const outBadge = document.getElementById('badge-outage');
  if (outBadge) outBadge.hidden = !inOutage;
  const downIds = (state.machines ?? []).filter(m => m.state === 'DOWN').map(m => m.id);
  const downBadge = document.getElementById('badge-down');
  if (downBadge) {
    downBadge.hidden = downIds.length === 0;
    downBadge.textContent = downIds.length ? `DOWN: ${downIds.join(', ')}` : '';
  }
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
  const arcColours = { PROCESSING: '#22c55e', IDLE: '#b3ab98', STARVED: '#f59e0b', BLOCKED: '#ef4444', DOWN: '#a855f7' };
  arcEl.setAttribute('stroke', arcColours[m.state] ?? '#b3ab98');

  // State badge
  if (badgeEl) {
    badgeEl.textContent = m.state;
    const textColours = { PROCESSING: '#166534', IDLE: '#5b6475', STARVED: '#92400e', BLOCKED: '#991b1b', DOWN: '#6b21a8' };
    badgeEl.setAttribute('fill', textColours[m.state] ?? '#5b6475');
  }
  if (badgeBg) {
    const bgColours = { PROCESSING: '#dcfce7', IDLE: '#ece8dd', STARVED: '#fef3c7', BLOCKED: '#fee2e2', DOWN: '#f3e8ff' };
    badgeBg.setAttribute('fill', bgColours[m.state] ?? '#ece8dd');
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
    const strokeColours = { PROCESSING: '#22c55e', IDLE: '#b3ab98', STARVED: '#f59e0b', BLOCKED: '#ef4444', DOWN: '#a855f7' };
    const baseStroke   = isBottleneck ? '#f97316' : (strokeColours[m.state] ?? '#b3ab98');
    rectEl.setAttribute('stroke', isSelected ? '#4f46e5' : baseStroke);
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
    const fillColours = { PROCESSING: '#22c55e', IDLE: '#64748b', STARVED: '#f59e0b', BLOCKED: '#ef4444', DOWN: '#a855f7' };
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
  const total = m.ticksProcessing + m.ticksBlocked + m.ticksStarved + m.ticksIdle + (m.ticksDown ?? 0);
  setTextContent('md-total-ticks', `${total} ticks`);
  const segs = {
    processing: total > 0 ? m.ticksProcessing / total : 0,
    blocked:    total > 0 ? m.ticksBlocked    / total : 0,
    starved:    total > 0 ? m.ticksStarved    / total : 0,
    idle:       total > 0 ? m.ticksIdle       / total : 0,
    down:       total > 0 ? (m.ticksDown ?? 0) / total : 0,
  };
  const stack = document.getElementById('md-stack');
  if (stack) {
    stack.children[0].style.width = (segs.processing * 100).toFixed(2) + '%';
    stack.children[1].style.width = (segs.blocked    * 100).toFixed(2) + '%';
    stack.children[2].style.width = (segs.starved    * 100).toFixed(2) + '%';
    stack.children[3].style.width = (segs.idle       * 100).toFixed(2) + '%';
    if (stack.children[4]) stack.children[4].style.width = (segs.down * 100).toFixed(2) + '%';
  }
  setTextContent('md-pct-processing', (segs.processing * 100).toFixed(0) + '%');
  setTextContent('md-pct-blocked',    (segs.blocked    * 100).toFixed(0) + '%');
  setTextContent('md-pct-starved',    (segs.starved    * 100).toFixed(0) + '%');
  setTextContent('md-pct-idle',       (segs.idle       * 100).toFixed(0) + '%');
  setTextContent('md-pct-down',       (segs.down       * 100).toFixed(0) + '%');
}

function setConnectorBlocked(id, blocked) {
  const el = document.getElementById(id);
  if (!el) return;
  el.setAttribute('class', blocked ? 'pipe-connector blocked' : 'pipe-connector');
  el.setAttribute('stroke', blocked ? '#ef4444' : '#b3ab98');
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
    if (s.type === 'no-internal-constraint' || s.type === 'material-depleted' || s.type === 'supplier-outage') {
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
  refreshKpis?.();
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


// ── Realism layer: scenario controls, plant default, orders / economics panel ──

const FLAT_DEMAND = 34;
const REFERENCE_OUTAGE = { startTick: 4800, endTick: 5760 };
const SUPPLY_OPTIONS = {
  jit:       undefined,
  inventory: { mode: 'inventory' },
  safety:    { mode: 'inventory', reorderPoint: 150, orderQty: 150, initialStock: 250 },
  second:    { mode: 'inventory', secondSupplier: { enabled: true } },
  expedite:  { mode: 'inventory', expediting: { enabled: true } },
};
const $ = (id) => document.getElementById(id);

async function rebuildFromServer() {
  const newState = await fetch('/api/state').then(r => r.json());
  lastState = newState;
  buildPipeline(newState);
  builtMachineKey = newState.machines.map(m => m.id).join(',');
  prevStateForDiff = newState;
  resetParticles();
  buildControlSliders(newState);
  syncSourceSliders(newState);
  syncRealismControls(newState);
  refreshKpis();
}

function syncRealismControls(state) {
  $('rl-seed').value = state.seed ?? 1;
  $('rl-outage').checked = !!state.outage;
  if (state.outage) { $('rl-out-start').value = state.outage.startTick; $('rl-out-end').value = state.outage.endTick; }
  $('rl-failures').checked = !!state.failures;
  if (state.orders) {
    $('rl-fg').value = state.orders.stock;                // only meaningful at tick 0
  }
}

$('btn-apply-realism').addEventListener('click', async () => {
  const demandKind = $('rl-demand').value;
  const params = {
    seed: parseInt($('rl-seed').value, 10) || 0,
    demand: demandKind === 'none' ? null : demandKind,
    initialFinishedGoods: Math.max(0, parseInt($('rl-fg').value, 10) || 0),
    outage: $('rl-outage').checked
      ? { startTick: parseInt($('rl-out-start').value, 10), endTick: parseInt($('rl-out-end').value, 10) }
      : null,
    failures: $('rl-failures').checked ? { enabled: true } : null,
    supply: SUPPLY_OPTIONS[$('rl-supply').value] ?? null,
  };
  // The server sets material to unlimited whenever a realism option is on (engine.configureScenario),
  // so the run does not stop after the starter's 200 parts; rebuildFromServer syncs the slider.
  await postControl(params, 'configureScenario');
  await rebuildFromServer();
  showToast('✓ Realism settings applied – press start');
});

$('btn-plant-default').addEventListener('click', async () => {
  await postControl({}, 'loadPlantDefault');
  $('rl-demand').value = 'profile';
  $('rl-supply').value = 'jit';
  await rebuildFromServer();
  showToast('✓ Plant default loaded – press start');
});

const eur = (v) => (v < 0 ? '−' : '') + Math.abs(Math.round(v)).toLocaleString('en-US');

async function refreshKpis() {
  let k;
  try { k = await fetch('/api/kpis').then(r => r.json()); } catch (_) { return; }
  const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
  $('kpi-shifts').textContent = k.shifts > 0 ? `· ${k.shifts} shift${k.shifts === 1 ? '' : 's'} closed` : '';
  const o = k.orders;
  if (o) {
    set('k-sl', (o.serviceLevel * 100).toFixed(1) + '%');
    $('k-sl').className = 'value ' + (o.serviceLevel >= 0.95 ? 'good' : o.serviceLevel < 0.8 ? 'bad' : '');
    set('k-sl-sub', `${o.shippedOnTime} of ${o.ordered} units on time`);
    set('k-orders', o.ordered);
    set('k-backlog', o.backlog);
    set('k-fg', o.stock);
  } else {
    for (const id of ['k-sl', 'k-orders', 'k-backlog', 'k-fg']) set(id, '–');
    set('k-sl-sub', 'no demand loaded');
  }
  const e = k.economics;
  if (e) {
    set('k-cost', e.costPerGoodUnit.toFixed(1));
    set('k-cost-sub', `EUR (baseline ~102.8) · all-in ${e.costPerGoodUnitAll.toFixed(1)}`);
    set('k-profit', eur(e.profit));
    $('k-profit').className = 'value ' + (e.profit >= 0 ? 'good' : 'bad');
  } else {
    for (const id of ['k-cost', 'k-profit']) set(id, '–');
    $('k-profit').className = 'value';
  }
  set('k-breakdowns', k.failures ? k.breakdowns : '–');
  set('k-breakdowns-sub', k.failures ? `${k.downTicks} ticks down` : 'off');
  if (k.supply?.mode === 'inventory') {
    set('k-raw', k.supply.stock);
    set('k-raw-sub', `${k.supply.stockoutTicks} ticks out of stock`);
  } else { set('k-raw', '–'); set('k-raw-sub', 'just in time'); }
  renderShiftTable(k.perShift ?? [], k.outage);
  set('kpi-note', k.outage ? `Supplier outage: ticks ${k.outage.startTick}–${k.outage.endTick} · seed ${k.seed}` : `seed ${k.seed}`);
}
// One row per closed shift (newest on top). Rebuilt only when the number of rows changes.
let shiftTableKey = '';
function renderShiftTable(rows, outage) {
  const body = $('shift-table-body');
  if (!body) return;
  const showOut = rows.some(r => (r.outsourced ?? 0) > 0 || (r.outsourcedOrdered ?? 0) > 0);
  const key = rows.length ? `${rows.length}:${rows[rows.length - 1].produced}:${rows[rows.length - 1].outsourced ?? 0}:${showOut}` : '0';
  if (key === shiftTableKey) return;
  shiftTableKey = key;
  const outHead = $('th-outsourced');
  if (outHead) outHead.hidden = !showOut;
  if (rows.length === 0) {
    body.innerHTML = '<tr><td colspan="9" class="shift-empty">No closed shift yet. Shifts close every 480 ticks '
      + 'once a demand is loaded (Realism → Demand, or Load plant default).</td></tr>';
    return;
  }
  const inOutage = (shift) => !!outage
    && (shift - 1) * 480 < outage.endTick && shift * 480 > outage.startTick;
  body.innerHTML = [...rows].reverse().map(r => {
    const late = r.shippedOnTime < r.orders;
    return `<tr class="${inOutage(r.shift) ? 'shift-outage' : ''}">`
      + `<td>${r.shift}${inOutage(r.shift) ? ' <span class="mini-badge">outage</span>' : ''}</td>`
      + `<td>${r.produced}</td><td>${r.scrap}</td><td>${r.orders}</td><td>${r.shipped}</td>`
      + `<td class="${late ? 'bad' : 'good'}">${r.shippedOnTime}</td>`
      + `<td>${r.backlog}</td><td>${r.stock}</td><td>${Number(r.wip).toFixed(1)}</td>`
      + (showOut ? `<td title="ordered at the close of this shift: ${r.outsourcedOrdered ?? 0}">${r.outsourced ?? 0}</td>` : '') + '</tr>';
  }).join('');
}

setInterval(refreshKpis, 1000);
refreshKpis();

// ── SSE connection ────────────────────────────────────────────────────────────

function connectSSE() {
  const es = new EventSource('/api/events');

  es.addEventListener('message', e => {
    const { state, metrics, compare } = JSON.parse(e.data);
    if (compare) cmpOnData(compare);
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

// ── CEO interface: scenario bar, Results tiles, AI shift advisor ─────────────
// The simulation numbers come from the server (GET /api/results); the LLM is
// only reached through the server's /api/advisor/* endpoints.

const RUN_SHIFTS = 20;          // default run length; the CEO can choose 1..60
let ceoRunning = false;
let ceoPoll = null;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt0 = (n) => Math.round(n).toLocaleString('en-US');
const fmt1 = (n) => n.toFixed(1);
const eurText = (n) => `${n < 0 ? '−' : ''}EUR ${fmt0(Math.abs(n))}`;
const eurSigned = (n) => `${n < 0 ? '−' : '+'}EUR ${fmt0(Math.abs(n))}`;

function setAdvisorEnabled(on) {
  for (const id of ['btn-explain', 'btn-improve']) document.getElementById(id).disabled = !on;
}

function clearResults() {
  lastSummary = null;
  document.getElementById('result-tiles').innerHTML = '';
  document.getElementById('results-empty').hidden = false;
  document.getElementById('results-empty').textContent = 'Choose a scenario and click Simulate.';
  document.getElementById('results-note').hidden = true;
  document.getElementById('results-seed').hidden = true;
  document.getElementById('improve-panel').hidden = true;
  document.getElementById('advisor-output').hidden = true;
  document.getElementById('proposal-card').hidden = true;
  document.getElementById('questionnaire').hidden = true;
  hideCompare();
  setAdvisorEnabled(false);
}

function tile(title, value, caption, tone = '') {
  return `<div class="tile"><div class="tile-title">${esc(title)}</div>`
    + `<div class="tile-value ${tone}">${esc(value)}</div><div class="tile-caption">${esc(caption)}</div></div>`;
}

function disruptionTile(s) {
  const d = s.disruption;
  if (!d) return tile('Disruption', 'None', 'No disruption');
  if (s.scenario.id === 'supplier-outage') {
    return tile('Disruption', 'Supplier outage', `Supplier stopped for ${d.window} (${d.sourceHaltedMinutes} min); the bottleneck waited ${d.bottleneckStarvedByOutageMinutes} min`);
  }
  if (s.scenario.id === 'machinery-breakdown') {
    const parts = Object.entries(d.downMinutesByMachine).map(([id, m]) => `${id} down ${m} min`).join(', ');
    return tile('Disruption', `${d.count} breakdowns`, parts || 'No machine went down');
  }
  return tile('Disruption', `${d.peakOrders} sets`, `Peak order: ${d.peakOrders} sets in shift ${d.peakShift}; lowest: ${d.minOrders}`);
}

// The biggest cost lines of the run, for the caption of the Total cost tile
function costCaption(m) {
  const c = m.costs;
  if (!c) return '';
  const lines = [['machines', c.machines], ['material', c.material], ['missed orders', c.lostSalesPenalty], ['storage', c.storage],
    ['outsourcing', c.outsourcing], ['starting stock', c.startingStock], ['investments', c.investments]]
    .filter(([, v]) => v > 0.5).sort((a, b) => b[1] - a[1]).slice(0, 3);
  return lines.map(([k, v]) => `${k} ${eurText(v)}`).join(' · ');
}

// Finished sets left in the warehouse at the end (and parts still in the line): what they tie up and cost
function stockLeftTile(st) {
  if (!st) return '';
  const value = st.finishedSets > 0 ? `${fmt0(st.finishedSets)} sets · ${eurText(st.finishedValue)}` : '0 sets';
  const caption = `${st.finishedSets > 0 ? `valued at EUR ${st.valuePerSet} per set (unsold, tied-up money) · ` : ''}`
    + `storage paid ${eurText(st.storageCostFinished)} · ${fmt0(st.inLineParts)} parts still in the line`;
  return tile('Stock left at the end', value, caption);
}

function renderResults(s, seed = 1) {
  lastSummary = s;
  if (erp.stale) { erp.stale = false; renderErpState(); }
  const seedNote = document.getElementById('results-seed');
  seedNote.hidden = false;
  const st = s.startStock;
  seedNote.textContent = `Seed ${seed}: one possible week of this scenario (the same seed always gives the same run). `
    + 'The countermeasure cards and checks below average 10 seeds, so they do not depend on this one. '
    + (st ? `Started from the ERP stock: ${st.rawUnits} raw units at the source (${st.rawUsedDuringOutage} used during the outage) `
      + `and ${st.finishedSets} finished sets.` : 'Started with an empty warehouse (reference).');
  const sl = s.orders.serviceLevel * 100;
  const tone = sl >= 95 ? 'green' : sl >= 80 ? 'amber' : 'red';
  const w = s.worstShift;
  document.getElementById('result-tiles').innerHTML = [
    tile('Orders on time', `${fmt1(sl)}%`, `${s.orders.shippedOnTime} of ${s.orders.ordered} sets delivered on time`, tone),
    tile('Late / missed sets', String(s.orders.late), `backlog at the end: ${s.orders.backlogEnd} sets`),
    tile('Sets produced', fmt0(s.production.goodParts), `≈ ${fmt0(s.production.goodPerShift)} per shift · scrap ${s.production.scrap}`),
    tile('Revenue', eurText(s.money.revenue), `${fmt0(s.money.soldSets)} sets shipped × EUR ${fmt0(s.money.pricePerSet)}`),
    tile('Total cost', eurText(s.money.totalCost), costCaption(s.money)),
    stockLeftTile(s.stockEnd),
    tile('Profit', eurText(s.money.profit), `revenue − cost + stock left · cost per good set EUR ${fmt1(s.money.costPerGoodUnit)}`),
    tile('Bottleneck', `${s.bottleneck.machine} · ${fmt0(s.bottleneck.utilisation * 100)}%`, `lost ${fmt0(s.bottleneck.lostMinutes)} min, mainly: ${s.bottleneck.mainCause}`),
    tile('Worst shift', w ? `Shift ${w.shift}` : '–', w ? `ordered ${w.orders}, on time ${w.shippedOnTime}` : 'No shift missed orders'),
    disruptionTile(s),
  ].join('');
  document.getElementById('results-empty').hidden = true;
  const note = document.getElementById('results-note');
  note.hidden = s.shifts === RUN_SHIFTS;
}

async function pollResults() {
  let r;
  try { r = await (await fetch('/api/results')).json(); } catch { return; }
  const status = document.getElementById('run-status');
  if (r.status === 'running') {
    ceoRunning = true;
    const tick = lastState?.plantTick ?? 0;
    const shift = Math.min(r.shiftsTotal, Math.max(1, Math.ceil(tick / 480)));
    status.textContent = `Running – shift ${shift} of ${r.shiftsTotal}`;
    setRunButtons(true);
    setAdvisorEnabled(false);
    if (!ceoPoll) ceoPoll = setInterval(pollResults, 700);
  } else if (r.status === 'done') {
    const was = ceoRunning;
    ceoRunning = false;
    status.textContent = `Finished – ${r.shiftsTotal} shifts`;
    setRunButtons(false);
    if (was || document.getElementById('result-tiles').children.length === 0) {
      renderResults(r.summary, r.seed);
      setAdvisorEnabled(true);
    }
    clearInterval(ceoPoll); ceoPoll = null;
  } else {
    clearInterval(ceoPoll); ceoPoll = null;
    // The run was reset or reconfigured with the advanced controls: the old Results no longer match
    if (ceoRunning || lastSummary) {
      ceoRunning = false;
      clearResults();
      document.getElementById('results-empty').textContent = 'The run was changed with the advanced controls – click Simulate to start a new run.';
      document.getElementById('run-status').textContent = '';
      setRunButtons(false);
    }
  }
}

// Shift limit: a whole number from 1 to 60
function shiftLimitValue() {
  const raw = document.getElementById('shift-limit').value.trim();
  const n = Number(raw);
  return raw !== '' && Number.isInteger(n) && n >= 1 && n <= 60 ? n : null;
}

// Seed: a whole number from 0 to 99,999 (same seed = same run; another seed = another possible week)
const MAX_SEED = 99999;
function seedValue() {
  const raw = document.getElementById('seed-input').value.trim();
  const n = Number(raw);
  return raw !== '' && Number.isInteger(n) && n >= 0 && n <= MAX_SEED ? n : null;
}

let runBusy = false;
function refreshRunButtons() {
  const valid = shiftLimitValue() !== null;
  const seedOk = seedValue() !== null;
  document.getElementById('shift-limit').classList.toggle('invalid', !valid);
  document.getElementById('shift-hint').hidden = valid;
  document.getElementById('seed-input').classList.toggle('invalid', !seedOk);
  document.getElementById('seed-hint').hidden = seedOk;
  document.getElementById('seed-dice').disabled = runBusy;
  const n = shiftLimitValue();
  document.getElementById('shift-note').hidden = !(valid && n < 12 && document.getElementById('scenario-select').value === 'supplier-outage');
  for (const id of ['btn-simulate', 'btn-instant']) document.getElementById(id).disabled = runBusy || !valid || !seedOk;
}

document.getElementById('seed-input').addEventListener('input', refreshRunButtons);
document.getElementById('seed-dice').addEventListener('click', () => {
  const input = document.getElementById('seed-input');
  let s;
  do { s = 1 + Math.floor(Math.random() * 9999); } while (String(s) === input.value);
  input.value = s;
  refreshRunButtons();
});

function setRunButtons(disabled) {
  runBusy = disabled;
  refreshRunButtons();
}

document.getElementById('shift-limit').addEventListener('input', refreshRunButtons);
document.getElementById('scenario-select').addEventListener('change', refreshRunButtons);

// Start a scenario run: animated, or instant (all shifts at once, no animation)
async function startRun(instant) {
  setRunButtons(true);
  clearResults();
  document.getElementById('run-status').textContent = instant ? 'Simulating…' : 'Starting…';
  try {
    const res = await fetch('/api/control', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'runScenario', params: {
        scenario: document.getElementById('scenario-select').value,
        speed: Number(document.getElementById('speed-select').value), instant, shifts: shiftLimitValue(), seed: seedValue(),
        start: erpStart(),
      } }),
    });
    if (!res.ok) throw new Error('rejected');
    ceoRunning = true;
    pollResults();
  } catch {
    document.getElementById('run-status').textContent = 'Could not start the simulation';
    setRunButtons(false);
  }
}

document.getElementById('btn-simulate').addEventListener('click', () => startRun(false));
document.getElementById('btn-instant').addEventListener('click', () => startRun(true));

// Changing the speed during a run takes effect immediately
document.getElementById('speed-select').addEventListener('change', () => {
  if (ceoRunning) postControl({ speed: Number(document.getElementById('speed-select').value) }, 'configure');
});

// ── Advisor ──────────────────────────────────────────────────────────────────

async function callAdvisor(path) {
  const res = await fetch(path, { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'The AI service is not reachable');
  return body;
}

// ── Explanation chat: the first explanation, then follow-up questions ─────────
// The server keeps the conversation of the run; the browser only shows it.

const SUGGESTIONS = {
  any: ['Why were orders late?', 'Which machine limited the output?', 'Where did the money go?', 'Which shifts were the worst?'],
  standard: ['Is anything going wrong in this run?'],
  'demand-swing': ['How did demand change during the run?'],
  'supplier-outage': ['What happened during the supplier outage?'],
  'machinery-breakdown': ['How much did the breakdowns cost us?'],
};
let chatBusy = false;
let chatAsked = new Set();
let chatLeft = 0;

// Plain text with **bold** and "### headings" shown as bold; everything else stays text
const richText = (s) => esc(s)
  .replace(/^#{1,4}\s*(.+)$/gm, '<strong>$1</strong>')
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

function groundingNote(g) {
  if (!g || g.numbers === 0) return '';
  if (g.ungrounded.length === 0) {
    return `<span class="ground-ok" title="Every number in this answer appears in the simulation results (rounding and % allowed)">✓ ${g.numbers} number${g.numbers === 1 ? '' : 's'} checked against the simulation</span>`;
  }
  const list = g.ungrounded.map(v => v.toLocaleString('en-US')).join(', ');
  return `<span class="ground-warn" title="These numbers are not in the simulation results: the AI calculated or guessed them">⚠ Not in the simulation results: ${esc(list)}</span>`;
}

function addMessage(who, text, meta = null) {
  const log = document.getElementById('chat-log');
  const el = document.createElement('div');
  el.className = `msg msg-${who}`;
  const tokens = meta?.usage?.totalTokens ? `<span>${fmt0(meta.usage.totalTokens)} tokens</span>` : '';
  const whoAi = meta?.model?.label ? `AI advisor · ${esc(meta.model.label)}` : 'AI advisor';
  el.innerHTML = `<div class="msg-who">${who === 'ai' ? whoAi : 'You'}</div>`
    + `<div class="msg-body">${who === 'ai' ? richText(text) : esc(text)}</div>`
    + (meta ? `<div class="msg-meta">${groundingNote(meta.grounding)}${tokens}</div>` : '');
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

function addError(text) {
  const el = document.createElement('div');
  el.className = 'msg-error';
  el.textContent = text;
  document.getElementById('chat-log').appendChild(el);
}

function addThinking() {
  const el = addMessage('ai', '');
  el.querySelector('.msg-body').innerHTML = '<span class="spinner"></span>Thinking…';
  return el;
}

function renderSuggestions() {
  const box = document.getElementById('chat-suggest');
  box.innerHTML = '';
  if (chatLeft <= 0) return;
  const list = [...(SUGGESTIONS[lastSummary?.scenario?.id] ?? []), ...SUGGESTIONS.any].filter(q => !chatAsked.has(q)).slice(0, 4);
  for (const q of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = q;
    b.disabled = chatBusy;
    b.addEventListener('click', () => askFollowUp(q));
    box.appendChild(b);
  }
}

function setChatBusy(on) {
  chatBusy = on;
  setAdvisorEnabled(!on);
  const input = document.getElementById('chat-input');
  input.disabled = on || chatLeft <= 0;
  document.getElementById('chat-send').disabled = on || chatLeft <= 0;
  document.getElementById('chat-restart').disabled = on;
  input.placeholder = chatLeft <= 0
    ? 'Question limit reached for this run. Click “New explanation” to start again.'
    : 'Ask a follow-up question, e.g. “Why were so many orders late?” (Enter to send, Shift+Enter for a new line)';
  renderSuggestions();
}

function showUsage(r) {
  const s = r?.sessionTokens;
  const left = chatLeft > 0 ? `${chatLeft} question${chatLeft === 1 ? '' : 's'} left for this run` : 'No questions left for this run';
  document.getElementById('chat-foot').textContent =
    `${left}${s ? ` · AI usage in this session: ${fmt0(s.totalTokens)} tokens in ${s.calls} answer${s.calls === 1 ? '' : 's'}` : ''}`;
}

async function startExplanation() {
  document.getElementById('advisor-output').hidden = false;
  document.getElementById('chat-log').innerHTML = '';
  document.getElementById('chat-foot').textContent = '';
  chatAsked = new Set();
  chatLeft = 0;
  setChatBusy(true);
  const thinking = addThinking();
  try {
    const r = await callAdvisorJson('/api/advisor/explain', {});
    thinking.remove();
    chatLeft = r.followUpsLeft;
    addMessage('ai', r.text, r);
    showUsage(r);
  } catch (e) {
    thinking.remove();
    addError(e.message);
  }
  setChatBusy(false);
  document.getElementById('chat-input').focus({ preventScroll: true });
}

async function askFollowUp(question) {
  const q = question.trim();
  if (!q || chatBusy || chatLeft <= 0) return;
  chatAsked.add(q);
  addMessage('ceo', q);
  document.getElementById('chat-input').value = '';
  setChatBusy(true);
  const thinking = addThinking();
  try {
    const r = await callAdvisorJson('/api/advisor/explain', { question: q });
    thinking.remove();
    chatLeft = r.followUpsLeft;
    addMessage('ai', r.text, r);
    showUsage(r);
  } catch (e) {
    thinking.remove();
    addError(e.message);
  }
  setChatBusy(false);
  document.getElementById('chat-input').focus({ preventScroll: true });
}

document.getElementById('btn-explain').addEventListener('click', startExplanation);
document.getElementById('chat-restart').addEventListener('click', startExplanation);
document.getElementById('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  askFollowUp(document.getElementById('chat-input').value);
});
document.getElementById('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    askFollowUp(e.target.value);
  }
});

// ── Questionnaire (hard limits are enforced on the server) ────────────────────

const QUESTIONS = [
  { key: 'goal', label: 'What matters most?', def: 'balance',
    options: [['delivery', 'On-time delivery'], ['profit', 'Profit'], ['balance', 'A balance of both']] },
  { key: 'budget', label: 'How much can you invest?', def: 'unlimited',
    options: [['none', 'Nothing'], ['60k', 'Up to €60,000'], ['100k', 'Up to €100,000'], ['unlimited', 'No limit']] },
  { key: 'fixType', label: 'What kind of fix do you prefer?', def: 'any',
    options: [['operational', 'Operational — quick, no investment'], ['strategic', 'Strategic — invest for the long term'], ['any', 'No preference']] },
];
let lastSummary = null;
let qAnswers = Object.fromEntries(QUESTIONS.map(q => [q.key, q.def]));

function renderQuestionRows() {
  const rows = document.getElementById('q-rows');
  rows.innerHTML = '';
  for (const q of QUESTIONS) {
    const row = document.createElement('div');
    row.className = 'q-row';
    row.innerHTML = `<div class="q-label">${esc(q.label)}</div><div class="chips"></div>`;
    const chips = row.querySelector('.chips');
    for (const [value, label] of q.options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (qAnswers[q.key] === value ? ' selected' : '');
      b.textContent = label;
      b.addEventListener('click', () => {
        qAnswers[q.key] = value;
        for (const c of chips.children) c.classList.remove('selected');
        b.classList.add('selected');
      });
      chips.appendChild(b);
    }
    rows.appendChild(row);
  }
}

function openQuestionnaire() {
  hideCompare();
  document.getElementById('proposal-card').hidden = true;
  document.getElementById('improve-panel').hidden = true;
  renderQuestionRows();
  const notes = document.getElementById('q-notes');
  document.getElementById('q-count').textContent = notes.value.length;
  document.getElementById('questionnaire').hidden = false;
  document.getElementById('questionnaire').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

document.getElementById('q-notes').addEventListener('input', (e) => {
  document.getElementById('q-count').textContent = e.target.value.length;
});
document.getElementById('q-find').addEventListener('click', () => submitImprove({ ...qAnswers, notes: document.getElementById('q-notes').value.trim() }));
document.getElementById('q-best').addEventListener('click', () => submitImprove(null));

async function callAdvisorJson(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'The AI service is not reachable');
  return data;
}

// Readable settings of one catalogue item or of a whole (possibly combined) countermeasure
function itemParamText(id, params) {
  if (id === 'improve-machine') return `${params.minutesSaved} min off the M3 cycle`;
  if (id === 'new-line') return `release a part every ${params.releaseInterval} min`;
  if (id === 'extra-supplier') return 'qualified backup supplier';
  if (id === 'outsourcing') return `up to ${params.maxSetsPerShift} sets per shift`;
  if (id === 'raw-stock') return `raw material stock ${params.stockLevel}, re-order at ${params.stockLevel - 100}`;
  if (id === 'finished-stock') return `${params.sets} finished sets in stock`;
  return Object.entries(params).map(([k, v]) => `${k} = ${v}`).join(', ');
}

// Class badge: STRATEGIC (dark blue) or OPERATIONAL (teal), the same wherever a countermeasure appears
const CLASS_TEXT = {
  strategic: ['STRATEGIC', 'Strategic: an investment for the long term'],
  operational: ['OPERATIONAL', 'Operational: a quick, short-term fix'],
};
const classBadge = (cat) => (CLASS_TEXT[cat]
  ? `<span class="cls-badge ${cat}" title="${esc(CLASS_TEXT[cat][1])}">${CLASS_TEXT[cat][0]}</span>` : '');
// one badge per distinct class of a (possibly combined) countermeasure
const badgesOf = (cm) => [...new Set((cm.items ?? [cm]).map(i => i.category).filter(Boolean))].map(classBadge).join(' ');

function paramText(cm) {
  if (cm.items) return cm.items.map(i => (cm.items.length > 1 ? `${i.label}: ` : '') + itemParamText(i.id, i.params)).join('; ');
  return itemParamText(cm.id, cm.params);
}

function renderProposal(card, r) {
  const limits = r.constraintsApplied?.length
    ? `<div class="cm-limits"><strong>Your limits:</strong> ${esc(r.constraintsApplied.join('; '))}</div>` : '';
  const change = r.source === 'manual' || !r.source
    ? '<button id="q-change" class="link-btn" type="button">Back to the countermeasures</button>'
    : '<button id="q-change" class="link-btn" type="button">Change my answers</button>';
  const reopen = () => (r.source === 'manual' ? openImprovePanel() : openQuestionnaire());
  if (r.status === 'no-options') {
    card.innerHTML = `<div class="advisor-label">Countermeasure</div><div>${esc(r.text)}</div>`
      + (r.answers ? `<div class="cm-buttons">${change}</div>` : '');
    document.getElementById('q-change')?.addEventListener('click', reopen);
    return;
  }
  if (r.status === 'none') {
    card.innerHTML = `<div class="cm-source">The advisor's choice</div>
      <div class="cm-name">No countermeasure pays off in this scenario</div>
      <div class="cm-reason">${esc(r.reason)}</div>
      ${limits}
      <div class="cm-note">Nothing was simulated: none of the countermeasures improves on-time delivery or earns more than it costs.</div>
      <div class="cm-buttons">${change}</div>`;
    document.getElementById('q-change').addEventListener('click', reopen);
    return;
  }
  const cm = r.countermeasure, c = r.check;
  const code = c.verdict.code;
  const badge = code === 'effective' ? ['green', '✅ Works']
    : code === 'costly' ? ['red', '❌ Costs more than it earns'] : ['grey', c.verdict.text];
  const manual = r.source === 'manual';
  const costs = (cm.items ?? [{ cost: cm.cost }]).map(i => `<div class="cm-cost">Cost${cm.items?.length > 1 ? ` (${esc(i.label)})` : ''}: ${esc(i.cost)}</div>`).join('');
  card.innerHTML = `
    <div class="cm-source">${manual ? 'Your selection' : 'The advisor\'s choice'}</div>
    <div class="cm-name">${esc(cm.label)} ${badgesOf(cm)}</div>
    <div class="cm-params">${esc(paramText(cm))}</div>
    ${limits}
    ${manual ? '' : `<div class="cm-reason">${esc(r.reason)}</div>`}
    ${costs}
    <div class="cm-check">
      <div class="advisor-label">Simulation check (${c.runs} runs, ${c.shifts ?? cmpShifts()} shifts)</div>
      <div class="cm-check-row"><strong>Orders on time: ${fmt1(c.without.serviceLevel * 100)}% → ${fmt1(c.with.serviceLevel * 100)}%</strong></div>
      <div class="cm-check-row"><strong>Profit: ${eurSigned(c.change.profitConservative.mean)}</strong>
        <span class="cm-small">(official rule: ${eurSigned(c.change.profitOfficial.mean)})</span></div>
      <div class="cm-check-row"><span class="verdict ${badge[0]}">${esc(badge[1])}</span></div>
      <div class="cm-note">The check compares averages of ${c.runs} runs; the animation above is one run.</div>
    </div>
    <div class="cost-panel" id="cost-panel-proposal"></div>
    <div class="cm-buttons">
      <button id="cmp-open" class="primary-btn" type="button">Compare side by side</button>
      ${change}
    </div>`;
  renderCostPanel(document.getElementById('cost-panel-proposal'), r.costs, { badges: badgesOf(cm) });
  document.getElementById('q-change').addEventListener('click', reopen);
  document.getElementById('cmp-open').addEventListener('click', () => openCompare(cm));
}

async function submitImprove(answers) {
  const card = document.getElementById('proposal-card');
  document.getElementById('questionnaire').hidden = true;
  document.getElementById('improve-panel').hidden = true;
  hideCompare();
  setAdvisorEnabled(false);
  card.hidden = false;
  // the advisor reads the 6 simulated card values: it waits for them when they are not ready yet
  const reading = !cardsData || cardsData.pending.length > 0 || cardsData.ready.size < 6;
  card.innerHTML = `<span class="spinner"></span>${reading ? 'The advisor is reading the simulations…' : 'Asking the advisor, then testing the proposal in the simulation…'}`;
  try {
    renderProposal(card, await callAdvisorJson('/api/advisor/improve', { answers }));
  } catch (e) {
    card.innerHTML = `<span class="advisor-error">${esc(e.message)}</span>`;
  }
  setAdvisorEnabled(true);
}

// ── Countermeasure cards: one pool of 6, the same in every scenario ───────────
// The values on the cards are simulated on the spot (server: GET /api/countermeasures/cards) for the scenario
// and the shift limit of the top bar. They start when the CEO picks a scenario or changes the shift limit; the
// page polls once a second until all 6 are in. Nothing is precomputed and nothing is saved.

let cmCatalogue = [];
const cmPick = {};           // id -> { selected, values: { param: number } } kept while the panel is reopened
const MAX_PICK = 3;

const stepsOf = (def) => {
  const out = [];
  for (let v = def.min; v <= def.max + 1e-9; v += def.step || 1) out.push(v);
  return out;
};

const GROUPS = [
  ['operational', 'Operational — quick fixes, little or no investment'],
  ['strategic', 'Strategic — investments for the long term'],
];
const VERDICT_CHIP = {
  effective: ['green', 'Effective'], costly: ['red', 'Costly'], 'delivery-only': ['amber', 'Delivery only'],
  'profit-only': ['green', 'Saves money'], 'no-effect': ['grey', 'No effect'], harmful: ['red', 'Harmful'],
};
const SCENARIO_LABELS = { standard: 'Standard', 'demand-swing': 'Demand swing', 'supplier-outage': 'Supplier outage', 'machinery-breakdown': 'Machinery breakdown' };

let cardsData = null;        // { scenario, shifts, runs, ready: Map(id -> card), pending: [id], errors }
let cardsToken = 0, cardsTimer = null, cardsDebounce = null;

const topBarPair = () => ({ scenario: document.getElementById('scenario-select').value, shifts: shiftLimitValue(), start: erpStartKey() });

// Start (or restart) the simulation of the 6 cards for the pair in the top bar; clears the cards to "simulating…"
function requestCards() {
  const { scenario, shifts, start } = topBarPair();
  if (shifts === null) return;
  clearTimeout(cardsTimer);
  const token = ++cardsToken;
  if (!cardsData || cardsData.scenario !== scenario || cardsData.shifts !== shifts || cardsData.start !== start) {
    cardsData = { scenario, shifts, start, runs: 10, ready: new Map(), pending: cmCatalogue.map(c => c.id), errors: {} };
  }
  updateCardValues();
  pollCards(token);
}

async function pollCards(token) {
  const { scenario, shifts, start } = cardsData;
  const [finished, raw] = start.split('/');
  let r;
  try {
    r = await (await fetch(`/api/countermeasures/cards?scenario=${encodeURIComponent(scenario)}&shifts=${shifts}&finished=${finished}&raw=${raw}`)).json();
    if (r.error) throw new Error(r.error);
  } catch {
    if (token === cardsToken) cardsTimer = setTimeout(() => pollCards(token), 3000);
    return;
  }
  if (token !== cardsToken) return;                  // the CEO picked something else meanwhile
  cardsData.runs = r.runs;
  cardsData.ready = new Map(r.ready.map(c => [c.id, c]));
  cardsData.pending = r.pending;
  cardsData.errors = r.errors ?? {};
  updateCardValues();
  if (r.pending.length) cardsTimer = setTimeout(() => pollCards(token), 1000);
}

// A change in the top bar clears the cards and starts a new computation (after a short pause while typing)
function scheduleCards() {
  clearTimeout(cardsDebounce);
  if (shiftLimitValue() === null) return;
  const { scenario, shifts, start } = topBarPair();
  if (cardsData && (cardsData.scenario !== scenario || cardsData.shifts !== shifts || cardsData.start !== start)) {
    cardsData = { scenario, shifts, start, runs: 10, ready: new Map(), pending: cmCatalogue.map(c => c.id), errors: {} };
    updateCardValues();
  }
  cardsDebounce = setTimeout(requestCards, 400);
}
document.getElementById('scenario-select').addEventListener('change', scheduleCards);
document.getElementById('shift-limit').addEventListener('input', scheduleCards);

const pct0 = (v) => `${Math.round(v * 100)}%`;
const SKELETON = '<span class="skeleton">simulating…</span>';

function valueHtml(row, card) {
  if (!card) return SKELETON;
  if (row === 'ontime') {
    const pts = card.onTime.points;
    const txt = `${pts >= 0 ? '+' : '−'}${Math.abs(pts) < 10 ? Math.abs(pts).toFixed(1) : Math.round(Math.abs(pts))} pts`;
    return `${pct0(card.onTime.without)} → <strong>${pct0(card.onTime.with)}</strong> <span class="dim">(${txt})</span>`;
  }
  if (row === 'profit') {
    const v = card.profit.conservative;
    return `<span class="${v >= 0 ? 'pos' : 'neg'}" title="Extra unsold stock is valued at EUR 0">${esc(eurSigned(v))}</span>`;
  }
  if (row === 'invest') {
    const { cash, runningPerShift: run } = card.investment;
    const running = Math.abs(run) >= 0.5 ? ` <span class="dim">${run < 0 ? '−' : '+'} EUR ${fmt0(Math.abs(run))} / shift</span>` : '';
    return (cash > 0 ? `EUR ${fmt0(cash)}` : 'none') + running;
  }
  return `EUR ${fmt1(card.costPerGoodSet.without)} → <strong>EUR ${fmt1(card.costPerGoodSet.with)}</strong>`;
}

// The best value of each row among the cards that are ready (a ★), unless all of them are equal
function bestIds(cards) {
  const best = {};
  if (cards.length < 2) return best;
  const pick = (key, f, higher) => {
    const vals = cards.map(c => [c.id, Math.round(f(c) * 1000) / 1000]);
    const target = (higher ? Math.max : Math.min)(...vals.map(v => v[1]));
    const ids = vals.filter(v => v[1] === target).map(v => v[0]);
    best[key] = ids.length === cards.length ? [] : ids;
  };
  pick('ontime', c => c.onTime.with, true);
  pick('profit', c => c.profit.conservative, true);
  pick('invest', c => c.investment.cash, false);
  pick('cost', c => c.costPerGoodSet.with, false);
  return best;
}

function cardSliderHtml(cm, pick) {
  return Object.entries(cm.params).map(([name, def]) => `
    <label class="cm-card-param">
      <span>${esc(def.label)}: <output>${pick.values[name]}</output></span>
      <input type="range" data-param="${esc(name)}" min="${def.min}" max="${def.max}" step="${def.step}" value="${pick.values[name]}" />
    </label>`).join('');
}

const CARD_ROWS = [['ontime', 'On-time delivery'], ['profit', 'Profit change per run'], ['invest', 'Upfront investment'], ['cost', 'Cost per good set']];
const cmOpen = {};             // id -> details panel open (kept while the page is open)

// The one-line summary of a closed card: on-time change and profit change
function summaryHtml(kind, card) {
  if (!card) return kind === 'ontime' ? SKELETON : '';
  if (kind === 'ontime') {
    return `<span class="dim">On time</span> ${pct0(card.onTime.without)} → <strong>${pct0(card.onTime.with)}</strong>`;
  }
  const v = card.profit.conservative;
  return `<span class="dim">Profit</span> <span class="${v >= 0 ? 'pos' : 'neg'}">${esc(eurSigned(v))}</span>`;
}

function renderImprovePanel() {
  const panel = document.getElementById('improve-panel');
  for (const cm of cmCatalogue) {
    cmPick[cm.id] ??= { selected: false, values: Object.fromEntries(Object.entries(cm.params).map(([k, d]) => [k, d.default])) };
  }
  const cardHtml = (cm) => {
    const pick = cmPick[cm.id];
    const open = !!cmOpen[cm.id];
    return `<div class="cm-card${pick.selected ? ' selected' : ''}${open ? ' open' : ''}" data-id="${esc(cm.id)}">
      <div class="cm-card-top">
        <label class="cm-card-head"><input type="checkbox" class="cm-pick" ${pick.selected ? 'checked' : ''} /> ${esc(cm.label)}</label>
        ${classBadge(cm.category)}
      </div>
      <div class="cm-card-summary">
        <span class="cm-sum" data-sum="ontime"></span><span class="cm-sum" data-sum="profit"></span><span class="cm-verdict"></span>
        <button type="button" class="cm-more-btn" aria-expanded="${open}" aria-controls="cm-more-${esc(cm.id)}">
          <span class="cm-more-label">${open ? 'Hide details' : 'Details'}</span><span class="chev" aria-hidden="true">▾</span>
        </button>
      </div>
      <div class="cm-more" id="cm-more-${esc(cm.id)}" ${open ? '' : 'hidden'}>
        <div class="cm-card-desc">${esc(cm.description)}</div>
        <div class="cm-card-params">${cardSliderHtml(cm, pick)}
          <div class="cm-card-note" hidden>values at default setting — press Test to simulate yours</div>
        </div>
        <div class="cm-vals">${CARD_ROWS.map(([row, label]) => `<div class="cm-val" data-row="${row}"><span class="cm-val-label">${label}</span><span class="cm-val-v"></span></div>`).join('')}</div>
        <div class="cm-card-cost">${esc(cm.cost)}</div>
      </div>
    </div>`;
  };
  const groups = GROUPS.map(([cat, title]) => `
    <h3 class="cm-group">${esc(title)}</h3>
    <div class="cm-cards">${cmCatalogue.filter(c => c.category === cat).map(cardHtml).join('')}</div>`).join('');
  panel.innerHTML = `
    <div class="imp-title">Choose countermeasures</div>
    <div class="imp-sub">Select one or combine up to ${MAX_PICK}, set the values, and test it in the simulation. Not sure? Ask the advisor.</div>
    <div class="imp-basis" id="imp-basis"></div>
    ${groups}
    <div class="imp-actions">
      <button id="imp-test" class="primary-btn" type="button">Test my selection</button>
      <button id="imp-ask" class="advisor-btn" type="button">Ask the Intelligent Shift Advisor</button>
      <span class="cm-small" id="imp-limit">Up to ${MAX_PICK} countermeasures can be combined.</span>
    </div>
    <details class="imp-table-wrap" id="imp-table-details">
      <summary>Compare all 6 in one table</summary>
      <table class="imp-table">
        <caption>Values at the default settings, averages of simulated runs. Unsold extra stock is valued at EUR 0 in the profit change. ★ marks the best value of a row.</caption>
        <thead><tr><th>Compare the countermeasures</th><th>On time</th><th>Profit change</th><th>Upfront investment</th><th>Running cost / shift</th><th>Extra unsold stock</th><th>Verdict</th></tr></thead>
        <tbody id="imp-table-body"></tbody>
      </table>
    </details>`;

  const refresh = () => {
    const n = cmCatalogue.filter(c => cmPick[c.id].selected).length;
    document.getElementById('imp-test').disabled = n === 0;
    for (const cardEl of panel.querySelectorAll('.cm-card')) {
      const box = cardEl.querySelector('.cm-pick');
      box.disabled = !cmPick[cardEl.dataset.id].selected && n >= MAX_PICK;
    }
    document.getElementById('imp-limit').classList.toggle('limit-hit', n >= MAX_PICK);
  };
  for (const cardEl of panel.querySelectorAll('.cm-card')) {
    const id = cardEl.dataset.id, cm = cmCatalogue.find(c => c.id === id);
    cardEl.querySelector('.cm-more-btn').addEventListener('click', (e) => {
      cmOpen[id] = !cmOpen[id];
      cardEl.classList.toggle('open', cmOpen[id]);
      cardEl.querySelector('.cm-more').hidden = !cmOpen[id];
      e.currentTarget.setAttribute('aria-expanded', String(cmOpen[id]));
      e.currentTarget.querySelector('.cm-more-label').textContent = cmOpen[id] ? 'Hide details' : 'Details';
    });
    cardEl.querySelector('.cm-pick').addEventListener('change', (e) => {
      cmPick[id].selected = e.target.checked;
      cardEl.classList.toggle('selected', e.target.checked);
      refresh();
    });
    for (const input of cardEl.querySelectorAll('input[type=range]')) {
      input.addEventListener('input', () => {
        cmPick[id].values[input.dataset.param] = Number(input.value);
        input.closest('label').querySelector('output').textContent = input.value;
        const moved = Object.entries(cm.params).some(([k, d]) => cmPick[id].values[k] !== d.default);
        cardEl.querySelector('.cm-card-note').hidden = !moved;
      });
      // the note also shows for a value restored from an earlier visit
      const moved = Object.entries(cm.params).some(([k, d]) => cmPick[id].values[k] !== d.default);
      cardEl.querySelector('.cm-card-note').hidden = !moved;
    }
  }
  refresh();
  document.getElementById('imp-test').addEventListener('click', testSelection);
  document.getElementById('imp-ask').addEventListener('click', openQuestionnaire);
  updateCardValues();
}

// Fill (or clear) the values of the cards, the header and the comparison table from cardsData
function updateCardValues() {
  const panel = document.getElementById('improve-panel');
  const basis = document.getElementById('imp-basis');
  if (!basis || panel.hidden || !cardsData) return;
  const { scenario, shifts, runs, ready, pending } = cardsData;
  const cards = cmCatalogue.map(c => ready.get(c.id)).filter(Boolean);
  const best = bestIds(cards);

  let note = `<strong>Expected effect over ${shifts} shifts (${runs} simulated runs each)</strong> · ${esc(SCENARIO_LABELS[scenario] ?? scenario)}`;
  if (pending.length) note += ` · <span class="spinner"></span>simulating… ${cards.length} of ${cmCatalogue.length} ready`;
  const failed = Object.keys(cardsData.errors ?? {});
  if (failed.length) note += ` · <span class="advisor-error">could not simulate: ${esc(failed.join(', '))}</span>`;
  if (lastSummary && (lastSummary.scenario.id !== scenario || lastSummary.shifts !== shifts)) {
    note += `<div class="cm-note">The results above come from a run of ${esc(lastSummary.scenario.label)} over ${lastSummary.shifts} shifts, `
      + 'the values below from what is selected in the top bar. “Test my selection” uses the run above.</div>';
  }
  basis.innerHTML = note;

  for (const cardEl of panel.querySelectorAll('.cm-card')) {
    const id = cardEl.dataset.id, card = ready.get(id);
    for (const [row] of CARD_ROWS) {
      const rowEl = cardEl.querySelector(`.cm-val[data-row="${row}"]`);
      const key = row === 'cost' ? 'cost' : row;
      const isBest = !!card && (best[key] ?? []).includes(id);
      rowEl.classList.toggle('best', isBest);
      rowEl.classList.toggle('pending', !card);
      rowEl.querySelector('.cm-val-v').innerHTML = valueHtml(row, card) + (isBest ? ' <span class="star" title="Best value of this row among the countermeasures">★</span>' : '');
    }
    for (const kind of ['ontime', 'profit']) cardEl.querySelector(`.cm-sum[data-sum="${kind}"]`).innerHTML = summaryHtml(kind, card);
    const chip = card ? (VERDICT_CHIP[card.verdict.code] ?? ['grey', card.verdict.text]) : null;
    cardEl.querySelector('.cm-verdict').innerHTML = chip
      ? `<span class="verdict ${chip[0]}" title="${esc(card.verdict.text)}">${esc(chip[1])}</span>` : '<span class="skeleton">simulating…</span>';
  }

  document.getElementById('imp-table-body').innerHTML = cmCatalogue.map(cm => {
    const c = ready.get(cm.id);
    const chip = c ? (VERDICT_CHIP[c.verdict.code] ?? ['grey', c.verdict.text]) : null;
    const dash = '<td class="skeleton-cell">—</td>';
    return `<tr><td>${classBadge(cm.category)} ${esc(cm.label)}</td>`
      + (c ? `<td>${valueHtml('ontime', c)}</td><td>${valueHtml('profit', c)}</td>`
        + `<td>${c.investment.cash > 0 ? `EUR ${fmt0(c.investment.cash)}` : 'none'}</td>`
        + `<td>${Math.abs(c.investment.runningPerShift) >= 0.5 ? `EUR ${fmt0(c.investment.runningPerShift)}` : 'none'}</td>`
        + `<td>${c.unsold > 0.05 ? `${fmt1(c.unsold)} sets` : 'none'}</td>`
        + `<td><span class="verdict ${chip[0]}" title="${esc(c.verdict.text)}">${esc(chip[1])}</span></td>`
        : dash.repeat(6))
      + '</tr>';
  }).join('');
}

async function openImprovePanel() {
  hideCompare();
  document.getElementById('proposal-card').hidden = true;
  document.getElementById('questionnaire').hidden = true;
  if (!cmCatalogue.length) {
    try { cmCatalogue = await (await fetch('/api/countermeasures')).json(); } catch { cmCatalogue = []; }
    if (!Array.isArray(cmCatalogue)) cmCatalogue = [];
  }
  if (!cmCatalogue.length) { submitImprove(null); return; }       // no catalogue: the plain "no options" answer
  document.getElementById('improve-panel').hidden = false;
  renderImprovePanel();
  // normally the cards are already being computed (the CEO picked the scenario before); make sure of it
  const { scenario, shifts, start } = topBarPair();
  if (!cardsData || cardsData.scenario !== scenario || cardsData.shifts !== shifts || cardsData.start !== start
    || cardsData.ready.size < cmCatalogue.length) requestCards();
  document.getElementById('improve-panel').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function testSelection() {
  const selection = cmCatalogue.filter(c => cmPick[c.id].selected).map(c => ({ id: c.id, params: { ...cmPick[c.id].values } }));
  const card = document.getElementById('proposal-card');
  document.getElementById('improve-panel').hidden = true;
  hideCompare();
  setAdvisorEnabled(false);
  card.hidden = false;
  card.innerHTML = '<span class="spinner"></span>Testing your selection in the simulation…';
  try {
    renderProposal(card, await callAdvisorJson('/api/countermeasures/test', { selection }));
  } catch (e) {
    card.innerHTML = `<span class="advisor-error">${esc(e.message)}</span>`;
  }
  setAdvisorEnabled(true);
}

// "Ask the Intelligent Shift Advisor" waits for the 6 simulations (the advisor reads them), then answers
document.getElementById('btn-improve').addEventListener('click', openImprovePanel);
document.getElementById('q-back').addEventListener('click', openImprovePanel);

// ── Side-by-side comparison: two PipelineView instances fed by the SSE stream ─

const cmpShifts = () => lastSummary?.shifts ?? RUN_SHIFTS;
let cmpViewA = null, cmpViewB = null, cmpCm = null, cmpStatus = 'idle';

function hideCompare() {
  document.getElementById('compare').hidden = true;
  fetch('/api/compare/stop', { method: 'POST' }).catch(() => {});
  cmpStatus = 'idle';
}

function openCompare(cm) {
  cmpCm = cm;
  const sec = document.getElementById('compare');
  sec.hidden = false;
  document.getElementById('cmp-title').innerHTML = `Side-by-side: as is vs. with <em>${esc(cm.label)} – ${esc(paramText(cm))}</em> ${badgesOf(cm)}`;
  document.getElementById('cmp-b-tag').textContent = cm.label;
  document.getElementById('cmp-results').hidden = true;
  document.getElementById('cmp-status').textContent = 'Press “Run comparison”.';
  cmpViewA ??= new PipelineView(document.getElementById('cmp-svg-a'), { idPrefix: 'cmpA-' });
  cmpViewB ??= new PipelineView(document.getElementById('cmp-svg-b'), { idPrefix: 'cmpB-' });
  for (const id of ['cmp-strip-a', 'cmp-strip-b']) document.getElementById(id).innerHTML = '';
  sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function stripHtml(side) {
  const o = side.state.orders ?? { ordered: 0, shippedOnTime: 0, backlog: 0, stock: 0 };
  const sl = o.ordered > 0 ? (o.shippedOnTime / o.ordered) * 100 : 100;
  const shift = Math.min(cmpShifts(), Math.max(1, Math.ceil(side.state.plantTick / 480)));
  return `<span>Shift <strong>${shift}</strong></span><span>On time <strong>${fmt1(sl)}%</strong></span>`
    + `<span>Backlog <strong>${o.backlog}</strong></span><span>Finished stock <strong>${o.stock}</strong></span>`
    + ((side.state.source?.rawSafetyLevel ?? 0) > 0 ? `<span>Raw stock <strong>${side.state.source.rawOnHand}</strong></span>` : '')
    + (side.state.outsourcing ? `<span>Outsourced sets <strong>${side.state.outsourcing.received}</strong></span>` : '')
    + ((side.state.supply?.backupParts ?? 0) > 0 ? `<span>Backup-supplier parts <strong>${side.state.supply.backupParts}</strong></span>` : '');
}

function cmpOnData(c) {
  if (document.getElementById('compare').hidden || !cmpViewA) return;
  cmpViewA.update(c.a.state, c.a.metrics);
  cmpViewB.update(c.b.state, c.b.metrics);
  document.getElementById('cmp-strip-a').innerHTML = stripHtml(c.a);
  document.getElementById('cmp-strip-b').innerHTML = stripHtml(c.b);

  const prev = cmpStatus;
  cmpStatus = c.status;
  const st = document.getElementById('cmp-status');
  if (c.status === 'running') {
    const shift = Math.min(cmpShifts(), Math.max(1, Math.ceil(c.b.state.plantTick / 480)));
    st.textContent = `Shift ${shift} of ${cmpShifts()}`;
    setAdvisorEnabled(false);
  } else if (c.status === 'done') {
    st.textContent = `Finished – ${cmpShifts()} shifts`;
    if (prev !== 'done') { setAdvisorEnabled(true); loadCompareResults(); }
  }
}

const arrowTile = (title, a, b, fmt, higherIsBetter) => {
  const better = higherIsBetter ? b > a : b < a;
  const cls = Math.abs(b - a) < 1e-9 ? 'arrow-same' : better ? 'arrow-good' : 'arrow-bad';
  return `<div class="tile"><div class="tile-title">${esc(title)}</div>`
    + `<div class="tile-value small">${esc(fmt(a))} <span class="${cls}">→ ${esc(fmt(b))}</span></div></div>`;
};

async function loadCompareResults() {
  let r;
  try { r = await (await fetch('/api/compare/results')).json(); } catch { return; }
  if (r.status !== 'done') return;
  const { a, b } = r;
  const tiles = [
    arrowTile('Orders on time', a.orders.serviceLevel * 100, b.orders.serviceLevel * 100, v => `${fmt1(v)}%`, true),
    arrowTile('Late sets', a.orders.late, b.orders.late, v => String(Math.round(v)), false),
    arrowTile('Sets produced', a.production.goodParts, b.production.goodParts, v => fmt0(v), true),
    arrowTile('Profit', a.money.profit, b.money.profit, v => eurText(v), true),
  ];
  if (b.production.outsourcedSets > 0) tiles.push(arrowTile('Outsourced sets', 0, b.production.outsourcedSets, v => fmt0(v), false));
  if (b.production.backupParts > 0) tiles.push(arrowTile('Backup-supplier parts', 0, b.production.backupParts, v => fmt0(v), false));
  const extra = b.production.goodParts - a.production.goodParts;
  if (extra > 0) tiles.push(arrowTile('Extra unsold stock', 0, extra, v => `${fmt0(v)} sets`, false));
  document.getElementById('cmp-tiles').innerHTML = tiles.join('');
  renderCostPanel(document.getElementById('cmp-cost'), r.costs, {
    basisLabel: 'This run (one run, same random draws)',
    note: 'The averages in the proposal card above are more reliable.',
    badges: cmpCm ? badgesOf(cmpCm) : '',
  });
  document.getElementById('cmp-results').hidden = false;
}

async function startCompare(instant) {
  document.getElementById('cmp-results').hidden = true;
  document.getElementById('cmp-status').textContent = 'Starting…';
  setAdvisorEnabled(false);
  try {
    const res = await fetch('/api/compare/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ speed: Number(document.getElementById('cmp-speed').value), instant }),
    });
    if (!res.ok) throw new Error('rejected');
    cmpStatus = instant ? 'done' : 'running';
    if (instant) { setAdvisorEnabled(true); loadCompareResults(); }
  } catch {
    document.getElementById('cmp-status').textContent = 'Could not start the comparison';
    setAdvisorEnabled(true);
  }
}

document.getElementById('cmp-run').addEventListener('click', () => startCompare(false));
document.getElementById('cmp-instant').addEventListener('click', () => startCompare(true));
document.getElementById('cmp-speed').addEventListener('change', (e) => {
  fetch('/api/compare/speed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ speed: Number(e.target.value) }) }).catch(() => {});
});

// Pick up a run that is already in progress or finished (page reload)
pollResults();

// ── Cost of the improvement panel (one render function for the proposal card and the comparison) ──

const eurSym = (n) => `${n < 0 ? '−' : ''}€${Math.round(Math.abs(n)).toLocaleString('en-US')}`;
// **bold** markers of the server's headline -> <strong>, everything else escaped
const boldHtml = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

function costRows(lines, isCost) {
  return lines.map(l => {
    const good = isCost ? l.amount < 0 : l.amount > 0;          // a saving, or a gain
    const tag = l.assumption ? ` <span class="assume-tag" title="${esc(l.assumption)}">assumption</span>` : '';
    return `<tr><td>${esc(l.label)}${tag}</td><td class="how">${esc(l.formula)}</td>`
      + `<td class="amt ${good ? 'amt-good' : 'amt-bad'}">${eurSym(l.amount)}</td></tr>`;
  }).join('');
}

// Waterfall from the "as is" profit to the "with countermeasure" profit (inline SVG)
function bridgeSvg(c) {
  const W = 940, H = 330, L = 78, R = 16, T = 22, B = 74;
  const steps = [];
  let run = c.bridge.start;
  const bars = [{ label: 'As is', kind: 'abs', from: 0, to: run, value: run }];
  for (const l of c.pay) {                                       // costs go down
    bars.push({ label: l.label, kind: 'cost', from: run, to: run - l.amount, value: -l.amount });
    run -= l.amount;
  }
  for (const l of c.get) {                                       // gains go up
    bars.push({ label: l.label, kind: 'gain', from: run, to: run + l.amount, value: l.amount });
    run += l.amount;
  }
  bars.push({ label: 'With countermeasure', kind: 'abs', from: 0, to: c.bridge.end, value: c.bridge.end });
  if (c.totals.unsoldStockValue > 0) {
    bars.push({ label: 'minus unsold stock', kind: 'dash', from: c.bridge.end, to: c.bridge.end - c.totals.unsoldStockValue, value: -c.totals.unsoldStockValue });
  }
  const vals = bars.flatMap(b => [b.from, b.to]).concat(0);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.08 || 1;
  lo -= pad; hi += pad;
  const y = (v) => T + (hi - v) / (hi - lo) * (H - T - B);
  const step = (() => { const raw = (hi - lo) / 5, p = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 5, 10].map(m => m * p).find(s => s >= raw); })();
  const ticks = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(t);
  const bw = (W - L - R) / bars.length;
  const colour = { abs: '#4f46e5', gain: '#16a34a', cost: '#dc2626', dash: '#dc2626' };
  const wrap = (s) => {                                          // at most 2 short lines
    const words = s.split(' '); const a = []; let cur = '';
    for (const w of words) { if ((cur + ' ' + w).trim().length > 15 && cur) { a.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
    a.push(cur);
    return a.slice(0, 3);
  };
  let g = '';
  for (const t of ticks) {
    g += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="${t === 0 ? '#9aa3b5' : '#d9d3c5'}" />`
      + `<text x="${L - 8}" y="${y(t) + 4}" text-anchor="end" font-size="11" fill="#5b6475">${eurSym(t)}</text>`;
  }
  bars.forEach((b, i) => {
    const x = L + i * bw + bw * 0.15, w = bw * 0.7;
    const top = y(Math.max(b.from, b.to)), h = Math.max(1, Math.abs(y(b.from) - y(b.to)));
    const dash = b.kind === 'dash';
    g += `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="2" `
      + (dash ? `fill="none" stroke="${colour.dash}" stroke-width="1.5" stroke-dasharray="5 3"` : `fill="${colour[b.kind]}"`) + ' />';
    const labelAbove = b.kind === 'abs' ? b.value >= 0 : b.value >= 0;
    const ly = labelAbove ? top - 5 : top + h + 13;
    const txt = (b.kind === 'abs' ? '' : b.value >= 0 ? '+' : '') + eurSym(b.value);
    g += `<text x="${(x + w / 2).toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" font-size="11" font-weight="600" fill="#1f2430">${esc(txt)}</text>`;
    wrap(b.label).forEach((line, k) => {
      g += `<text x="${(x + w / 2).toFixed(1)}" y="${H - B + 18 + k * 13}" text-anchor="middle" font-size="11" fill="#5b6475">${esc(line)}</text>`;
    });
  });
  const aria = 'Profit bridge: ' + bars.map(b => `${b.label} ${eurSym(b.value)}`).join('; ');
  return `<svg class="bridge-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}"><title>${esc(aria)}</title>${g}</svg>`;
}

function renderCostPanel(container, c, { basisLabel, note, badges = '' } = {}) {
  if (!container) return;
  if (!c) { container.innerHTML = ''; return; }
  const t = c.totals;
  const rescuedChip = c.costPerRescuedOrder == null
    ? '<span class="chip-ind grey">No extra orders delivered on time</span>'
    : `<span class="chip-ind ${c.costPerRescuedOrder < c.penaltyPerLateOrder ? 'green' : 'amber'}" title="A late order costs €${c.penaltyPerLateOrder} in penalty; the sale itself is kept.">`
      + `Cost per rescued order: <strong>${eurSym(c.costPerRescuedOrder)}</strong> vs <strong>€${c.penaltyPerLateOrder}</strong> penalty per late order</span>`;
  const pb = c.payback;
  const paybackText = pb == null ? 'no investment'
    : pb.shifts == null ? 'never at these numbers'
    : `${pb.shifts.toLocaleString('en-US')} shifts (≈ ${(Math.round(pb.years * 10) / 10)} years)`;
  const paybackChip = `<span class="chip-ind ${pb == null ? 'grey' : pb.shifts == null ? 'amber' : pb.withinLife ? 'green' : 'amber'}">Payback: <strong>${esc(paybackText)}</strong></span>`;

  const invest = c.investment.cash > 0 ? `
    <div class="invest-box">
      <div><strong>Upfront investment: ${eurSym(c.investment.cash)}</strong></div>
      <ul>${c.investment.items.map(i => `<li>${esc(i.label)}: ${esc(i.formula)} = <strong>${eurSym(i.amount)}</strong>`
        + (i.assumption ? ` <span class="assume-tag" title="${esc(i.assumption)}">organiser assumption (rate card)</span>` : '') + '</li>').join('')}</ul>
      <div class="cm-small">Charged to this period: ${eurSym(c.investment.chargedThisPeriod)} (spread over 8 years).
        ${pb?.shifts != null ? `Paid back after about ${pb.shifts.toLocaleString('en-US')} shifts (≈ ${Math.round(pb.years * 10) / 10} years).` : 'It does not pay back at these numbers.'}</div>
    </div>` : '';

  container.innerHTML = `
    <div class="cost-head">Cost of the improvement</div>
    <div class="cost-basis">${esc(basisLabel ?? `Averages of ${c.basis.runs} runs over ${c.basis.shifts} shifts.`)}</div>
    <div class="cost-headline">${badges ? `<span class="cost-badges">${badges}</span> ` : ''}${boldHtml(c.headline)}</div>
    <div class="cost-tables">
      <table class="cost-table">
        <thead><tr><th colspan="3">What you pay</th></tr><tr class="sub"><th>Item</th><th>How it's calculated</th><th class="amt">Amount</th></tr></thead>
        <tbody>${costRows(c.pay, true) || '<tr><td colspan="3" class="how">Nothing extra to pay.</td></tr>'}</tbody>
        <tfoot><tr><td colspan="2">Total cost of the improvement</td><td class="amt ${t.costOfImprovement > 0 ? 'amt-bad' : 'amt-good'}">${eurSym(t.costOfImprovement)}</td></tr></tfoot>
      </table>
      <table class="cost-table">
        <thead><tr><th colspan="3">What you get</th></tr><tr class="sub"><th>Item</th><th>How it's calculated</th><th class="amt">Amount</th></tr></thead>
        <tbody>${costRows(c.get, false) || '<tr><td colspan="3" class="how">Nothing gained.</td></tr>'}</tbody>
        <tfoot><tr><td colspan="2">Net effect on profit</td><td class="amt ${t.profitChangeOfficial >= 0 ? 'amt-good' : 'amt-bad'}">${eurSym(t.profitChangeOfficial)}</td></tr></tfoot>
      </table>
    </div>
    ${t.unsoldStockValue > 0 ? `<div class="cm-small cost-unsold">Of which ${Math.round(t.unsoldSets * 10) / 10} sets nobody ordered, worth ${eurSym(t.unsoldStockValue)} on paper → <strong>conservative net effect ${eurSym(t.profitChangeConservative)}</strong></div>` : ''}
    ${invest}
    <div class="cost-chips">${rescuedChip}${paybackChip}</div>
    <div class="bridge-wrap">${bridgeSvg(c)}</div>
    ${note ? `<div class="cm-note">${esc(note)}</div>` : ''}`;
}

// ── Current Situation bar (demo values from GET /api/current-situation; visual only) ──

function daysAgoText(isoDate) {
  const d = new Date(isoDate + 'T00:00:00');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((today - d) / 86400000);
  return days <= 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`;
}
const niceDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

// ── ERP stock: editable, and used by the simulation when "Start from this stock" is on ──
// Off (default): runs start empty, as the data package's reference scenarios. On: raw material is safety stock
// at the SOURCE (used only while the supplier is out), finished sets wait at the end of the line (SINK) and
// serve the first orders. The edited values and the switch are remembered in this browser only.
const ERP_MAX = { finished: 500, raw: 2000 };
const erp = { loaded: false, erpFinished: 0, erpRaw: 0, finished: 0, raw: 0, use: false };

function erpStored(key) { try { return localStorage.getItem(`ui.erp.${key}`); } catch { return null; } }
function erpStore(key, v) { try { localStorage.setItem(`ui.erp.${key}`, String(v)); } catch { /* no storage */ } }
const erpValid = (k, v) => Number.isInteger(v) && v >= 0 && v <= ERP_MAX[k];

// The start the next run uses: null = empty stock (the reference)
function erpStart() {
  if (!erp.loaded || !erp.use) return null;
  return { finished: erp.finished, raw: erp.raw };
}
const erpStartKey = () => { const s = erpStart(); return s ? `${s.finished}/${s.raw}` : '0/0'; };

function renderErpState() {
  const on = erp.use;
  for (const k of ['finished', 'raw']) {
    const input = document.getElementById(`erp-${k}`);
    if (!input) continue;
    const v = Number(input.value);
    input.classList.toggle('invalid', !erpValid(k, v));
    const reset = document.getElementById(`erp-${k}-reset`);
    const base = k === 'finished' ? erp.erpFinished : erp.erpRaw;
    if (reset) reset.hidden = erp[k] === base;
  }
  document.querySelectorAll('.cs-link').forEach(e => e.classList.toggle('on', on));
  const note = document.getElementById('erp-note');
  if (note) {
    note.textContent = on
      ? `Next run starts with ${erp.raw} raw units at the source (safety stock, used only while the supplier is out) `
        + `and ${erp.finished} finished sets in the warehouse (they serve the first orders). The cards and checks use the same stock.`
      : 'Off: runs start with an empty warehouse, as the data package\'s reference scenarios.';
    if (erp.stale) note.textContent += ' Click Simulate to run with this setting: the results below are from the previous one.';
    note.classList.toggle('stale', !!erp.stale);
  }
}

// A change of the starting stock: new card values; the results shown are from the old stock until Simulate
function erpChanged() {
  erp.stale = !!lastSummary;
  scheduleCards();
}

async function loadCurrentSituation() {
  const tiles = document.getElementById('cs-tiles');
  const meta = document.getElementById('cs-meta');
  let d;
  try { d = await (await fetch('/api/current-situation')).json(); } catch { d = { source: 'unavailable' }; }
  if (d.source === 'unavailable') {
    tiles.innerHTML = '<div class="cs-tile"><div class="cs-sub">No data</div></div>';
    meta.textContent = '';
    return;
  }
  erp.erpFinished = d.finishedGoods.value;
  erp.erpRaw = d.rawMaterial.value;
  const num = (k, base) => { const v = Number(erpStored(k)); return erpStored(k) !== null && erpValid(k, v) ? v : base; };
  erp.finished = num('finished', erp.erpFinished);
  erp.raw = num('raw', erp.erpRaw);
  erp.use = erpStored('use') === '1';
  erp.loaded = true;

  const stockTile = (k, label, link, unit, base) => `
    <div class="cs-tile">
      <div class="cs-label">${esc(label)} <span class="cs-link" title="Where this stock enters the simulation">${link}</span></div>
      <div class="cs-edit">
        <input type="number" id="erp-${k}" class="cs-input" min="0" max="${ERP_MAX[k]}" step="1" value="${erp[k]}" aria-label="${esc(label)}" />
        <span class="cs-unit">${esc(unit)}</span>
        <button id="erp-${k}-reset" class="link-btn" type="button" hidden>ERP value: ${esc(base)}</button>
      </div>
    </div>`;
  const latest = [...d.maintenance].sort((a, b) => b.lastCompleted.localeCompare(a.lastCompleted))[0];
  tiles.innerHTML = `
    ${stockTile('raw', 'Raw-material stock', '→ SOURCE', d.rawMaterial.unit, erp.erpRaw)}
    ${stockTile('finished', 'Finished-goods stock', '→ SINK (warehouse)', d.finishedGoods.unit, erp.erpFinished)}
    <div class="cs-tile"><div class="cs-label">Last maintenance</div>
      <div class="cs-value">${esc(latest.machine)} ${esc(latest.name)}</div>
      <div class="cs-sub">${esc(niceDate(latest.lastCompleted))} (${esc(daysAgoText(latest.lastCompleted))}) · ${esc(latest.type)}</div>
      <button id="cs-all" class="link-btn" type="button">all machines</button>
      <ul id="cs-list" class="cs-list" hidden>${d.maintenance.map(m =>
        `<li>${esc(m.machine)} ${esc(m.name)} – ${esc(niceDate(m.lastCompleted))} (${esc(daysAgoText(m.lastCompleted))}) · ${esc(m.type)}</li>`).join('')}</ul>
    </div>`;
  const asOf = new Date(d.asOf);
  meta.textContent = `${d.source === 'demo' ? 'Demo data – not connected' : 'Data'} · as of ${asOf.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}, ${asOf.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  document.getElementById('cs-all').addEventListener('click', () => {
    const list = document.getElementById('cs-list');
    list.hidden = !list.hidden;
    document.getElementById('cs-all').textContent = list.hidden ? 'all machines' : 'hide';
  });

  for (const k of ['finished', 'raw']) {
    const input = document.getElementById(`erp-${k}`);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      if (input.value.trim() !== '' && erpValid(k, v)) { erp[k] = v; erpStore(k, v); if (erp.use) erpChanged(); }
      renderErpState();
    });
    document.getElementById(`erp-${k}-reset`).addEventListener('click', () => {
      erp[k] = k === 'finished' ? erp.erpFinished : erp.erpRaw;
      input.value = erp[k];
      erpStore(k, erp[k]);
      if (erp.use) erpChanged();
      renderErpState();
    });
  }
  const toggle = document.getElementById('erp-use');
  toggle.checked = erp.use;
  toggle.addEventListener('change', () => {
    erp.use = toggle.checked;
    erpStore('use', erp.use ? '1' : '0');
    erpChanged();
    renderErpState();
  });
  renderErpState();
}

// ── Light / dark theme (the choice is set before the first paint by the script in index.html) ──
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  const btn = document.getElementById('theme-toggle');
  btn.querySelector('.theme-icon').textContent = t === 'dark' ? '☀' : '☾';
  btn.querySelector('.theme-text').textContent = t === 'dark' ? 'Light' : 'Dark';
  btn.title = t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
}
applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
document.getElementById('theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('ui.theme', next); } catch { /* no storage: the choice lasts for this page */ }
  applyTheme(next);
});

// ── Collapsible sections and sub-blocks (state remembered in localStorage) ────

function storedCollapsed(id, dflt) {
  try {
    const v = localStorage.getItem(`ui.collapsed.${id}`);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch { /* no storage: use the default */ }
  return dflt;
}
function storeCollapsed(id, collapsed) {
  try { localStorage.setItem(`ui.collapsed.${id}`, collapsed ? '1' : '0'); } catch { /* ignore */ }
}

// mode 'section': a header row (title + chevron) above the body, which is wrapped and hidden when collapsed.
// mode 'row': the chevron goes into the row's label; every other child of the row is hidden when collapsed.
function makeCollapsible(el, { id, title, defaultCollapsed = false, mode = 'section' }) {
  if (!el) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sec-toggle';
  btn.innerHTML = '<span class="chev" aria-hidden="true">▾</span>';
  btn.title = 'Collapse / expand';

  if (mode === 'section') {
    const h = [...el.children].find(c => c.tagName === 'H2' && !c.id);
    const name = title ?? h?.textContent ?? id;
    h?.remove();
    const head = document.createElement('div');
    head.className = 'sec-head';
    const t = document.createElement('span');
    t.className = 'sec-title';
    t.textContent = name;
    head.append(t, btn);
    const body = document.createElement('div');
    body.className = 'sec-body';
    body.id = `${id}-body`;
    while (el.firstChild) body.appendChild(el.firstChild);
    el.append(head, body);
    btn.setAttribute('aria-controls', body.id);
    btn.setAttribute('aria-label', `Collapse or expand ${name}`);
  } else {
    el.classList.add('row-mode');
    const label = el.querySelector('.section-label') ?? el.querySelector('label');
    label.classList.add('sec-keep');
    label.prepend(btn);
    if (!el.id) el.id = `${id}-row`;
    btn.setAttribute('aria-controls', el.id);
    btn.setAttribute('aria-label', `Collapse or expand ${title ?? id}`);
  }

  const apply = (collapsed) => {
    el.classList.toggle('is-collapsed', collapsed);
    btn.setAttribute('aria-expanded', String(!collapsed));
  };
  apply(storedCollapsed(id, defaultCollapsed));
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    const next = !el.classList.contains('is-collapsed');
    apply(next);
    storeCollapsed(id, next);
  });
}

function setupCollapsibles() {
  const sec = (elId, title, dflt = false) => makeCollapsible(document.getElementById(elId), { id: elId, title, defaultCollapsed: dflt });
  sec('current-situation', 'Current Situation');
  makeCollapsible(document.getElementById('scenario-bar'), { id: 'scenario-bar', title: 'Scenario', mode: 'row' });
  sec('pipeline-container', 'Production line');
  sec('results', 'Results');
  sec('advisor', 'AI shift advisor');
  sec('compare', 'Side-by-side comparison');
  sec('controls', 'Advanced controls', true);
  sec('metrics', 'Advanced metrics', true);

  // Sub-blocks of Advanced controls
  const rows = [
    ['ctl-playback', 'Simulation Control', document.querySelector('#controls .controls-row')],
    ['ctl-presets', 'Scenarios', document.getElementById('preset-row')],
    ['ctl-plant', 'Plant default', document.getElementById('plant-row')],
    ['ctl-realism', 'Realism', document.getElementById('realism-row')],
    ['ctl-speed', 'Speed', document.querySelector('#controls .controls-row:has(.speed-btn)')],
    ['ctl-source', 'Source', document.querySelector('#controls .controls-row:has(#src-interval)')],
    ['ctl-cycle', 'Machine cycle times', document.getElementById('machine-sliders')],
    ['ctl-buffers', 'Buffer capacities', document.getElementById('buffer-sliders')],
  ];
  for (const [id, title, el] of rows) makeCollapsible(el, { id, title, mode: 'row' });

  // Blocks of Advanced metrics: each gets its own header row
  const block = (id, title, el) => {
    if (!el) return;
    const wrap = document.createElement('div');
    wrap.id = id;
    el.replaceWith(wrap);
    wrap.appendChild(el);
    makeCollapsible(wrap, { id, title });
  };
  block('mx-cards', 'Summary cards', document.querySelector('#metrics > .sec-body > .metric-cards'));
  block('mx-orders', 'Orders & economics', document.getElementById('kpi-panel'));
  block('mx-spark', 'Throughput', document.querySelector('#metrics .sparkline-wrap'));
  block('mx-machines', 'Machines', document.querySelector('#metrics .machine-table-wrap'));
}

setupCollapsibles();
loadCurrentSituation();
refreshRunButtons();
setInterval(pollResults, 2000);          // notices a run that was reset with the advanced controls
