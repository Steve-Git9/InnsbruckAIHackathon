# Simulation changes: what we added, why, and how we checked it

This is a living document that tracks every change to the `machine_sim` starter. It compares each change with the folder as we received it,
explains why the change makes the simulation closer to the Smart Tech Components plant, and records how we validated it and
how to run it. The plant data is in [DATA_README.md](DATA_README.md).

_Last updated: 2026-11-05_

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
- **Cycle-time variability:** there's no data for it.
- **Shift calendars, breaks and night shifts:** shifts run back to back as 480-minute blocks, as in the starter.

(Overtime was later added as an engine feature with a stated price assumption, see section 6.)

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
npm test                           # 201 unit tests
node src/headless/run.check.mjs    # organisers' acceptance test → ALL PASSED
npm run scenarios                  # scenario table (takes a few minutes)
npm run sweep                      # Phase 2: all levers on the 4 reference scenarios (about 10 min)
npm run countermeasures                   # the 6 countermeasures in all 4 scenarios, 30 runs each (results/<scenario>_countermeasures.*)
npm run countermeasures -- demand-swing   # one scenario only
```

**AI features:** the "Explain" and "Ask the Intelligent Shift Advisor" buttons need a `.env` file in the root folder with `CLIENT_ID` and `CLIENT_SECRET` (the hackathon LLM proxy, see `api.py`). Everything else works without it.

**CEO interface (sections 8–13):**
1. Choose a scenario and a number of shifts, then click **Simulate** (animated) or **Instant Simulation**.
2. Read the **Results** tiles.
3. Click **Explain me these results**.
4. Click **How to improve the results?**. The 6 countermeasure cards (Operational / Strategic) fill in with their simulated values. Either tick up to 3 and click **Test my selection**, or click **Ask the Intelligent Shift Advisor**.
5. Read the **Cost of the improvement** panel, then click **Compare side by side**.

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

> **Superseded for the catalogue by section 13** (one pool of 6 countermeasures in all 4 scenarios; overtime is no longer a countermeasure). Kept for history: the overtime engine feature, its cost assumption and its tests are still in the code.

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

## 7. AI shift advisor: agreed product design (built in section 8)

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
| Tests | `test/ui-scenarios.test.js`, `run-summary.test.js`, `advisor.test.js` | 16 new tests; the LLM and the evaluator are mocked, no test uses the network |

**Why.** The audience is a CEO, not an engineer. The LLM is kept to wording: it never produces a number, and it can only choose from the priced catalogue. A proposal is called "works" only after the simulation has run it.

**Rules kept.** Simulation behaviour is unchanged (`runShifts` is off by default; the four reference scenarios give the same numbers). The secret stays on the server: it is not sent to the browser, put in a response or logged.

**Known limits.**
- Only Demand Swing has countermeasures. For the other scenarios, "How to improve" answers without calling the LLM. *(Lifted in section 13: all 4 scenarios.)*
- The tiles show one run (seed 1); the simulation check shows the average of 10 runs, so the numbers differ slightly (the UI says so).
- The check takes roughly 10–20 s and runs on the server's single thread, so the page's animation of other sessions can stutter meanwhile.

**Speed and Instant Simulation (added afterwards).** Next to **Simulate**, a speed selector (×1, ×2, ×10) sets how fast the animation runs. **Instant Simulation** runs all 20 shifts at once on the server (about 0.4 s) without the animation, so the CEO goes straight to the Results.

**Review (2026-11-04):**
- `npm test`: **125 / 125** pass, and `run.check.mjs` prints **ALL PASSED**, so the simulation is unchanged.
- The LLM is called only from the server (`src/advisor/llm.js`), and the secret is not in any response or error.
- The proxy accepts only "user" and "assistant" messages, so the system prompt is folded into the first user message (`foldSystem`).
- AI proposals are validated against the catalogue, with one retry, before the simulation checks them.
- Outside Demand Swing, "How to improve" answers without calling the LLM (changed in section 13).

**How to run it.** `npm install`, create `.env` with `CLIENT_ID` and `CLIENT_SECRET`, `npm run dev`, open http://localhost:3000. With Docker: `docker compose up --build` (the compose file passes `.env` to the container).

---

## 9. CEO questionnaire and side-by-side comparison

**What was built (2026-11-04).** "How to improve the results?" no longer goes straight to the LLM. For Demand Swing it opens a short questionnaire; the answers narrow the catalogue in code, the LLM picks from what is left, the simulation checks the pick (10 runs), and a **Compare side by side** button shows two animated lines running at the same time.

| Piece | File | Role |
|---|---|---|
| Questionnaire | `src/public/index.html`, `app.js` | 5 questions (goal, investment, overtime, kind of fix, free text up to 500 characters); **Find my countermeasure**, **Give me the best**, **Change my answers** |
| Hard limits | `src/advisor/constraints.js` | `validateAnswers`, `applyConstraints`, `checkProposal`. Investment comes from `rate_card.csv` (faster M3: 30,000 per minute; second M3: 95,000). Budget and overtime answers remove options or lower the overtime maximum; goal, fix type and the free text only go to the prompt |
| Advisor | `src/advisor/advisor.js` | `improve(summary, scenario, answers)`: sends the narrowed catalogue plus `CEO_ANSWERS` / `CEO_NOTES`, validates the pick against the narrowed catalogue (one retry), returns `constraintsApplied` and `answers`. If nothing is allowed it answers "no options" without calling the LLM |
| Comparison runner | `src/ui/compare-runner.js` | Two engines, same seed 1: A = as is, B = with the countermeasure. One driver loop advances them by the plant clock, so A waits (shift closed) while B works overtime and both end at plant tick 9,600 |
| Server | `src/server.js` | `POST /api/advisor/improve` takes `{ answers }` (400 if invalid); `POST /api/compare/start`, `/speed`, `/stop`; `GET /api/compare/results`; a `compare` field in the SSE stream |
| Reusable diagram | `src/public/pipeline-view.js` | `PipelineView` class: the line drawing with id prefixes and per-instance state. The main diagram in `app.js` is unchanged; `PipelineView` should replace it later |
| Tests | `test/constraints.test.js`, `compare-runner.test.js`, `advisor.test.js` | 24 new tests; no test uses the network |

**Why.** The CEO has real limits (money, overtime) that a prompt can only ask the model to respect. Enforcing them in code means the model can never propose what the CEO ruled out. Two lines running side by side let the CEO see the effect instead of reading a number.

**How it was validated.** 149 / 149 tests pass; `run.check.mjs` prints ALL PASSED. The runner tests check that engine A equals a solo run of the same scenario and that engine B equals `runHeadless` with the same countermeasure config. A live test with the LLM confirmed that "no investment + up to 1 h overtime" yields an overtime maximum of 60 minutes, and "no investment + no overtime" returns "no options" without an LLM call.

**Known limits.**
- Only Demand Swing has questions and countermeasures *(lifted in section 13)*.
- The comparison shows one run each (seed 1). The check above it averages 10 runs, so the numbers differ slightly (the UI says so).
- The 10-run check blocks the server for 10–20 s. The advisor buttons are disabled while a comparison runs.
- Instant mode runs the comparison to the end without animation.

**How to use it.** Run Demand Swing, click **How to improve the results?**, answer the questions (or **Give me the best**), then **Compare side by side** and **Run comparison** (speed ×1, ×2, ×10) or **Instant**. Below 1,100 px of window width the two diagrams stack.

---

## 10. Full interface, manual selection, Current Situation, shift limit

**What was built (2026-11-05).** Five changes on top of sections 8 and 9.

1. **Full interface back, with collapse toggles.** The old controls and metrics are visible again as **Advanced controls** and **Advanced metrics** (collapsed by default). Every section has a header row with a chevron button (`aria-expanded`, `aria-controls`), and so does every sub-block: Simulation Control, Scenarios, Plant default, Realism, Speed, Source, Machine cycle times and Buffer capacities in the controls; summary cards, Orders & economics, Throughput and the machines table in the metrics. One helper, `makeCollapsible`, does all of it; the state is kept in `localStorage` (`ui.collapsed.<id>`, every access in `try/catch`). The advanced controls share the engine with the CEO run, so an action that resets or reconfigures it (`src/ui/session-rules.js`) makes the server forget the run, and the Results show "The run was changed with the advanced controls – click Simulate to start a new run." `play`, `pause` and speed keep the run.
2. **Manual selection of countermeasures.** For Demand Swing, **How to improve the results?** shows one card per countermeasure (select box, description, cost note, parameter select built from the catalogue bounds). Any combination of 1–3 can be tested with **Test my selection**. **Ask the Intelligent Shift Advisor** opens the questionnaire and LLM flow from section 9, unchanged. Both paths end in the same proposal card, titled "Your selection" or "The advisor's choice", followed by **Compare side by side**.
3. **Comparison table** of the countermeasures: rows built from the catalogue, every value "—" at this stage (a placeholder). It is filled from the simulated card values in section 13.
4. **Current Situation bar** (finished-goods stock, raw-material stock, last maintenance with an "all machines" list), from the demo file `src/data/current_situation.json` through `GET /api/current-situation`. It is labelled as demo data and is **not read by the simulation**.
5. **Shift limit** (1–60, default 20) next to Simulate and Instant Simulation. It drives the run, the Results, the 10-run check and the comparison.

| Piece | File |
|---|---|
| Combination of countermeasures | `src/countermeasures/catalog.js` (`resolveSelection`) |
| Check of a selection | `src/countermeasures/evaluate.js` (`evaluateSelection`; `evaluateCountermeasure` is a wrapper) |
| Advice in the session | `session.advice = { scenarioId, selection, label, source: 'manual' \| 'advisor', shifts }` |
| Comparison with a selection and a shift count | `src/ui/compare-runner.js` |
| Shift count in scenarios | `src/ui/scenarios.js` (`buildUiScenario(id, shifts)`, `normaliseShifts`) |
| Endpoints | `GET /api/countermeasures`, `POST /api/countermeasures/test`, `GET /api/current-situation`; `runScenario` takes `shifts` |
| Tests | `test/selection.test.js`, `current-situation.test.js`, extended `compare-runner.test.js` |

**Merge rules for a combination.** Machines are built in the order faster M3, then second M3 (so M3b is a copy of the already faster M3); the release interval is the smallest of the selected items; overtime is added as it is. A one-item selection gives exactly the override the single countermeasure gave before (a test checks this).

**Investment of a faster second machine (`src/economics/costs.js`).** A spawned machine such as M3b is now compared with the baseline machine of its station, so a faster M3b is charged for its cycle-time reduction too ("per tick per machine" in the rate card). Faster M3 (2 min) plus Second M3 costs 2 × 2 × 30,000 + 95,000. Nothing changes for existing runs, where spawned machines have the baseline cycle.

**Why.** The CEO wants to try ideas without waiting for the AI, and to see more than the fixed 20 shifts. The old controls stay available for engineers, but the CEO view stays clean because they are collapsed.

**How it was validated.** 163 / 163 tests pass (14 new) and `run.check.mjs` prints ALL PASSED; the four reference scenarios are unchanged at 20 shifts. The page was also driven in a real headless browser (no JavaScript errors): collapse toggles and their persistence, the Current Situation bar, shift validation and the outage hint, an 8-shift Demand Swing run, the cards, a combined selection (Overtime + Faster M3: 17.4% → 86.7% on time in the check), and the comparison with its before → after tiles.

**Known limits.**
- Reference values of the data package hold only at 20 shifts; with another count the Results say so.
- The shift limit applies to every scenario; the supplier outage sits in shifts 11–12, so the UI hints at least 12 shifts for it.
- The Current Situation values are demo data and are not connected to the simulation.
- The placeholder table has no values yet *(filled in section 13)*.
- The Machines sub-block of the Advanced controls was not created because that block does not exist as a separate row; the per-machine table is under Advanced metrics.

**How to use it.** Choose a scenario and a number of shifts, **Simulate** or **Instant Simulation**, read the Results. For Demand Swing, click **How to improve the results?**, tick one or more countermeasures and **Test my selection** (or **Ask the Intelligent Shift Advisor**), then **Compare side by side**. Open **Advanced controls** or **Advanced metrics** for the engineering view; using an advanced control that changes the engine clears the Results.

---

## 11. Cost of the improvement panel

**What was built (2026-11-05).** After a countermeasure is selected (manually or by the Intelligent Shift Advisor) and checked, the proposal card shows a **Cost of the improvement** panel, and the side-by-side results show the same panel for that single run. It has three layers:

1. **A headline sentence**, written by code: for example "To deliver 194.3 more sets on time over 20 shifts, you pay €8,332 and avoid €17,490 in late-delivery penalties. No upfront investment is needed."
2. **Two tables**, "What you pay" and "What you get", each line with its formula and amount (a total row each: *Total cost of the improvement* and *Net effect on profit*), an investment box when there is an upfront investment, and two indicator chips: **cost per rescued order** against the €90 penalty, and **payback**.
3. **A profit bridge chart** (inline SVG): a waterfall from the "As is" profit to the "With countermeasure" profit, with a dashed final segment for the unsold stock.

| Piece | File |
|---|---|
| Per-run cost lines kept by the evaluator (data only) | `src/scenarios/scenarios.js` (`runVariant`), `src/economics/breakdown.js` (`runRecord`) |
| Pure breakdown function (reusable for a long-term view: it only needs two sets of economics) | `src/economics/breakdown.js` (`costBreakdown`) |
| Formula helper for cycle-time cuts (no total changes) | `src/economics/costs.js` (`cycleReductions`) |
| Evaluator result `costs` | `src/countermeasures/evaluate.js` |
| Proposal card and advisor answer carry `costs` | `src/server.js` (`/api/countermeasures/test`), `src/advisor/advisor.js` |
| One run (side by side): `costs` in `GET /api/compare/results` | `src/server.js`, `src/ui/run-summary.js` (`engineRecord`) |
| Panel and chart | `src/public/app.js` (`renderCostPanel`, `bridgeSvg`), `style.css` |
| Tests | `test/cost-breakdown.test.js` |

**How to read it.** Every amount is the mean over the runs of the paired difference (with − without). *What you pay*: share of the investment (cash ÷ 1,920 shifts × shifts), overtime (hours × €405/h, an assumption: the rate card has no overtime price), machine hours of an extra machine, extra material, storage, starting stock. *What you get*: late-delivery penalties avoided (× €90), revenue from extra deliveries, and the value of finished sets left at the end (× €103). The lines add up exactly: **Σ get − Σ pay = the official profit change**. Because unsold sets are only worth something on paper, the panel also shows the **conservative** result (unsold stock worth 0), which equals the evaluator's `change.profitConservative`. Late orders are still delivered later, so the sale is kept: the gain is the avoided €90 penalty, which is why *revenue from extra deliveries* usually does not appear. **Payback** uses the operating gain per shift before the investment share (conservative) and says "never at these numbers" when that gain is not positive. The tags "assumption" and "organiser assumption (rate card)" mark prices that are not plain rate-card prices.

**How it was validated.** `test/cost-breakdown.test.js` (10 tests, real evaluator with 3 seeds and 20 shifts) checks the identity and the conservative match for overtime, faster M3, second M3 and faster M3 + second M3; the investment cash (0, 60,000, 95,000 and 215,000); the overtime line (hours × 405); the machine-hours line of M3b (90 × 8 × 20); rescued orders and cost per rescued order; payback (none, never, ceil(cash ÷ gain)); the headline; and a single-run breakdown from two engines. 173 / 173 tests pass; `run.check.mjs` prints ALL PASSED; no cost total and no simulation number changed. The panel was also checked in a headless browser (tables, investment box, chips, bridge chart, and the side-by-side version).

**Known limits.**
- Short term only: the chosen number of shifts, 10 runs. The **long-term (one-year) view is planned as the next step**; `costBreakdown` is written so it can be reused for it unchanged.
- The advisor's own wording (`reason`) does not see the panel's numbers: the LLM picks the countermeasure before the check exists, so there is no cost data to give it yet. *(Since section 13 it reads the simulated card values of all 6 countermeasures before picking.)*
- The single run in the side-by-side view is one random draw; the averages in the proposal card are more reliable.
- The placeholder comparison table of the countermeasures is still a placeholder *(filled in section 13)*.

---

## 12. Design decisions, discussions and next steps

Decisions taken with the client during the project that aren't visible in the code alone.

**What the AI shift advisor actually reads.** The LLM never sees the minute-by-minute log (9,600 rows × about 40 columns) or the CSV files. It receives:
- a compact summary computed by code (`src/ui/run-summary.js`): orders, production, money, worst shift, bottleneck, what the disruption did, and one short row per shift;
- the countermeasure catalogue, already filtered by the CEO's budget (section 13: the pool of 6 with the class of each);
- the CEO's answers and notes.

It judges from those facts and from the countermeasures' descriptions. *Updated in section 13:* it now also reads the simulated card values (on time, profit change, investment, cost per good set, verdict) of the 6 countermeasures, which the server computes before the advisor answers. The order stays: **the AI proposes, then the simulation checks** the pick in the normal 10-run check. Sending the full log was rejected: it's costly, and LLMs add up large tables unreliably, while the code already computes those totals exactly.

**JEV (TypeSafe's decision model) was considered and not adopted.** It returns typed choices with probabilities, which would guarantee a valid pick and add a confidence score. But it writes no explanations, so gpt-4o would still be needed. It's an extra paid provider outside the hackathon credits, and it wouldn't make the pick better informed. Our code checks already guarantee valid picks.

**Explainability and finance: options discussed, partly built.**
- **Built:** the cost panel (section 11): what you pay vs what you get, cost per rescued order against the €90 penalty, payback, and the profit bridge.
- **Still open:**
  - a per-shift chart of orders vs production vs backlog (As is vs With countermeasure);
  - "rescued orders" per shift;
  - curves showing results across countermeasure settings;
  - a "why not the others" sentence for each recommendation;
  - an assumptions panel with sliders for the overtime rate, the penalty and the investment prices;
  - an automatic check that every number in the AI's text appears in the facts.

**Next step agreed: the long-term view.** Next to the short-term result (the chosen shifts, 10 runs), a one-year view (240 shifts, about 5 runs). It shows the "insurance" logic: overtime is paid only in busy weeks, a second machine costs every shift. Planned design:
- repeat the real 60-shift demand profile 4 times;
- run in a background worker (Node `worker_threads`) with a progress bar;
- turn off the minute-by-minute history for these runs (the engine would otherwise hit its 100,000-row cap);
- reuse `costBreakdown` unchanged.

**Review of sections 10 and 11 (2026-11-05):** 173 / 173 tests pass and `run.check.mjs` prints ALL PASSED; the four reference scenarios are unchanged.

---

## 13. One pool of 6 countermeasures

The old catalogue (overtime, faster M3, second M3, offered only for the demand swing, section 6) is replaced by **one common pool of 6 countermeasures, offered in all 4 scenarios** (Standard, Demand swing, Supplier outage, Machinery breakdown). Each countermeasure has a class: **Strategic** (an investment for the long term) or **Operational** (a quick, short-term fix). The CEO picks one or combines up to 3; the AI advisor picks exactly one (or "none").

### 13.1 The pool

| id | Label | Class | Parameter (min..max, step, default) | Cost basis |
|---|---|---|---|---|
| `improve-machine` | Improve a machine (faster M3) | Strategic | `minutesSaved` 1..2, 1, **2** | Rate card: EUR 30,000 per minute, amortised over 1,920 shifts |
| `new-line` | New assembly line (second M3) | Strategic | `releaseInterval` 7..11, 1, **8** | Rate card: EUR 95,000 + EUR 90 per scheduled hour |
| `extra-supplier` | Additional supplier | Operational | none | Rate card: +8% on the parts it supplies, EUR 2,000 qualification. **ASSUMPTION:** 240-minute lead time |
| `outsourcing` | Production outsourcing | Operational | `maxSetsPerShift` 5..30, 5, **15** | **ASSUMPTION** (no rate-card row): EUR 150 per set, at most 15 sets per shift, delivered the next shift |
| `raw-stock` | Increase stock of raw material | Operational | `stockLevel` 100..400, 50, **250** (re-order at level − 100) | Material EUR 38 + raw holding EUR 0.3 per unit per hour (the holding rate is itself an assumption: the WIP rate) |
| `finished-stock` | Increase stock of finished goods | Operational | `sets` 10..100, 10, **50** | Stock valued at EUR 103 per set + FG holding EUR 0.5 per unit per hour |

The old ids `faster-m3` and `second-m3` still work as **aliases** for one release (`improve-machine`, `new-line`). Every entry carries `category` and is returned by `catalogueFor(...)`; `appliesTo` is gone because every entry applies to every scenario. `catalog.js` now has the 4 scenarios (`standard` → spec `baseline`, `demand-swing`, `supplier-outage`, `machinery-breakdown` → spec `breakdowns`), and every UI scenario has a `disruptionId`.

**Why overtime left the pool.** It was decided with the client: the pool has 4 operational and 2 strategic measures, and overtime isn't one of them. Overtime is removed from the pool, the UI, the AI's prompt and the questionnaire. The **engine feature** (`config.overtime`), its tests, its cost line in `computeEconomics` / `costBreakdown` and the Phase 2 results stay. The compare runner accepts a raw `advice.configOverride` so its overtime tests still run.

### 13.2 New model parts

- **Additional supplier in the jit baseline** (`engine.js` `_tickSource`, `supply.js`): `config.source.backupSupplier = { enabled, leadTime: 240, premium: 0.08, qualification: 2000 }` (the numbers come from `SUPPLY_DEFAULTS.secondSupplier` through `backupSupplierDefaults()`). In an outage window the source stays stopped for the first `leadTime` ticks, then releases normally; each part released inside the window is a *backup part* (`engine.backupParts`) and costs +8%. The baseline is **not** switched to inventory mode, so the "without" numbers don't change. With `raw-stock` selected too, the existing inventory-mode `secondSupplier.enabled` is used instead. Outside an outage it changes nothing except the amortised EUR 2,000 qualification.
- **Outsourcing** (`src/simulation/outsourcing.js`, `config.outsourcing`): at each shift close, after the order book has shipped, `min(backlog − on order, maxSetsPerShift)` sets are ordered; they arrive at the start of the next shift in finished goods and ship FIFO through the normal order book (never counted twice). Tracked: `outsourcedOrdered`, `outsourcedReceived` and per shift `outsourced` / `outsourcedOrdered` (an "Outsourced" column appears in the per-shift table when used). Seed-independent. They are **not** production: `goodParts`, OEE and yield stay line-only.
- **Economics** (`costs.js`, `breakdown.js`): new lines `outsourcingCost = received × EUR 150` ("Outsourced sets", flagged ASSUMPTION) and `backupPremium` ("Additional supplier: price premium"); the qualification is a one-time cost shown as its own investment item **"Additional supplier"**. **Cost per good set** divides by good sets made + sets received from outsourcing; without outsourcing nothing changes, and the calibration (about EUR 102.8 per good set) and the 4 reference results are unchanged (`run.check.mjs` ALL PASSED).
- **Combination rules** (`resolveSelection`): `improve-machine` then `new-line` as before (M3b copies the faster M3, smallest release interval wins); `raw-stock` + `extra-supplier` give inventory mode with the second supplier enabled; `outsourcing` and `finished-stock` merge as they are; max 3, unique ids.

### 13.3 The cards (computed on the spot)

`GET /api/countermeasures/cards` runs `evaluateCountermeasure(scenario, id, defaults, { seeds: 1..10, shifts })` for the 6 countermeasures, for the scenario and **the shift limit in the top bar**. Nothing is computed at server start and nothing is written to a file.
- A card holds the 4 comparable values: **on-time delivery** (`57% → 88% (+31 pts)`), **profit change per run** (conservative: extra unsold stock valued at EUR 0; green / red), **upfront investment** (+ running cost per shift, or "none"), **cost per good set** (`EUR 102.8 → EUR 104.1`), plus the verdict chip and the class badge. The best value of each row is starred.
- The computation starts when the CEO picks a scenario or changes the shift limit (a short pause while typing); the cards show "simulating…" until their values arrive, the page polls once a second (`{ ready, pending }`), and the header states the basis: "Expected effect over 20 shifts (10 simulated runs each)". About 15–20 s at 20 shifts.
- Results live in memory by `scenario|shifts|seeds` (`src/countermeasures/cards.js`), so going back to a pair that was already computed is instant. Only one computation runs at a time, on the **most recently requested** pair (an older one is deprioritised and not continued). The runner yields to the event loop between runs so the server stays responsive.
- Only default parameters are on the cards; moving a slider shows "values at default setting — press Test to simulate yours".
- Layout: Operational group first (4 cards), then Strategic (2); the 4 values line up across cards (CSS subgrid); phone width stacks the cards in one column. The old placeholder comparison table is now filled from the same values (class badge, on time, profit change, upfront investment, running cost, extra unsold stock, verdict). The class badge also appears in the proposal card, the side-by-side title and the cost panel headline.
- Running cost per shift = all cost lines except the investment share and the starting stock, per shift (e.g. EUR 720 machine hours for the new line, plus the material and storage of the extra sets).

### 13.4 Advisor and questionnaire

- The prompt carries the scenario facts, the 6 entries with **class** and parameters and the **simulated card values** (on-time without / with, points, profit change, investment, running cost, cost per good set, verdict) read from the card store. The server waits for the cards when they aren't ready ("The advisor is reading the simulations…").
- The LLM answers with exactly one `{ countermeasureId, params, reason }`, validated as before (`parseProposal`, `checkProposal`); `parseProposal` accepts only pool ids (old ids are mapped) or **`none`**. The reason must name the class ("an operational, short-term fix" / "a strategic investment").
- **"No action" rule:** if no countermeasure improves on-time delivery and none has a positive conservative profit (Standard), the LLM answers `none`. The UI says "No countermeasure pays off in this scenario" and simulates nothing. Code backs it up: `none` is refused when an allowed card has a helpful verdict, and a pick whose simulated verdict is "No effect" / "Harmful" is sent back (the LLM is asked again once, as for other invalid answers).
- **Questionnaire:** the overtime question is deleted (old payloads with `overtime` are accepted and ignored). `fixType` is now `operational` / `strategic` / `any` (old `flexible` → `operational`, `permanent` → `strategic`), still a soft preference. The budget stays a **hard** limit: `improve-machine` = EUR 30,000 × minutes, `new-line` = EUR 95,000, `extra-supplier` = EUR 2,000, the other three EUR 0 upfront (at "Up to EUR 60,000" the new line is removed and the 4 operational ones stay).

### 13.5 Results (`node src/countermeasures/evaluate.js`, 30 runs, 20 shifts)

Written to `results/<scenario>_countermeasures.txt` and `.json` for all 4 scenarios. On time without → with; conservative profit change per run (EUR); verdict.

| Scenario (without) | Improve a machine | New line | Additional supplier | Outsourcing | Raw stock | Finished stock |
|---|---|---|---|---|---|---|
| **Standard** (100.0%) | 100.0%, −11,721, no effect | 100.0%, −42,524, no effect | 100.0%, −21, no effect | 100.0%, −45, no effect | 100.0%, −8,943, no effect | 100.0%, −3,981, no effect |
| **Demand swing** (56.8%) | 82.0%, +3,209, effective | 96.8%, −18,878, costly | 56.8%, −21, no effect | 86.9%, +5,578, effective | 56.8%, −8,943, no effect | 99.1%, +21,012, effective |
| **Supplier outage** (77.2%) | 100.0%, +4,813, effective | 100.0%, −23,443, costly | 100.0%, +11,012, effective | 94.4%, +7,280, effective | 100.0%, +2,263, effective | 100.0%, +10,992, effective |
| **Machinery breakdown** (95.5%) | 100.0%, −7,283, costly | 100.0%, −41,575, costly | 95.5%, −21, no effect | 99.3%, +1,528, delivery only | 95.5%, −9,049, no effect | 100.0%, −1,020, delivery only |

Compared with the directions we expected before running it:
- **Standard, Demand swing (except as below), Machinery breakdown:** as expected. In Standard nothing improves delivery and profit is zero or negative; the advisor answered "none" (tested with the real LLM). Demand swing: finished stock and outsourcing are the best on profit; the new line lifts delivery but loses money; raw stock and the additional supplier have no effect. Machinery breakdown: finished stock and outsourcing help, improving a machine helps delivery (but costs more than it earns), supply measures do nothing.
- **Supplier outage, mismatch 1: the additional supplier reaches 100%, not "less than the others".** The line makes about 37 sets per shift against 34 ordered, so about 27 surplus sets sit in the warehouse at the end of shift 10 (mean over 10 runs); the 240-minute gap costs about 18 sets, which the stock covers (0.2 late sets on average). The gap barely shows: the additional supplier has the best profit change of the six (+11,012, against +10,992 for finished stock), with EUR 2,000 upfront.
- **Supplier outage, mismatch 2: improving a machine and the new line lift delivery to 100% instead of "barely help".** A faster M3 makes more sets before the outage: the warehouse holds about 94 sets at the end of shift 10 instead of 27, which covers the two outage shifts (0 late sets instead of 156). Delivery is lifted by the same mechanism as the finished-goods stock, paid for with capacity instead of a stock. The model allows this (unlimited warehouse); the new line still loses money, improving a machine earns +4,813 against EUR 60,000 upfront.

### 13.6 Implementation notes

- The cards endpoint takes **`?scenario=` and `?shifts=`** (the top bar), falling back to the session's scenario and `session.runShifts`. The CEO picks the scenario before pressing Simulate, when the session has none yet, so the session alone isn't enough to start the computation at that moment.
- The "cost per good set" on the cards is the data package's definition (machine hours, material, WIP holding; the investment is shown in the row above). That is why a faster line shows a lower cost per good set.
- The 4 values are also shown in the filled comparison table; the "Overtime hours" column of the placeholder table was dropped.

### 13.7 Tests

**201 / 201 pass** (28 more than before the pool), `node src/headless/run.check.mjs` prints ALL PASSED. New or rewritten: catalogue and aliases, combination rules, backup supplier (restart after `leadTime`, identical without an outage, +8%), outsourcing (never without a backlog, never above the maximum, arrives next shift, goodParts unchanged, cost = received × EUR 150), the questionnaire (old payload mapped, budget filter), the advisor (`none`, old ids, overtime rejected, card values in the prompt), the cards (6 values, other shift limit = other values, cache hit, newest request first, endpoint with `session.runShifts`), the cost lines. Engine overtime tests are unchanged.

---

## Change log

| Date | Change |
|---|---|
| 2026-11-04 | Realism layer implemented (sections 2.1–2.9, 2.12) |
| 2026-11-04 | Review fixes: material limit, shift clock and badges, per-shift table, banner notes, regression tests (section 2.10) |
| 2026-11-04 | Phase 2: countermeasure sweep, conservative profit, out-of-sample check, recommendations attached to the reference scenarios (section 5) |
| 2026-11-04 | Demand swing countermeasures for the AI advisor: overtime engine feature + cost, catalogue with guardrails, evaluator with verdicts (section 6). Tests: 109 / 109 pass; reference check ALL PASSED |
| 2026-11-04 | CEO interface and AI shift advisor: light theme, scenario bar, Results tiles, explain / improve endpoints, engine `runShifts` auto-stop (section 8). Tests: 125 / 125 pass; reference check ALL PASSED |
| 2026-11-04 | CEO interface: speed selector (×1, ×2, ×10) and an Instant Simulation button (runs all 20 shifts at once, about 0.4 s, no animation) |
| 2026-11-04 | CEO questionnaire (code-enforced budget and overtime limits) and side-by-side comparison of two animated lines (section 9). Tests: 149 / 149 pass; reference check ALL PASSED |
| 2026-11-05 | Full interface with per-section collapse toggles, manual selection of countermeasures (any combination) with a placeholder comparison table, Current Situation bar (demo data), manual shift limit 1–60 that applies everywhere; faster second machine is charged its cycle-time investment (section 10). Tests: 163 / 163 pass; reference check ALL PASSED |
| 2026-11-05 | "Cost of the improvement" panel: headline, What you pay / What you get tables with formulas, investment box, cost per rescued order and payback, profit bridge chart; for the 10-run check and for the side-by-side run (section 11). Tests: 173 / 173 pass; reference check ALL PASSED. Long-term view planned next |
| 2026-11-05 | Documentation: "How to run it" updated (test count, AI `.env`, CEO flow); new section 12 with design decisions (what the AI reads, JEV not adopted), open explainability/finance options and the long-term plan |
| 2026-11-05 | One pool of 6 countermeasures (section 13): improve a machine and new assembly line (Strategic); additional supplier (jit backup rule), production outsourcing (new engine option, EUR 150 per set ASSUMPTION), raw-material stock, finished-goods stock (Operational) in all 4 scenarios; overtime out of the pool, UI, prompt and questionnaire (engine kept); cards with 4 comparable values simulated on the spot for the scenario and shift limit of the top bar (in-memory cache, no precomputation); the advisor reads the card values and picks exactly one or "none"; class badges everywhere; new cost lines (outsourcing, additional supplier). Tests: 201 / 201 pass; reference check ALL PASSED |
| 2026-11-05 | Repository cleanup: working documents (plans, roadmap, early result dumps, console logs) removed from the repository and listed in `.gitignore`; this document references only files in the repository |
