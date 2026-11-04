# Simulation changes: what we added, why, and how we checked it

This is a living document that tracks every change to the `machine_sim` starter. It compares each change with the folder as we received it,
explains why the change makes the simulation closer to the Smart Tech Components plant, and records how we validated it and
how to run it. The plant data is in [DATA_README.md](DATA_README.md); the implementation plan is in [PLAN.md](PLAN.md).

_Last updated: 2026-11-04_

---

## 1. Starting point (the folder as received)

| Area | What the starter had | What was missing |
|---|---|---|
| Engine | Tick loop (1 tick = 1 min, 480 ticks/shift), Source → M1 → M2 → M3 → M4 → Sink, buffers, blocking/starving, parallel machines | — |
| Randomness | M2 reject gate with `Math.random()` | Runs could not be repeated, so two configurations could not be compared fairly |
| Supplier outage | Only inside the helper `runHeadless` (a hack on the source interval) | Not in the engine, not in the UI |
| Orders / service level | Only inside the helper | The engine and the UI knew nothing about demand |
| Costs | None | No machine, material, holding or lost-sales cost; no profit |
| Breakdowns | None (OEE availability always 1) | `failure_rates.csv` was unused |
| Supply side | A fixed `materialStock` counter (200 parts) | No reorder point, lead time, safety stock, second supplier or expediting |
| Scenarios | 3 UI teaching presets (not the plant's line) | No runner for the 4 reference scenarios |
| Data | `demand_profile.csv` (plus an identical copy) | `rate_card.csv` and `failure_rates.csv` were added later by the organisers |
| Tests | Unit tests for engine, collector, UI helpers + `run.check.mjs` (ALL PASSED) | No tests for seeding, orders, costs, breakdowns or supply |

---

## 2. What we added and why it is more realistic

**Ground rule:** every new feature is **off by default**, so the four reference scenarios of the data package give the same
results as before and stay comparable with other teams. New behaviour appears only in extra scenarios.

### 2.1 Reproducible, seeded randomness: `src/simulation/rng.js`
- **What:** each random process draws from its own seeded stream (`reject:M2`, `fail:M3:PWF`, …). `config.seed` sets the run, and seed 0 is valid.
- **Why it matters:** a real plant comparison asks "same week, different decision". With one stream per process, switching breakdowns on does not change which parts M2 rejects (*common random numbers*). A difference between two scenarios therefore comes from the decision, not from luck.

### 2.2 Supplier outage inside the engine: `engine.js`
- **What:** `config.source.outage = { startTick, endTick }`. The source releases nothing for `startTick < tick ≤ endTick`, using the interface the data package prescribes.
- **Why:** the outage is now part of the line itself, so it shows in the UI, the export and every scenario, not only in a side script.

### 2.3 Orders, backlog and service level inside the engine: `src/simulation/orders.js`
- **What:** an order book that follows the data package rules:
  - orders are due at the end of their shift;
  - they are served from finished-goods stock, oldest first;
  - unshipped units stay in the backlog;
  - each late unit counts as a lost sale once.
- **Why:** the plant is judged on delivering to its customers, not only on output. The line now knows its demand, so service level and backlog are visible live.

### 2.4 Costs and profit: `src/economics/costs.js`, `src/data/loaders.js`
- **What:** the full rate card:
  - machine hours (charged for every scheduled hour, even when the machine waits);
  - material at release;
  - WIP and finished-goods holding;
  - lost-sales penalty and revenue;
  - one-time investments amortised over 1,920 shifts (extra machine, buffer slots, cycle-time and reject-rate improvements, second-supplier qualification);
  - finished goods valued at EUR 103.
- **Why:** a plant decision is a money decision. Without costs, "add a machine" always looks good.

### 2.5 Machine breakdowns: `src/simulation/failures.js` (off by default)
- **What:** the failure modes from `failure_rates.csv`:
  - tool wear and heat dissipation at M1;
  - power and overstrain at M3;
  - random failures at every station.

  Failures are drawn per completed part. A broken machine goes to the new state **DOWN** and keeps its part for the repair time. OEE availability is now real (below 1).
- **Why:** real lines lose capacity to breakdowns. When the bottleneck M3 breaks, the whole line loses output, which a model without breakdowns can't show. Measured effect: from 36.8 to **34.6 good parts per shift**.

### 2.6 Raw-material supply model: `src/simulation/supply.js` (off by default)
- **What:** mode `jit` (default) behaves exactly like the starter. Mode `inventory` adds:
  - raw stock in front of the source;
  - a reorder point and order quantity, with a supplier lead time;
  - an optional starting safety stock;
  - a **second supplier** (+8% price, EUR 2,000 qualification);
  - **expediting** (+40% price).

  In this mode the outage stops the supplier's deliveries, not the line, so the line keeps running on its raw stock. Material is costed at the price of the batch actually used, oldest first.
- **Why:** this is how a real plant protects itself against a supplier outage. The data package names these countermeasures but the starter could not test them; now it can.

### 2.7 Analysis layer, the factual basis for the later AI advisor: `src/analysis/analysis.js`
- **What:**
  - `summariseEvents` condenses the noisy event log per machine and shift, as the data package asks.
  - `bottleneckLoss` splits the minutes lost at M3 into causes: down, starved by the outage, starved by upstream, blocked.
- **Why:** a shift supervisor needs "why did we miss the orders", not 1,000 log lines. These are computed facts, so a later AI advisor can quote them without inventing numbers.

### 2.8 Scenario runner: `src/scenarios/scenarios.js`, `npm run scenarios`
- **What:** the 4 reference scenarios plus 6 extras, each run with 30 seeds (the same seeds for every scenario), reported as mean ± standard deviation. It has a slot for "with countermeasure", reserved for step 2 (the advisor).

### 2.9 UI additions: `src/public/`
- **Plant default** button: the plant's line with unlimited material, the demand profile and seed 1. It is kept apart from the teaching presets.
- **Realism** row: seed, demand, starting finished-goods stock, supplier outage, breakdowns, supply mode.
- **Header:** current **shift and minute**, an orange **OUTAGE** badge, and a purple **DOWN: M3** badge.
- **Orders & economics** panel (service level, backlog, finished goods, cost per unit, profit, breakdowns, raw stock) and a **Per-shift results** table.
- The **banner** now says when material has run out or the outage is active, instead of wrongly advising "increase the material feed".
- New export columns: `<machine>_ticksDown`, `rawMaterialStock`, `finishedGoodsStock`, `orderBacklog`.

### 2.10 Fixes after review (2026-11-04)
- **Run stopped before the outage.** The starter's 200-part material limit stayed on when only the outage or breakdowns were switched on, so the line ran dry at about tick 2,400. Now any realism option sets material to unlimited, and in raw-stock mode the supply model replaces the 200-part limit.
- **Shift not visible.** We added the shift clock, the status badges and the per-shift table.
- **Misleading banner** when material ran out or during the outage: fixed.

### 2.11 Deliberately not modelled
- **Product variants and changeovers:** the plant makes one product.
- **Overtime:** there's no rate for it in the rate card.
- **Cycle-time variability:** there's no data for it.

Every extra random process needs a number, so adding these without data would make the model *less* trustworthy.

**Assumptions we made, all marked in the code:**
- repair times (given by the organisers);
- second-supplier lead time: 240 min;
- expediting lead time: 60 min;
- raw-stock holding cost: 0.3 EUR/unit/h, the same as the WIP holding cost, since the rate card has no row for it;
- the default reorder point and order quantity.

### 2.12 Housekeeping
- Removed the duplicate `demand_profile (2).csv`.
- Renamed `README(4).md` to `DATA_README.md`.
- Removed the client ID from a comment in `api.py`.

---

## 3. How we validated it

| Check | What it proves | Result |
|---|---|---|
| `node src/headless/run.check.mjs` | The organisers' acceptance test with reference service levels and output | **ALL PASSED**: SL 56.9% / 48.6% / 100% / 77.3%, 36.8 good parts/shift |
| `npm test` | 109 unit tests, including the seven new test files (`determinism-orders`, `economics-failures`, `supply`, `analysis`, `material-limit`, `sweep`, `countermeasures`) | **109 / 109 pass** |
| Determinism tests | Same seed gives an identical run; different seeds differ; seed 0 works | pass |
| Outage equivalence | The engine's outage gives the same per-shift rows as the helper's reference outage | pass |
| Order book | FIFO, backlog served first, lost sales counted once | pass |
| Cost calibration | Default line, 20 shifts: **EUR 102.6 per good unit** (data package: 102.8) | pass |
| Breakdown checks | Breakdowns off gives an identical history; they don't change reject draws; M3 availability matches the value calculated from the failure data | pass |
| Supply checks | `jit` equals the reference; material balance (delivered = released + stock change); no supplier deliveries during the outage | pass |
| Material-limit regression | Outage-only run gets past tick 5,760; raw-stock mode isn't capped at 200 | pass |
| Server smoke test | The page has the shift clock, badges and table; `/api/kpis` returns per-shift rows | pass |

**Scenario table** (`npm run scenarios`, 20 shifts, 30 seeds, mean ± sd, no countermeasure yet):

| Scenario | Service level | Good / shift | EUR / good unit | Profit EUR |
|---|---|---|---|---|
| Baseline (flat 34) | 100.0% | 36.8 | 102.6 | 49,139 |
| Supplier outage | 77.2 ± 2.3% | 33.7 | 107.9 | 32,776 |
| Demand swing | 56.8 ± 0.5% | 36.8 | 102.6 | 20,432 |
| Both | 48.5 ± 1.4% | 33.7 | 107.9 | 14,148 |
| Breakdowns (extra) | 95.5 ± 7.6% | 34.6 | 106.5 | 45,291 |
| Breakdowns + outage (extra) | 50.5 ± 4.5% | 31.7 | 112.1 | 11,352 |
| Outage, raw stock default (extra) | 99.9% | 35.4 | 104.8 | 45,272 |
| Outage + safety stock (extra) | 100.0% | 36.8 | 102.6 | 40,762 |
| Outage + second supplier (extra) | 100.0% | 36.8 | 103.3 | 44,351 |
| Outage + expediting (extra) | 100.0% | 36.8 | 106.3 | 42,065 |

Reference values from the data package: about 100 / 76 / 57 / 48%. All four match.

**Caveats:**
- In the "raw stock default" extra scenario the assumed starting raw stock (160 units) already covers most of the 2-shift outage. Its result depends on that assumption.
- Breakdowns make the service level much more variable (± 7.6 points). One bad breakdown at M3 is enough to miss orders.

---

## 4. How to run it

**Requirements:** Node.js 20 or newer, or Docker.

```bash
npm install
npm start                          # UI at http://localhost:3000
npm test                           # 109 unit tests
npm run countermeasures -- demand-swing   # the 3 demand-swing countermeasures, 30 runs each (about 2 min)
node src/headless/run.check.mjs    # organisers' acceptance test → ALL PASSED
npm run scenarios                  # scenario table (takes a few minutes)
```

With Docker: `docker compose up --build`. **Rebuild after every code change**, because the image copies the code when it is built.
If the UI looks old after an update, restart the server and press **Ctrl+F5** in the browser.

**Supplier outage in the UI:**
1. Click **Load plant default**.
2. In the **Realism** row, tick **Supplier outage** (ticks 4,800–5,760 = shifts 11 and 12). Optionally tick **Breakdowns** or choose a **Supply** mode.
3. Click **Apply & reset**, then **Play** and choose **10×**.
4. The header shows the shift and an **OUTAGE** badge during shifts 11–12. The **Per-shift results** table fills in one row per shift. Use **Export CSV** for the full minute-by-minute log.

**From code:** `runHeadless({ config, seed, shifts, demand, outage, initialFinishedGoods, native: true })` in
`src/headless/run.js`. Configuration keys: `seed`, `source.outage`, `failures`, `supply`, `demand`, `initialFinishedGoods` (see README.md).

---

## 5. Phase 2: which countermeasure works (the consulting answer)

**What we did:** for each of the 4 reference scenarios we tested **24 levers** that the rate card prices, plus the best combinations. Each one ran 20 shifts × 30 seeds, using the same seeds as the "without" run.
- **Code:** `src/scenarios/sweep.js`. Run it with `npm run sweep` (about 10 minutes).
- **Full results:** `results/phase2_sweep.txt` (readable) and `results/phase2_sweep.json` (every number).
- **Before/after table:** `results/phase2_results.txt` (`npm run scenarios`).

**How we decide (stated so it can be checked):**
1. **Paired comparison:** each fix is compared with "without" seed by seed. A gain counts only if its 95% confidence interval is above 0.
2. **Conservative profit:** the official rule credits every finished set left at the end at EUR 103. A line that simply makes more than customers order therefore *looks* profitable. Example: a second M3 shows +EUR 21,000 officially in "demand swing", but it does so by building 498 sets nobody ordered. We value that extra unsold stock at EUR 0 and report both numbers.
3. **Pick:** among significant gains, prefer ≥ 95% on-time delivery, then take the highest conservative gain. The rule is unit-tested in `test/sweep.test.js`.

**Results** (20 shifts, mean of 30 runs):

| Scenario | Without | Recommended countermeasure | With | Profit gain (20 shifts) |
|---|---|---|---|---|
| Baseline (flat 34) | 100% on time | Lower M2 reject rate 10% → 5% (optional) | 100% | +EUR 1,100 |
| Supplier outage | 77% | Finished-goods buffer of 30 sets | 100% | +EUR 12,600 |
| Demand swing | 57% | Finished-goods buffer of 50 sets | 99% | +EUR 21,000 |
| Both | 48% | Finished-goods buffer of 50 sets | 99% | +EUR 25,900 |

**What this tells the client:**
1. **The line has enough capacity.** It makes 36.8 sets per shift against an average demand of 31.3. The plant misses orders because of **timing**: it starts the week with an empty warehouse just as large orders arrive (61 and 55 sets in the first two shifts), and because the oldest orders are served first, one bad day delays the following days.
2. **A finished-goods buffer of 40–50 sets is the cheapest fix for every disruption.** It costs only holding cost (0.5 EUR per set per hour) and covers demand peaks *and* the 2-shift supplier outage.
3. **Buying capacity is a bad deal.** A second M3 or a faster M3 raises output, but the extra sets aren't ordered. On the conservative measure, the second M3 loses EUR 5,000–55,000 per 20 shifts.
4. **Supplier-side options** (second supplier, expediting, raw safety stock) fully fix the outage alone (100%), but they cost more than the finished-goods buffer. Against the demand swing they don't help (57%).

**Honest limits: out-of-sample check.** The recommendation was chosen on demand shifts 1–20, and we retested it on the unused shifts 21–40 and 41–60. In those weeks the plant already delivers 99–100% without the buffer, because those weeks don't start with a peak. The buffer then costs about **EUR 3,000–4,000 per 20 shifts** of holding cost for at most +1.3 points. So the buffer works like **insurance**: about EUR 3,500 per 20-shift period, which protects about EUR 21,000–26,000 when a peak or an outage hits an empty warehouse. Whether it pays off depends on how often such weeks happen; that's a decision for the client, and the advisor will put it to them.

---

## 6. Demand swing: the three countermeasures the AI advisor can propose

We started the advisor work with one disruption, the **demand swing**, and three countermeasures chosen with the client. Each one adds **assembly capacity**, which is what limits the line during order peaks. Raw-material stock and extra suppliers were considered and rejected: during a demand swing the line never runs out of material, so they can't help (Phase 2 confirmed this).

**What we built:**

| Piece | File | Role |
|---|---|---|
| Overtime in the engine | `src/simulation/engine.js` (`config.overtime`) | New realism feature, off by default (see below) |
| Overtime cost | `src/economics/costs.js` | EUR 405 per overtime hour (assumption, see below) |
| Countermeasure catalogue | `src/countermeasures/catalog.js` | The only menu the AI may choose from: ids, bounded parameters, prices |
| Evaluator (the "check") | `src/countermeasures/evaluate.js` | Simulates a countermeasure against the disruption (30 runs, same seeds) and returns a plain verdict |
| Tests | `test/countermeasures.test.js` | 6 tests (overtime behaviour, plant clock, cost, guardrails, verdicts) |

**Overtime, the new engine feature.** When a shift ends with orders that the warehouse can't cover, the whole line keeps working until the orders are covered, up to a maximum (default 120 min). Two design points:
- The plant clock **stands still** during overtime, so due times and the supplier-outage window stay where they are. The engine counts the worked minutes separately.
- The **whole line** runs overtime, not only M3: M3's input buffer holds only 6 parts, so M3 alone would run dry after about 80 minutes.

*Why it is realistic:* plants answer order peaks with flexible extra hours, not only with investment. *Assumption:* the rate card has no overtime price, so we use the hour rates of all four machines (EUR 270/h) + 50% overtime premium = **EUR 405 per hour**. It can be changed with `config.overtime.ratePerHour`.

**Guardrails for the AI:** `resolveCountermeasure()` rejects any unknown id, any countermeasure that isn't offered for the chosen disruption, any parameter outside its range or step, and any unknown parameter. The AI can't invent options.

**Results** (`npm run countermeasures -- demand-swing`, 20 shifts × 30 runs, saved to `results/demand-swing_countermeasures.txt` / `.json`). Without any countermeasure: **56.8%** of orders on time, profit EUR 20,432.

| Countermeasure (default setting) | On time | Profit change, conservative [95% CI] | Official rule | Verdict |
|---|---|---|---|---|
| **Overtime on busy shifts** (max 120 min) | **87.8%** | **+EUR 9,134** [+9,101, +9,166] | +EUR 13,930 | ✅ Effective |
| **Faster M3** (13 → 11 min) | 82.0% | +EUR 3,209 [+3,158, +3,259] | +EUR 17,100 | ✅ Effective (smaller gain) |
| **Second M3** (release every 8 min) | 96.8% | **−EUR 18,878** [−19,147, −18,609] | +EUR 16,478 | ❌ Improves delivery, but costs more than it earns |

**Reading:**
- **Overtime is the best of the three.** It's paid only when a peak actually happens: about 10 hours over 20 shifts, all in the first five shifts.
- **The faster M3** helps less. It raises output every shift, peaks or not, so it builds 135 sets nobody ordered.
- **The second M3** delivers best, but it builds 343 unsold sets and costs EUR 95,000. Under the official profit rule it *looks* good (+EUR 16,478) only because that unsold stock is counted at EUR 103 each.

For comparison, the Phase 2 winner, a finished-goods buffer of 50 sets, reaches 99% and +EUR 21,000. It isn't in this menu because the client chose these three for the demo.

---

## 7. Next step: the AI shift advisor (not started)

Agreed product (2026-11-04):
- **User:** the CEO / C-level manager, who wants to understand how to face a disruption.
- **AI shift advisor:** the LLM, called through `api.py`.

**Flow:**
1. The CEO picks a disruption (outage, demand peak, breakdowns, or a combination).
2. The simulation runs and shows the impact in plain terms.
3. Optionally, the AI advisor explains the result and proposes a countermeasure from the catalogue tested in section 5.
4. The proposal is **automatically simulated** and shown before/after with a verdict.

**Rules:**
- The AI never produces numbers; all numbers come from the simulation.
- The AI may only pick countermeasures from the priced catalogue.
- Nothing is "recommended" until the simulation confirms it.

---

## 8. CEO interface and AI shift advisor

**What was built (2026-11-04).** The page now follows the CEO flow of section 7: pick a scenario, **Simulate**, read **Results**, **Explain me these results**, **How to improve the results?**. The animated line (`#pipeline-svg`) is unchanged apart from its colours. The old controls and metrics are hidden with a `legacy-hidden` class, not deleted, because `app.js` still references them.

| Piece | File | Role |
|---|---|---|
| Light theme | `src/public/style.css`, colour maps in `src/public/app.js` | Light palette; machine boxes tinted by state |
| Scenario bar, Results tiles, Advisor panel | `src/public/index.html`, `app.js` | Scenario select + Simulate, 7 tiles, two advisor buttons |
| UI scenarios | `src/ui/scenarios.js` | The 4 reference-style scenarios, 20 shifts, seed 1, no starting stock |
| Auto-stop | `src/simulation/engine.js` (`config.runShifts`) | Pauses after N closed shifts and emits `run-complete`; off unless set |
| Run summary | `src/ui/run-summary.js` | Plain JSON for the tiles and the LLM (orders, output, money, worst shift, bottleneck, disruption) |
| LLM client | `src/advisor/llm.js` | Server-side call of the hackathon proxy (as `api.py`); reads `CLIENT_ID` / `CLIENT_SECRET` from the environment or `.env`; 30 s timeout; errors never contain the secret |
| Advisor | `src/advisor/advisor.js` | `explain` words the facts; `improve` asks for one catalogue pick (id + parameters), validates it with `resolveCountermeasure` (one retry), then has `evaluateCountermeasure` simulate it (10 runs) |
| Server | `src/server.js` | Action `runScenario`, `GET /api/results`, `POST /api/advisor/explain`, `POST /api/advisor/improve` |
| Tests | `test/ui-scenarios.test.js`, `run-summary.test.js`, `advisor.test.js` | 15 new tests; the LLM and the evaluator are mocked, no test uses the network |

**Why.** The audience is a CEO, not an engineer. The LLM is kept to wording: it never produces a number, and it can only choose from the priced catalogue. A proposal is called "works" only after the simulation has run it.

**Rules kept.** Simulation behaviour is unchanged (`runShifts` is off by default; the four reference scenarios give the same numbers). The secret stays on the server: it is not sent to the browser, put in a response or logged.

**Known limits.**
- Only Demand Swing has countermeasures. For the other scenarios, "How to improve" answers without calling the LLM.
- The tiles show one run (seed 1); the simulation check shows the average of 10 runs, so the numbers differ slightly (the UI says so).
- The check takes roughly 10–20 s and runs on the server's single thread, so the page's animation of other sessions can stutter meanwhile.

**How to run it.** `npm install`, create `.env` with `CLIENT_ID` and `CLIENT_SECRET`, `npm run dev`, open http://localhost:3000. With Docker: `docker compose up --build` (the compose file passes `.env` to the container).

---

## Change log

| Date | Change |
|---|---|
| 2026-11-04 | Realism layer implemented (sections 2.1–2.9, 2.12) |
| 2026-11-04 | Review fixes: material limit, shift clock and badges, per-shift table, banner notes, regression tests (section 2.10) |
| 2026-11-04 | Phase 2: countermeasure sweep, conservative profit, out-of-sample check, recommendations attached to the reference scenarios (section 5) |
| 2026-11-04 | Demand swing countermeasures for the AI advisor: overtime engine feature + cost, catalogue with guardrails, evaluator with verdicts (section 6). Tests: 109 / 109 pass; reference check ALL PASSED |
| 2026-11-04 | CEO interface and AI shift advisor: light theme, scenario bar, Results tiles, explain / improve endpoints, engine `runShifts` auto-stop (section 8). Tests: 124 / 124 pass; reference check ALL PASSED |
