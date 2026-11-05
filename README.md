# Machine simulation: starter for the production line case

A browser-based simulation of a production line: **Source → M1 (machining) → M2 (quality check) → M3 (assembly) → M4 (packaging) → Sink**. It is a discrete-event simulation in Node.js: **1 tick = 1 minute**, 1 shift = 480 ticks. The UI shows the line live (SVG over Server-Sent Events).

## Quick start

With Docker (Docker Desktop or Docker Engine with Compose):

```bash
docker compose up --build        # then open http://localhost:3000
```

The image copies `src/` when it is built, so run **`docker compose up --build` again after every code change**.

Without Docker (Node.js 20 or newer):

```bash
npm install
npm start                        # http://localhost:3000
npm run dev                      # same, restarts on file changes
npm test                         # unit tests
npm run scenarios                # the 4 reference scenarios + extras, 30 seeds, mean ± sd, with costs
node src/headless/run.check.mjs  # acceptance test of the helper, must print ALL PASSED
```

Environment variable: `PORT` (default `3000`).

## What you can do in the UI

Play, pause and reset the run, change the speed (up to 10x), tune cycle times, buffer capacities, source interval, material stock (the right end of its slider is ∞) and the reject rate of M2, spawn extra machines, load a scenario preset, and **export the simulation log** (the per-tick history) as CSV or JSON.

## CEO interface

The page is built for a plant CEO (the older engineering controls are hidden, not removed):

1. Choose a **scenario**: Standard, Demand Swing, Supplier Outage or Machinery Breakdown.
2. Click **Simulate**: the animated line runs 20 shifts at 10x (about 1.5 minutes) and stops by itself.
3. Read the **Results** tiles (orders on time, late sets, output, profit, bottleneck, worst shift, disruption).
4. **Explain me these results**: the AI shift advisor explains the run in plain words.
5. **How to improve the results?**: the advisor proposes one countermeasure from the catalogue (only Demand Swing has countermeasures for now); the simulation then tests it in 10 runs and shows a verdict.

6. For Demand Swing, step 5 first asks a short **questionnaire** (what matters most, how much you can invest, whether overtime is allowed, preferred kind of fix, free text) or **Give me the best** to skip it. Budget and overtime answers are hard limits enforced in code. After the proposal, **Compare side by side** shows two animated lines at the same time: the scenario as it is, and the same scenario with the countermeasure (speed x1, x2, x10, or Instant), with before/after tiles when both finish.

7. **Shifts**: the run length is chosen next to Simulate (1 to 60, default 20). It applies to the run, the Results, the 10-run check and the comparison. The reference values of the data package refer to 20 shifts.
8. For Demand Swing, **How to improve the results?** shows the three countermeasures as cards. Tick one or any combination, set the values and click **Test my selection**, or click **Ask the Intelligent Shift Advisor** for the questionnaire and AI flow above.
9. The **Current Situation** bar at the top shows demo values (finished-goods stock, raw-material stock, last maintenance) from `src/data/current_situation.json`. They are not connected to the simulation.
10. The old controls and metrics are back as **Advanced controls** and **Advanced metrics** (collapsed by default). Every section and sub-block can be collapsed, and the choice is remembered in the browser. Using an advanced control that resets or reconfigures the engine clears the CEO Results.

11. After a countermeasure is checked, the proposal card (and the side-by-side results) show **Cost of the improvement**: a headline, the tables "What you pay" and "What you get" with the formula and rate-card price of every line, the upfront investment, cost per rescued order against the EUR 90 penalty, the payback, and a profit bridge chart from the "As is" profit to the "With countermeasure" profit. The lines add up exactly to the profit change. All of it is computed by code, not by the AI.

The AI is called only from the server. It needs a `.env` file in the repo root with `CLIENT_ID` and `CLIENT_SECRET` (git-ignored; `docker compose` passes it to the container). The AI never produces numbers: every figure comes from the simulation. Related endpoints: `GET /api/results`, `POST /api/advisor/explain`, `POST /api/advisor/improve`.

## Realism layer (all of it is OFF by default)

The data package is in [DATA_README.md](DATA_README.md). On top of the starter, the engine can now be switched to behave like the plant it describes. **The four reference scenarios are unchanged** (baseline about 100%, supplier outage about 77%, demand swing about 57%, both about 48% service level): nothing below changes a run unless you switch it on.

| Feature | How | Where |
|---|---|---|
| **Seeded runs** | `config.seed` (0 is valid, default 1). Every random process has its own stream (`reject:M2`, `fail:M3:PWF`, ...), so switching one process on or off never shifts the draws of another (common random numbers: fair A/B comparisons). | `src/simulation/rng.js` |
| **Supplier outage in the engine** | `config.source.outage = { startTick, endTick }`: the source is skipped for `startTick < tick <= endTick` (counter frozen). Equal to the helper's `outage` option for the same seed. | `engine.js` |
| **Orders and service level in the engine** | `config.demand` (orders per shift), `config.initialFinishedGoods`. Due at the end of the shift, oldest first, backlog, lost sales once. | `src/simulation/orders.js` |
| **Costs** | `computeEconomics(result, config, baselineConfig, rateCard)`: machine hours, material at the lot price, WIP and finished-goods holding, lost sales, revenue, one-time costs amortised over 1,920 shifts (derived from the difference to the default config), finished goods valued at EUR 103. Default line, 20 shifts: about EUR 102.8 per good unit. | `src/economics/costs.js`, `src/data/loaders.js` |
| **Breakdowns** | `config.failures = { enabled: true }`. Modes from `failure_rates.csv` (TWF/HDF at M1, PWF/OSF at M3, RNF everywhere), drawn once per completed part. New machine state `DOWN`: the machine holds its part for the repair time (fixed, optionally `repairDistribution: 'exponential'`). About 6.5% less output at M3 (about 34.5 good parts per shift). | `src/simulation/failures.js` |
| **Raw-material supply** | `config.supply`: `mode: 'jit'` (default, the source halts in the outage) or `'inventory'`: raw stock with an (s,Q) policy, lead time, starting safety stock, a second supplier (+8%, EUR 2,000 qualification) and expediting (+40%). In inventory mode the outage hits the supplier: no primary delivery in the window, late ones arrive after it. | `src/simulation/supply.js` |
| **Analysis (for the later advisor)** | `summariseEvents` (event log per machine and shift), `bottleneckLoss` (where the bottleneck's minutes went: down / starved by the outage / starved by upstream / blocked). No LLM. | `src/analysis/analysis.js` |
| **Scenarios** | The 4 references plus extras (breakdowns, breakdowns + outage, outage with raw stock / safety stock / second supplier / expediting); a slot for "with countermeasure". | `src/scenarios/scenarios.js` |

`runHeadless({ ..., native: true })` uses the engine's own outage and order book instead of the helper's rules and returns the same shape. The default path is still the reference.

### What is deliberately not modelled

- **Product variants and changeovers**: the data says one product.
- **Overtime**: there is no rate for it.
- **Cycle-time variability**: there is no data for it.

Adding realism without data would make the model *less* reliable: every extra random process needs a number that someone has to invent. Where a number is an assumption it is marked as one:
the repair times (organisers), the lead times of the second supplier (240 ticks) and of expediting (60 ticks), the raw-stock holding rate (no rate-card row: defaults to the WIP rate, 0.3 EUR/unit/h) and the (s,Q) defaults.

### API additions

`POST /api/control` also accepts `seed`, `outage`, `failures`, `supply`, `demand` (`'profile'`, `'flat'`, a number or an array), `initialFinishedGoods` (applying them restarts the run at tick 0, paused), and the actions `configureScenario` and `loadPlantDefault`. `GET /api/kpis` returns orders, service level and the economics of the shifts closed so far. The export has new columns (`<id>_ticksDown`, `rawMaterialStock`, `finishedGoodsStock`, `orderBacklog`).

The UI has a "Plant default" row (kept apart from the teaching scenarios), a "Realism" row for these options, a purple DOWN state, and an "Orders & economics" panel.

### How to run the supplier outage in the UI

1. Click **Load plant default** (unlimited material, the demand profile, seed 1).
2. In the **Realism** row, tick **Supplier outage** (ticks 4800–5760 = shifts 11 and 12). Optionally tick **Breakdowns** or pick a **Supply** mode.
3. Click **Apply & reset**, then **Play** and choose **10×**.
4. Watch the header: it shows the current **Shift** and minute, an orange **OUTAGE** badge during the outage and a purple **DOWN: M3** badge while a machine is broken. The **Per-shift results** table under "Orders & economics" gets one row per closed shift.

## The simulation log (export)

```
GET /api/export?format=csv      # or format=json
```

One row per tick since the last reset (the buffer keeps the last 100,000 ticks). Columns include `tick`, `sourceTotalGenerated`, `sourceMaterialStock`, for every machine `<id>_state` (IDLE, PROCESSING, BLOCKED, STARVED), `<id>_partsProcessed`, `<id>_ticksProcessing`, `<id>_ticksBlocked`, `<id>_ticksStarved`, for every buffer `<id>_load` and `<id>_capacity`, and `sinkPartsReceived` (good parts) and `scrapPartsReceived`. Other endpoints: `GET /api/state` (current state), `GET /api/metrics` (utilisation, throughput, lead time, bottleneck), `GET /api/presets`, `POST /api/control`.

## Running without the UI: `runHeadless`

`src/headless/run.js` runs the engine tick by tick without timers, applies the order rules of the data package README (due at the end of the shift, oldest first, backlog, finished-goods stock) and returns per-shift rows, KPIs and an event log. Usage:

```js
import { runHeadless, readDemand } from './src/headless/run.js';
import { DEFAULT_CONFIG } from './src/simulation/config.js';

const demand = readDemand('demand_profile.csv');        // orders per shift, from the data package
const result = await runHeadless({
  config: DEFAULT_CONFIG,      // simulation config, default: DEFAULT_CONFIG (material is always infinite)
  seed: 1,                     // stored as config.seed; has an effect once you implement seeding
  shifts: 20,
  demand,                      // at least `shifts` entries
  outage: { startTick: 4800, endTick: 5760 },   // optional: the helper's own source halt
  initialFinishedGoods: 0,
});
// result = { perShift: [...], kpis: {...}, events: [...] }
```

Test it: run `node src/headless/run.check.mjs` from the repository root. It reads `demand_profile.csv` in the repository root (shipped with the repository); a path argument is optional. It must print `ALL PASSED`.

The event log uses the helper's 0-based tick numbering for the outage events (`startTick` inclusive, `endTick` exclusive) and the engine's 1-based ticks for the machine episodes.

The outage setting for your own engine implementation means: on the engine ticks `startTick < n <= endTick` (n = `engine.tick` after it is incremented, the first tick is 1) the source is skipped: its counter does not advance and no part is released.

## Good to know

- The reject gate of M2 is seeded (`config.seed`, default 1): the same seed gives the same run. `runHeadless` passes `seed` through; pass different seeds for averages.
- Material stock: `materialStock: -1` is infinite, `0` is depleted. The default configuration has 200, so the line stops after about 5 shifts: use `-1` for longer runs. Switching on any realism option (demand, outage, breakdowns, raw-stock supply) sets it to `-1` automatically, and in raw-stock mode the supply model replaces this limit.
- The history buffer keeps at most 100,000 ticks (about 208 shifts).
- Each browser session (cookie `sid`) has its own engine.
- `POST /api/control` ignores unknown actions and parameters but still answers `ok`.
- `npm audit` reports advisories in fastify 4 and @fastify/static 7. The simulation runs only locally; upgrading is optional.

## Source files

| File | Role |
|---|---|
| `src/server.js` | HTTP server, SSE stream, routes, one engine per browser session |
| `src/simulation/engine.js` | Tick loop, machine states, blocking and starvation, history |
| `src/simulation/entities.js` | Part, Machine, Buffer, Source, Sink |
| `src/simulation/config.js` | Default parameters (cycle times, capacities, reject rate, source interval) |
| `src/simulation/presets.js` | Scenario presets for the UI |
| `src/metrics/collector.js` | Pure function: state snapshot → metrics |
| `src/controls.js` | Play, pause, reset, speed (validated) |
| `src/public/` | The browser UI (plain HTML, CSS and JavaScript, no build step) |
| `src/headless/` | `runHeadless` and its test |
| `src/simulation/{rng,orders,failures,supply,summary}.js` | Seeded streams, order book, breakdowns, raw-material supply, KPI helpers |
| `src/economics/costs.js`, `src/data/loaders.js` | Cost model and CSV readers |
| `src/analysis/analysis.js` | Event summaries and bottleneck loss (facts for the later advisor) |
| `src/scenarios/scenarios.js` | Scenario definitions and the multi-seed runner (`npm run scenarios`) |
| `test/`, `src/__tests__/` | Unit tests (`npm test`) |

Machines advance from the end of the line backwards in each tick, so a part never passes several stations in one tick.
