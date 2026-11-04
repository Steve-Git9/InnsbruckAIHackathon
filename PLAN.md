# Plan: a more realistic line simulation (step 1); AI shift advisor comes later (step 2)

## Context
`Innsbruck_Hackathon/` is the machine_sim starter: a Node.js tick engine
(Source → M1 → M2 → M3 → M4 → Sink, 1 tick = 1 min, 480 ticks/shift), a Fastify UI, and
`src/headless/run.js`, which adds orders, service level, and a supplier outage *outside* the engine.
The data package (`README(4).md`, `rate_card.csv`, `failure_rates.csv`, `demand_profile.csv`) defines
the plant: about 36.8 good parts/shift, M3 as the bottleneck, the order and service-level rules, the cost rules, a baseline of EUR 102.8 per good unit,
and four reference scenarios (baseline 100%, supplier outage 76%, demand swing 57%, both 48%).

Problems: runs can't be reproduced (`Math.random` in `engine.js` `_advanceMachine`), and demand, outage and orders exist only in
the helper. There are no costs, no breakdowns, and no supply-side countermeasures.

**Goal of step 1:** make the simulation reliable enough to *test* proposals (seeded, engine-native,
priced, with breakdowns and a supply model), while the four reference scenarios stay **unchanged**.
All new realism can be switched on and is **off by default**, and new scenarios are added as extras.
`run.check.mjs` must keep printing ALL PASSED.

**User decisions:**
- The user is a shift supervisor.
- The LLM is the hackathon API (`api.py` proxy), used in step 2 only.
- The work spans several days, and the reference numbers stay as they are.
- A supply model is added.

**Deliberately not modelled:**
- Product variants and changeovers: the data says one product.
- Overtime: there's no rate for it.
- Cycle-time variability: there's no data for it.

Adding realism without data would make the model *less* reliable. This argument goes into the docs.

## Phase 1: Determinism + engine-native outage and orders
- **New `src/simulation/rng.js`**:
  - a mulberry32 PRNG plus `makeStream(seed, name)`, which hashes the name, so every random process gets its own stream (`reject:M2`, `fail:M3:PWF`, …);
  - common random numbers: turning on breakdowns doesn't shift the reject draws, so A/B comparisons are fair;
  - `seed ?? 1`, so seed 0 is valid and isn't swallowed by a falsy check.
- **`engine.js`**:
  - `_reset()` builds the streams from `config.seed`;
  - the reject gate uses the M2 stream;
  - the outage `config.source.outage = {startTick,endTick}` is an early return at the top of `_tickSource()` when `startTick < tick <= endTick`. The counter is frozen, as the README requires.
- **New `src/simulation/orders.js`** (`OrderBook`, pure class):
  - demand rows `{orderTick, dueTick, orders}`, finished-goods stock, and a FIFO backlog of order lots;
  - at each due tick it ships oldest first and records shipped-on-time, late and lost-sales units, plus per-shift rows (same fields as the helper);
  - the engine feeds it good parts as they reach the sink;
  - config: `config.demand`, `config.initialFinishedGoods`.
- **`run.js`**:
  - keep the existing `outage` option exactly as it is, with its interval hack: it is the README's *reference*;
  - add an engine-native path (`config.source.outage` + the engine OrderBook);
  - same output shape;
  - fix the OEE quality calculation, which is hardcoded to `m.id === 'M2'`, by giving each machine its own scrap counter.
- **Equivalence tests**:
  - same seed: the helper's outage gives the same per-shift rows as the engine outage (README requirement);
  - helper order rows match the engine OrderBook rows;
  - same seed gives an identical history.

## Phase 2: Costs (`src/economics/costs.js`, pure, plus `src/data/loaders.js` for the CSVs)
- `loadRateCard('rate_card.csv')` and `computeEconomics(result, config, baselineConfig, rateCard)`. Per shift and in total:
  - machine cost: every scheduled hour × the station rate, including parallel machines;
  - material, booked at release at the supplier lot's price;
  - WIP and finished-goods holding (per scheduled hour, using the README's average-stock rule);
  - lost sales;
  - revenue;
  - one-time costs amortised over 1,920 shifts, derived by comparing the config with the baseline: extra machines (depreciation *or* investment, not both), buffer slots, cycle-time ticks removed, reject percentage points removed, second-supplier qualification;
  - start and end finished-goods valuation at EUR 103;
  - profit and cost per good unit.
- **Calibration test:** the default line over 20 shifts lands at about EUR 102.8 per good unit (±1).

## Phase 3: Breakdowns (`src/simulation/failures.js`, `config.failures`, off by default)
- **Failure modes:**
  - from `failure_rates.csv`: TWF and HDF → M1, PWF and OSF → M3, RNF → all machines;
  - per-part probability, drawn when a part completes, from its own stream per machine and mode;
  - parallel machines inherit their station's modes.
- **New state `DOWN`** (`entities.js`):
  - the machine holds its part for the repair time, which is fixed by default as the data's assumption, with an optional exponential distribution;
  - `ticksDown` counter;
  - event `breakdown {machine, mode, start, repair}`.
- **Availability:** OEE availability = 1 − down/scheduled.
- **Collector** (`collector.js`): handles `winDown`. A DOWN bottleneck is still the constraint, not a "victim".
- **Expected effect:** about 0.9 lost ticks per M3 part, roughly 6–7% less output (about 34.5/shift). This is checked by a test against the analytical value, within a tolerance.

## Phase 4: Raw-material supply model (`src/simulation/supply.js`, `config.supply`)
- **Default mode `jit`:** the source behaves exactly as today, and the outage is a source halt. This keeps the references.
- **Mode `inventory`:**
  - raw stock at the source; each release consumes 1 unit;
  - (s,Q) reorder point and quantity, with supplier lead time;
  - optional starting safety stock;
  - outage: the primary supplier delivers nothing in the window, and late deliveries arrive after it;
  - second supplier (qualification EUR 2,000, +8% price, lead time as an assumption) used when the primary is out;
  - expediting (+40% price, short lead time as an assumption);
  - lots carry their price, so material cost is correct.
- **Raw-stock holding cost:** there's no rate-card row, so it's an explicit assumption in config (default = WIP rate) and documented.
- **Invariant test:** delivered = released + Δraw stock. Inventory mode with a large safety stock covers the outage, and service level recovers.

## Phase 5: Analysis layer (no LLM, prepares step 2) (`src/analysis/`)
- `summariseEvents`: per machine and per shift (the README says to summarise before the advisor sees it).
- `bottleneckLoss`: lost M3 minutes by cause (down / starved because of the outage / starved by upstream / blocked). This is the factual basis for later explanations.

## Phase 6: Scenarios + UI
- **`src/scenarios/scenarios.js` + `npm run scenarios`:**
  - the 4 reference scenarios, plus extras: breakdowns, breakdowns+outage, outage with safety stock / second supplier / expediting;
  - 30 seeds with common random numbers;
  - a table showing mean ± sd for SL, good/shift, scrap, WIP, line yield, OEE per machine, cost/unit, profit;
  - a slot for "with countermeasure", to be filled in step 2.
- **Server (`server.js`):** `/api/control` accepts `seed`, `outage`, `failures`, `supply`, `demand` (load the profile), and `initialFinishedGoods`. A new `GET /api/kpis` returns orders, SL and economics. The export includes the new columns.
- **UI (`src/public/`):**
  - a DOWN colour in all the colour maps in `app.js`;
  - a panel with orders, backlog, finished goods, SL, cost/unit and profit;
  - controls for seed, the outage window, the breakdown toggle, and supply mode;
  - a "Plant default" view labelled separately from the teaching presets.
- **Housekeeping:**
  - delete the identical `demand_profile (2).csv`;
  - rename `README(4).md` → `DATA_README.md`;
  - remove the CLIENT_ID from the comment in `api.py`;
  - update `README.md`.

## Step 2 (later, not in this plan's scope): AI shift advisor
The hackathon LLM explains only facts computed in Phase 5. It picks proposals from a typed catalogue (finished-goods pre-build,
safety stock, second supplier, expediting, buffer in front of M3, parallel M3, …). Each proposal is checked by the
scenario runner (multi-seed, common random numbers, ΔSL / Δprofit with confidence intervals) before the supervisor sees it.

## Verification
- `npm test` (existing and new unit tests) and `node src/headless/run.check.mjs` print **ALL PASSED**, unchanged.
- New tests: determinism; helper outage = engine outage per-shift rows (seeds 1 and 2); OrderBook = helper rows; baseline cost about EUR 102.8; breakdowns off = identical history; breakdown availability matches the analytical value; supply invariants and `jit` = reference.
- `npm run scenarios` shows the four references at about 100 / 76 / 57 / 48%, plus the extras.
- `npm start`: in the UI, load the plant default, turn on the outage and breakdowns, and check the DOWN state, the KPI panel, and that export works.
