/**
 * pipeline-view.js
 * A self-contained animated diagram of the line, for several diagrams on one page
 * (the side-by-side comparison). Every element id carries a prefix, and all layout,
 * connector and particle state lives on the instance.
 *
 * The main diagram in app.js (buildPipeline / updatePipeline) still has its own copy of this
 * drawing code, left untouched to avoid regressions: PipelineView should replace it later.
 *
 *   const view = new PipelineView(svgElement, { idPrefix: 'cmpA-', particles: true });
 *   view.build(state);            // when the set of machines changes (first frame)
 *   view.update(state, metrics);  // every frame
 *   view.destroy();               // stops the animation loop
 */

const MAIN_Y = 130;
const SRC_W = 80, SRC_H = 80;
const MACH_W = 110, MACH_H = 80;
const BUF_W = 70, BUF_H = 60;
const SINK_W = 70, SINK_H = 70;
const COL_GAP = 34, VGAP = 16, X0 = 20;

const PARTICLE_DURATION_MS = 400;
const PARTICLE_RADIUS = 3.5;
const POOL_MAX_SIZE = 96;

const NS = 'http://www.w3.org/2000/svg';
const ARC = { PROCESSING: '#22c55e', IDLE: '#cbd2de', STARVED: '#f59e0b', BLOCKED: '#ef4444', DOWN: '#a855f7' };
const BADGE_TEXT = { PROCESSING: '#166534', IDLE: '#5b6475', STARVED: '#92400e', BLOCKED: '#991b1b', DOWN: '#6b21a8' };
const BADGE_BG = { PROCESSING: '#dcfce7', IDLE: '#eef0f4', STARVED: '#fef3c7', BLOCKED: '#fee2e2', DOWN: '#f3e8ff' };

function el(tag, attrs = {}) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function txt(content, attrs = {}) {
  const t = el('text', { 'font-family': 'monospace', 'font-size': '11', fill: '#1f2430', ...attrs });
  t.textContent = content;
  return t;
}

// Left-to-right column layout from the simulation state (parallel machines stack vertically).
function computeLayout(state) {
  const bufById = {};
  for (const b of state.buffers) bufById[b.id] = b;
  const produced = new Set(state.machines.map(m => m.outputBufferId).filter(id => id != null));
  const srcBuf = state.buffers.find(b => !produced.has(b.id)) ?? state.buffers[0];
  const stationByInput = {};
  for (const m of state.machines) (stationByInput[m.inputBufferId] ??= []).push(m);

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

  const widthOf = (c) => c.kind === 'source' ? SRC_W : c.kind === 'buffer' ? BUF_W : c.kind === 'station' ? MACH_W : SINK_W;
  let x = X0;
  for (const c of columns) { c.x = x; x += widthOf(c) + COL_GAP; }
  const totalW = x - COL_GAP + X0;

  const pos = { machines: {}, buffers: {}, source: null, sink: null, scrap: null };
  let minY = MAIN_Y - SRC_H / 2, maxY = MAIN_Y + SRC_H / 2;
  for (const c of columns) {
    if (c.kind === 'source') pos.source = { x: c.x };
    else if (c.kind === 'sink') pos.sink = { x: c.x };
    else if (c.kind === 'buffer') pos.buffers[c.buffer.id] = { x: c.x, y: MAIN_Y - BUF_H / 2 };
    else if (c.kind === 'station') {
      const k = c.machines.length;
      c.machines.forEach((m, j) => {
        const cy = MAIN_Y + (j - (k - 1) / 2) * (MACH_H + VGAP);
        const y = cy - MACH_H / 2;
        pos.machines[m.id] = { x: c.x, y, cx: c.x + MACH_W / 2, cy };
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y + MACH_H);
      });
    }
  }
  const rejectCol = columns.find(c => c.kind === 'station' && c.machines.some(m => m.rejectRate > 0));
  const scrapY = maxY + 40;
  pos.scrap = { x: rejectCol ? rejectCol.x : totalW / 2, y: scrapY };
  maxY = scrapY + SINK_H;

  const connectors = [];
  if (pos.source && pos.buffers[srcBuf.id]) {
    connectors.push({ id: 'conn-src-b0', destBufferId: srcBuf.id, x1: pos.source.x + SRC_W, y1: MAIN_Y, x2: pos.buffers[srcBuf.id].x, y2: MAIN_Y });
  }
  for (const m of state.machines) {
    const mp = pos.machines[m.id];
    const inBuf = pos.buffers[m.inputBufferId];
    if (inBuf) connectors.push({ id: `conn-in-${m.id}`, destBufferId: null, x1: inBuf.x + BUF_W, y1: MAIN_Y, x2: mp.x, y2: mp.cy });
    if (m.outputBufferId == null) {
      connectors.push({ id: `conn-out-${m.id}`, destBufferId: null, x1: mp.x + MACH_W, y1: mp.cy, x2: pos.sink.x, y2: MAIN_Y });
    } else {
      const outBuf = pos.buffers[m.outputBufferId];
      if (outBuf) connectors.push({ id: `conn-out-${m.id}`, destBufferId: m.outputBufferId, x1: mp.x + MACH_W, y1: mp.cy, x2: outBuf.x, y2: MAIN_Y });
    }
    if (m.rejectRate > 0) {
      const sy = pos.scrap.y + SINK_H / 2;
      connectors.push({ id: `conn-scrap-${m.id}`, destBufferId: null, isPath: true,
        d: `M ${mp.cx} ${mp.y + MACH_H} L ${mp.cx} ${sy} L ${pos.scrap.x} ${sy}` });
    }
  }
  const vbY = minY - 20;
  return { columns, pos, connectors, srcBufId: srcBuf.id, viewBox: { x: 0, y: vbY, w: totalW, h: (maxY - vbY) + 20 } };
}

// prev/next state -> particle spawn events { connectorId, kind, count }
function detectTransfers(prev, next) {
  if (!prev || !next) return [];
  const events = [];
  const srcDelta = (next.source?.totalGenerated ?? 0) - (prev.source?.totalGenerated ?? 0);
  if (srcDelta > 0) events.push({ connectorId: 'conn-src-b0', kind: 'good', count: srcDelta });
  const prevMach = {};
  for (const m of prev.machines) prevMach[m.id] = m;
  const scrapDelta = (next.scrap?.partsReceived ?? 0) - (prev.scrap?.partsReceived ?? 0);
  const rejectDeltas = {};
  let sumReject = 0;
  for (const m of next.machines) {
    if (m.rejectRate > 0) {
      const d = Math.max(0, m.partsProcessed - (prevMach[m.id]?.partsProcessed ?? 0));
      rejectDeltas[m.id] = d; sumReject += d;
    }
  }
  for (const m of next.machines) {
    const pm = prevMach[m.id];
    if (m.currentPartId != null && pm && pm.currentPartId !== m.currentPartId) {
      events.push({ connectorId: `conn-in-${m.id}`, kind: 'good', count: 1 });
    }
    const dProcessed = m.partsProcessed - (pm?.partsProcessed ?? 0);
    if (dProcessed <= 0) continue;
    if (m.rejectRate > 0) {
      const myScrap = sumReject > 0 ? Math.round(scrapDelta * (rejectDeltas[m.id] / sumReject)) : 0;
      const myGood = Math.max(0, dProcessed - myScrap);
      if (myScrap > 0) events.push({ connectorId: `conn-scrap-${m.id}`, kind: 'scrap', count: myScrap });
      if (myGood > 0) events.push({ connectorId: `conn-out-${m.id}`, kind: 'good', count: myGood });
    } else {
      events.push({ connectorId: `conn-out-${m.id}`, kind: 'good', count: dProcessed });
    }
  }
  return events;
}

export class PipelineView {
  // options: idPrefix (unique per diagram), particles (default true), onMachineClick(id)
  constructor(svg, { idPrefix = '', particles = true, onMachineClick = null } = {}) {
    this.svg = svg;
    this.prefix = idPrefix;
    this.particlesOn = particles;
    this.onMachineClick = onMachineClick;
    this.layout = null;
    this.builtKey = null;
    this.prevState = null;
    this.lastState = null;
    this.pointAt = {};
    this.pool = [];
    this.active = [];
    this.raf = null;
  }

  id(name) { return this.prefix + name; }
  byId(name) { return this.svg.querySelector('#' + CSS.escape(this.id(name))); }

  // Rebuild when the set of machines changed; otherwise just update
  ensureBuilt(state) {
    const key = state.machines.map(m => m.id).join(',');
    if (key !== this.builtKey) { this.build(state); this.builtKey = key; }
  }

  build(state) {
    const svg = this.svg;
    this.stopLoop();
    svg.innerHTML = '';
    this.pool = []; this.active = []; this.pointAt = {};
    this.prevState = state;

    const layout = this.layout = computeLayout(state);
    const vb = layout.viewBox;
    svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    for (const c of layout.connectors) {
      svg.appendChild(c.isPath
        ? el('path', { id: this.id(c.id), d: c.d, class: 'pipe-connector' })
        : el('line', { id: this.id(c.id), x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2, class: 'pipe-connector' }));
    }
    const defs = el('defs');
    const glow = el('filter', { id: this.id('part-glow'), x: '-50%', y: '-50%', width: '200%', height: '200%' });
    glow.appendChild(el('feGaussianBlur', { stdDeviation: '2.2' }));
    defs.appendChild(glow);
    svg.appendChild(defs);
    svg.appendChild(el('g', { id: this.id('particle-layer'), filter: `url(#${this.id('part-glow')})` }));
    this._cacheGeometry();

    this._drawSource(layout.pos.source);
    for (const b of state.buffers) this._drawBuffer(b, layout.pos.buffers[b.id]);
    for (const m of state.machines) this._drawMachine(m, layout.pos.machines[m.id]);
    this._drawSink(layout.pos.sink);
    this._drawScrap(layout.pos.scrap);
    if (this.particlesOn) this.startLoop();
  }

  destroy() { this.stopLoop(); }

  // ── drawing ───────────────────────────────────────────────────────────────
  _drawSource(p) {
    const x = p.x, y = MAIN_Y - SRC_H / 2;
    const g = el('g', { id: this.id('elem-SOURCE') });
    g.appendChild(el('rect', { x, y, width: SRC_W, height: SRC_H, rx: 6, fill: '#ffffff', stroke: '#4f46e5', 'stroke-width': 1.5 }));
    g.appendChild(el('rect', { x: x + 8, y: y + SRC_H - 20, width: SRC_W - 16, height: 10, rx: 3, fill: '#e5e8ef' }));
    g.appendChild(el('rect', { id: this.id('src-stock-fill'), x: x + 8, y: y + SRC_H - 20, width: SRC_W - 16, height: 10, rx: 3, fill: '#6366f1' }));
    g.appendChild(txt('SOURCE', { x: x + SRC_W / 2, y: y + 18, 'text-anchor': 'middle', 'font-size': '10', fill: '#4f46e5' }));
    g.appendChild(txt('', { id: this.id('src-stock-text'), x: x + SRC_W / 2, y: y + 38, 'text-anchor': 'middle' }));
    this.svg.appendChild(g);
  }

  _drawBuffer(buf, p) {
    const g = el('g', { id: this.id(`elem-${buf.id}`) });
    g.appendChild(el('rect', { x: p.x, y: p.y, width: BUF_W, height: BUF_H, rx: 5, fill: '#ffffff', stroke: '#cbd2de', 'stroke-width': 1.2 }));
    g.appendChild(txt(buf.id, { x: p.x + BUF_W / 2, y: p.y + 13, 'text-anchor': 'middle', 'font-size': '9', fill: '#64748b' }));
    g.appendChild(txt('0/0', { id: this.id(`buf-load-${buf.id}`), x: p.x + BUF_W / 2, y: p.y + BUF_H - 5, 'text-anchor': 'middle', 'font-size': '10' }));
    g.appendChild(el('g', { id: this.id(`buf-slots-${buf.id}`) }));
    this.svg.appendChild(g);
  }

  _drawMachine(m, p) {
    const id = m.id, x = p.x, y = p.y;
    const g = el('g', { id: this.id(`elem-${id}`) });
    if (this.onMachineClick) g.addEventListener('click', () => this.onMachineClick(id));
    g.appendChild(el('rect', { id: this.id(`mach-rect-${id}`), x, y, width: MACH_W, height: MACH_H, rx: 8,
      class: 'machine-rect IDLE', fill: '#ffffff', stroke: '#cbd2de', 'stroke-width': 1.5 }));
    const name = m.name.length > 17 ? m.name.slice(0, 16) + '…' : m.name;
    g.appendChild(txt(name, { x: x + MACH_W / 2, y: y + 11, 'text-anchor': 'middle', 'font-size': '9.5', fill: '#5b6475' }));
    g.appendChild(txt(id, { x: x + MACH_W / 2, y: y + 22, 'text-anchor': 'middle', 'font-size': '9', fill: '#64748b' }));
    const cx = x + MACH_W / 2, cy = y + MACH_H / 2 + 6, r = 20, circ = 2 * Math.PI * r;
    g.appendChild(el('circle', { cx, cy, r, fill: 'none', stroke: '#e5e8ef', 'stroke-width': 4 }));
    g.appendChild(el('circle', { id: this.id(`mach-arc-${id}`), cx, cy, r, fill: 'none', stroke: '#22c55e', 'stroke-width': 4,
      'stroke-dasharray': circ.toFixed(2), 'stroke-dashoffset': circ.toFixed(2), transform: `rotate(-90 ${cx} ${cy})` }));
    g.appendChild(txt('0%', { id: this.id(`mach-util-${id}`), x: cx, y: cy + 4, 'text-anchor': 'middle', 'font-size': '9', fill: '#5b6475' }));
    g.appendChild(el('rect', { id: this.id(`mach-badge-bg-${id}`), x: x + 4, y: y + MACH_H - 18, width: 50, height: 14, rx: 7, fill: '#eef0f4' }));
    g.appendChild(txt('IDLE', { id: this.id(`mach-badge-${id}`), x: x + 29, y: y + MACH_H - 7, 'text-anchor': 'middle', 'font-size': '8', fill: '#5b6475' }));

    const bn = el('g', { id: this.id(`mach-bn-${id}`), class: 'mach-bn-marker', visibility: 'hidden' });
    const bw = 78, bh = 18, bx = x + MACH_W / 2 - bw / 2, by = y - bh - 10;
    bn.appendChild(el('rect', { x: bx, y: by, width: bw, height: bh, rx: 9, fill: '#ffedd5', stroke: '#f97316', 'stroke-width': 1.2 }));
    bn.appendChild(txt('⚠ BOTTLENECK', { x: x + MACH_W / 2, y: by + bh - 5, 'text-anchor': 'middle', 'font-size': '10', 'font-weight': '700',
      fill: '#c2410c', 'font-family': 'Inter, system-ui, sans-serif' }));
    const ax = x + MACH_W / 2;
    bn.appendChild(el('polygon', { points: `${ax - 5},${by + bh} ${ax + 5},${by + bh} ${ax},${y - 1}`, fill: '#f97316' }));
    g.appendChild(bn);
    this.svg.appendChild(g);
  }

  _drawSink(p) {
    const x = p.x, y = MAIN_Y - SINK_H / 2;
    const g = el('g', { id: this.id('elem-SINK') });
    g.appendChild(el('rect', { x, y, width: SINK_W, height: SINK_H, rx: 6, fill: '#ffffff', stroke: '#22c55e', 'stroke-width': 1.5 }));
    g.appendChild(txt('SINK', { x: x + SINK_W / 2, y: y + 16, 'text-anchor': 'middle', 'font-size': '10', fill: '#166534' }));
    g.appendChild(txt('0', { id: this.id('sink-count'), x: x + SINK_W / 2, y: y + 40, 'text-anchor': 'middle', 'font-size': '20', fill: '#22c55e', 'font-weight': 'bold' }));
    g.appendChild(txt('parts', { x: x + SINK_W / 2, y: y + SINK_H - 6, 'text-anchor': 'middle', 'font-size': '9', fill: '#16a34a' }));
    this.svg.appendChild(g);
  }

  _drawScrap(p) {
    const x = p.x, y = p.y;
    const g = el('g', { id: this.id('elem-SCRAP') });
    g.appendChild(el('rect', { x, y, width: SINK_W, height: SINK_H, rx: 6, fill: '#ffffff', stroke: '#ef4444', 'stroke-width': 1.5 }));
    g.appendChild(txt('SCRAP', { x: x + SINK_W / 2, y: y + 16, 'text-anchor': 'middle', 'font-size': '10', fill: '#b91c1c' }));
    g.appendChild(txt('0', { id: this.id('scrap-count'), x: x + SINK_W / 2, y: y + 40, 'text-anchor': 'middle', 'font-size': '20', fill: '#ef4444', 'font-weight': 'bold' }));
    g.appendChild(txt('scrapped', { x: x + SINK_W / 2, y: y + SINK_H - 6, 'text-anchor': 'middle', 'font-size': '9', fill: '#991b1b' }));
    this.svg.appendChild(g);
  }

  // ── update ────────────────────────────────────────────────────────────────
  update(state, metrics) {
    if (!state) return;
    this.ensureBuilt(state);
    this.lastState = state;

    const src = state.source;
    const fill = this.byId('src-stock-fill'), text = this.byId('src-stock-text');
    if (fill) {
      const ratio = src.materialStock < 0 ? 1 : Math.min(src.materialStock / 200, 1);
      fill.setAttribute('width', (ratio * (SRC_W - 16)).toFixed(1));
      fill.setAttribute('fill', ratio > 0.3 ? '#6366f1' : ratio > 0.1 ? '#f59e0b' : '#ef4444');
    }
    if (text) text.textContent = src.materialStock < 0 ? '∞' : src.materialStock;

    for (const buf of state.buffers) this._updateBuffer(buf);

    const mm = {};
    for (const m of metrics?.machines ?? []) mm[m.id] = m;
    for (const m of state.machines) this._updateMachine(m, mm[m.id]);

    const bufMap = {};
    for (const b of state.buffers) bufMap[b.id] = b;
    for (const c of this.layout.connectors) {
      if (!c.destBufferId) continue;
      const buf = bufMap[c.destBufferId];
      const blocked = !!buf && buf.load >= buf.capacity;
      const node = this.byId(c.id);
      if (node) {
        node.setAttribute('class', blocked ? 'pipe-connector blocked' : 'pipe-connector');
        node.setAttribute('stroke', blocked ? '#ef4444' : '#cbd2de');
      }
    }
    const sink = this.byId('sink-count'), scrap = this.byId('scrap-count');
    if (sink) sink.textContent = state.sink.partsReceived;
    if (scrap) scrap.textContent = state.scrap.partsReceived;

    if (this.particlesOn) {
      const ev = detectTransfers(this.prevState, state);
      for (const e of ev) for (let i = 0; i < e.count && i < 4; i++) this._spawn(e.connectorId, e.kind, i * 80);
    }
    this.prevState = state;
  }

  _updateBuffer(buf) {
    const group = this.byId(`buf-slots-${buf.id}`), label = this.byId(`buf-load-${buf.id}`);
    if (!group) return;
    if (label) label.textContent = `${buf.load}/${buf.capacity}`;
    const bp = this.layout.pos.buffers[buf.id];
    if (!bp) return;
    group.innerHTML = '';
    const cap = buf.capacity;
    const size = Math.min(14, (BUF_W - 10) / cap - 3);
    const totalW = cap * size + (cap - 1) * 3;
    const startX = bp.x + (BUF_W - totalW) / 2;
    const slotY = bp.y + BUF_H / 2 - size / 2 - 4;
    const ratio = cap > 0 ? buf.load / cap : 0;
    for (let i = 0; i < cap; i++) {
      const occupied = i < buf.load;
      let cls = occupied ? 'buf-slot-full' : 'buf-slot-empty';
      if (occupied && ratio > 0.99) cls += ' alert';
      else if (occupied && ratio > 0.75) cls += ' warn';
      group.appendChild(el('rect', { x: startX + i * (size + 3), y: slotY, width: size, height: size, rx: 2, class: cls }));
    }
  }

  _updateMachine(m, mm) {
    const arc = this.byId(`mach-arc-${m.id}`);
    if (!arc) return;
    const circ = 2 * Math.PI * 20;
    const progress = m.cycleTime > 0 ? 1 - (m.ticksLeft / m.cycleTime) : 0;
    arc.setAttribute('stroke-dashoffset', (circ * (1 - Math.max(0, Math.min(1, progress)))).toFixed(2));
    arc.setAttribute('stroke', ARC[m.state] ?? '#cbd2de');
    const badge = this.byId(`mach-badge-${m.id}`), bg = this.byId(`mach-badge-bg-${m.id}`);
    if (badge) { badge.textContent = m.state; badge.setAttribute('fill', BADGE_TEXT[m.state] ?? '#5b6475'); }
    if (bg) bg.setAttribute('fill', BADGE_BG[m.state] ?? '#eef0f4');
    const isBn = mm?.bottleneck ?? false;
    this.byId(`mach-bn-${m.id}`)?.setAttribute('visibility', isBn ? 'visible' : 'hidden');
    const rect = this.byId(`mach-rect-${m.id}`);
    if (rect) {
      rect.setAttribute('class', isBn ? 'machine-rect bottleneck' : `machine-rect ${m.state}`);
      rect.setAttribute('stroke', isBn ? '#f97316' : (ARC[m.state] ?? '#cbd2de'));
    }
    const util = this.byId(`mach-util-${m.id}`);
    if (util && mm) util.textContent = (mm.utilization * 100).toFixed(0) + '%';
  }

  // ── particles ─────────────────────────────────────────────────────────────
  _cacheGeometry() {
    for (const { id } of this.layout.connectors) {
      const node = this.byId(id);
      if (!node) continue;
      if (node.tagName === 'line') {
        const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map(a => parseFloat(node.getAttribute(a)));
        this.pointAt[id] = (t) => ({ x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t });
      } else {
        const len = node.getTotalLength();
        this.pointAt[id] = (t) => { const p = node.getPointAtLength(len * t); return { x: p.x, y: p.y }; };
      }
    }
  }

  _acquire() {
    for (const s of this.pool) if (!s.inUse) { s.inUse = true; s.head.classList.remove('hidden'); s.tail.classList.remove('hidden'); return s; }
    if (this.pool.length >= POOL_MAX_SIZE) return null;
    const layer = this.byId('particle-layer');
    const tail = el('circle', { r: PARTICLE_RADIUS * 1.6, class: 'particle-tail' });
    const head = el('circle', { r: PARTICLE_RADIUS, class: 'particle' });
    layer.appendChild(tail); layer.appendChild(head);
    const s = { head, tail, inUse: true };
    this.pool.push(s);
    return s;
  }

  _release(s) { s.inUse = false; s.head.classList.add('hidden'); s.tail.classList.add('hidden'); }

  _spawn(connectorId, kind, delayMs) {
    if (!this.pointAt[connectorId]) return;
    const slot = this._acquire();
    if (!slot) return;
    for (const n of [slot.head, slot.tail]) n.classList.toggle('scrap', kind === 'scrap');
    this.active.push({ slot, connectorId, startedAt: performance.now() + delayMs });
  }

  _isDestFull(connectorId) {
    const conn = this.layout.connectors.find(c => c.id === connectorId);
    if (!conn?.destBufferId || !this.lastState) return false;
    const buf = this.lastState.buffers.find(b => b.id === conn.destBufferId);
    return buf ? buf.load >= buf.capacity : false;
  }

  _advance(now) {
    const jam = {};
    for (let i = this.active.length - 1; i >= 0; i--) {
      const p = this.active[i];
      const fn = this.pointAt[p.connectorId];
      const raw = (now - p.startedAt) / PARTICLE_DURATION_MS;
      let t = Math.max(0, Math.min(1, raw));
      let jammed = false;
      if (t > 0.85 && this._isDestFull(p.connectorId)) {
        const idx = jam[p.connectorId] = (jam[p.connectorId] ?? -1) + 1;
        t = Math.max(0.55, 0.85 - idx * 0.06);
        jammed = true;
      }
      if (!fn || (!jammed && raw >= 1)) { this._release(p.slot); this.active.splice(i, 1); continue; }
      const pt = fn(t), tp = fn(Math.max(0, t - 0.08));
      p.slot.head.setAttribute('cx', pt.x.toFixed(1)); p.slot.head.setAttribute('cy', pt.y.toFixed(1));
      p.slot.tail.setAttribute('cx', tp.x.toFixed(1)); p.slot.tail.setAttribute('cy', tp.y.toFixed(1));
    }
  }

  startLoop() {
    if (this.raf != null) return;
    const loop = (ts) => { this._advance(ts); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
  }

  stopLoop() {
    if (this.raf != null) cancelAnimationFrame(this.raf);
    this.raf = null;
  }
}
