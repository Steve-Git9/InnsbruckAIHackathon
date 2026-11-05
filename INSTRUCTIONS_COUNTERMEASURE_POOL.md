# Instructions: one pool of 6 countermeasures for every scenario

For: the agent who implements this. Read `SIMULATION_CHANGES.md` sections 6, 8–11 first:
they describe the catalogue, the advisor, the manual selection and the cost panel you will change.

## 1. Goal in one paragraph

Today the countermeasure catalogue has 3 entries (overtime, faster M3, second M3) and is offered
only for **Demand swing**. Replace it with **one common pool of 6 countermeasures**, offered in **all
4 scenarios** (Standard, Demand swing, Supplier outage, Machinery breakdown). Each countermeasure
carries a classification label: **Strategic** or **Operational**. The CEO can pick one, or combine up
to 3. The Intelligent Shift Advisor (LLM) picks **exactly one**, the most suitable for the scenario.
The section that lists the countermeasures shows each as a **card with 4 comparable values**,
computed by simulation when a scenario is picked.

## 2. Decisions already taken with the user (do not change)

| Topic | Decision |
|---|---|
| Overtime | Removed from the pool, the UI, the LLM menu and the questionnaire. **Keep the engine feature** (`config.overtime`), its tests and the Phase 2 results. |
| "New assembly line" | The existing **second M3** (parallel assembly machine), renamed. Rate card: EUR 95,000 + EUR 90/h. |
| "Improve a machine" | The existing **faster M3** (1–2 min off the M3 cycle), renamed. Rate card: EUR 30,000 per minute. |
| Additional supplier | Reuse the existing second-supplier model: +8% price, 240-min lead time, EUR 2,000 qualification. Used only when the main supplier is out. |
| Outsourcing | An external partner fills the backlog: at the end of a shift with open orders, it delivers finished sets **next shift**. Assumptions: **EUR 150 per set**, **at most 15 sets per shift**. |
| Stock countermeasures | Adjustable sliders with defaults (raw stock 250, reorder at 150; finished goods 50 sets). |
| Card values | **Computed when a scenario is picked** (not precomputed at startup). |
| LLM choice | **Exactly one** countermeasure (with its parameter values). |
| Manual combination | Any combination, **up to 3**. |
| Scenarios | All 6 countermeasures in all 4 scenarios, **including Standard**. |

## 3. The pool

| id | Label shown to the CEO | Class | Parameters (min..max, step, default) | Cost basis |
|---|---|---|---|---|
| `improve-machine` | Improve a machine (faster M3) | **Strategic** | `minutesSaved` 1..2, 1, default 2 | Rate card: EUR 30,000 per minute, amortised over 1,920 shifts |
| `new-line` | New assembly line (second M3) | **Strategic** | `releaseInterval` 7..11, 1, default 8 | Rate card: EUR 95,000 + EUR 90 per scheduled hour |
| `extra-supplier` | Additional supplier | Operational | none | Rate card +8% material price on parts it supplies; EUR 2,000 qualification (assumption, already in `SUPPLY_DEFAULTS`) |
| `outsourcing` | Production outsourcing | Operational | `maxSetsPerShift` 5..30, 5, default 15 | ASSUMPTION: EUR 150 per outsourced set (no rate-card row) |
| `raw-stock` | Increase stock of raw material | Operational | `stockLevel` 100..400, 50, default 250 | Material at EUR 38 + raw holding EUR 0.3/unit/h |
| `finished-stock` | Increase stock of finished goods | Operational | `sets` 10..100, 10, default 50 | Stock valued at EUR 103 per set + FG holding EUR 0.5/unit/h (existing rules) |

Keep the old ids `faster-m3` / `second-m3` as **aliases** in `resolveCountermeasure` for one release, so saved
sessions and old results don't break. New code and the UI use the new ids.

Add a field `category: 'strategic' | 'operational'` to every catalogue entry, and return it from
`catalogueFor`. Remove `appliesTo`. Every entry applies to every scenario.

## 4. Engine and model work

### 4.1 Additional supplier (`extra-supplier`)
The 4 reference scenarios run in supply mode `jit`, where the outage simply stops the source. The existing
second-supplier logic lives only in `inventory` mode. **Do not switch the baseline to inventory mode.**
That changes the "without" numbers: the default (s,Q) raw stock alone already gives 99.9% on time in the outage
(`results/phase2_results.txt`, row "Outage, raw stock (s,Q) default").

Add a small backup-supplier rule for `jit` mode in `engine.js` `_tickSource` / `supply.js`:
- config: `source.backupSupplier = { enabled, leadTime: 240, premium: 0.08, qualification: 2000 }`
  (take the values from `SUPPLY_DEFAULTS.secondSupplier`, don't duplicate the numbers).
- During an outage window, the source stays stopped for the first `leadTime` ticks. After that it releases normally,
  and each part released inside the window is counted as a backup part (price × 1.08).
- `computeEconomics` adds: material premium for backup parts, plus the qualification cost as a **one-time** cost
  (amortised like investments). Show it as its own cost line ("Additional supplier") in the cost panel.
- If `raw-stock` is also selected (inventory mode), use the existing `secondSupplier.enabled = true` instead.
- Outside an outage it changes nothing except the amortised qualification cost. The card should show exactly that.

### 4.2 Outsourcing (`outsourcing`)
New engine option `config.outsourcing = { enabled, maxSetsPerShift, pricePerSet: 150, leadShifts: 1 }`
(`OUTSOURCING_DEFAULTS` in a new `src/simulation/outsourcing.js`, documented as an ASSUMPTION like overtime).
- At each shift close (`_closeShiftIfDue`, after the order book has shipped), if backlog > 0, order
  `min(backlog − already on order, maxSetsPerShift)` sets.
- They arrive at the **start of the next shift** in finished goods. They ship through the normal OrderBook (FIFO, oldest
  backlog first), so they are never counted twice.
- Track `outsourcedOrdered`, `outsourcedReceived`, and per-shift `outsourced` in the shift rows
  (`shiftRowsFromEngine`). Show them as a column in the per-shift table.
- Economics: new line `outsourcingCost = received × pricePerSet`. Revenue comes from shipping as usual.
  **Cost per good set** becomes total cost ÷ (good sets made + sets received from outsourcing). Without outsourcing,
  nothing changes. Check that the calibration test (≈ EUR 102.8) still passes.
- Outsourced sets are **not** production: `goodParts`, OEE and yield stay line-only.
- Seed-independent (no randomness), so the paired comparison stays clean.

### 4.3 Raw-material stock (`raw-stock`)
`config.supply = { mode: 'inventory', reorderPoint: stockLevel − 100, orderQty: 150, initialStock: stockLevel }`.
The default 250 reproduces the existing `SAFETY_STOCK` of `src/scenarios/scenarios.js`, so reuse that object as the default.

### 4.4 Finished-goods stock (`finished-stock`)
`initialFinishedGoods = sets`, as today in the Phase 2 recommendations.

### 4.5 Combination rules (`resolveSelection`)
- `improve-machine` then `new-line`: unchanged (M3b copies the already faster M3; smallest release interval wins).
- `raw-stock` + `extra-supplier` → inventory mode with `secondSupplier.enabled = true` (and no jit backup rule).
- `outsourcing`, `finished-stock`: independent, merge as is.
- Still max 3, unique ids. Update the comment block at the top of `resolveSelection`.

## 5. Scenarios and evaluation

- `src/countermeasures/catalog.js`: replace `DISRUPTIONS` with all 4 scenarios, mapped to the existing specs in
  `SCENARIOS`: `standard` → `baseline`, `demand-swing` → `demand-swing`, `supplier-outage` → `supplier-outage`,
  `machinery-breakdown` → `breakdowns`. Keep plain-language descriptions like the existing demand-swing one.
- `src/ui/scenarios.js`: set `disruptionId` for **all four** scenarios (today only demand swing has one). Search for
  every `if (!sc.disruptionId)` / `disruptionId: null` path in `server.js`, `advisor.js`, `app.js` and update it.
- `evaluate.js`: CLI loops over **all 4 scenarios × 6 countermeasures** when called without an argument. It writes
  `results/<scenario>_countermeasures.txt/.json`. Delete the old `demand-swing_countermeasures.*` only after the new
  ones are written. Remove the overtime line from `formatEvaluations`, and add outsourced sets / backup parts when not 0.
- `verdictOf` stays as it is.

## 6. The cards (UI and server)

### 6.1 Endpoint
`GET /api/countermeasures/cards` → for the current session scenario and shift limit, runs
`evaluateCountermeasure(scenario, id, defaults, { seeds: range(1, 10), shifts })` for each of the 6.
- **Measured cost:** about 2.5 s per countermeasure at 20 shifts (5 s for the first, which includes the baseline).
  So all 6 take about 15–20 s, and longer at 60 shifts. Therefore:
  - cache results by `scenario|shifts|seeds` (a Map like `baseCache` in `evaluate.js`);
  - compute in the background when the scenario or the shift limit changes, and let the endpoint return what's done
    so far (`{ ready: [...], pending: [...] }`). The UI polls every 1 s until `pending` is empty;
  - only one computation per key at a time. A new scenario cancels or deprioritises the old one.
- Only default parameters go on the cards. If the CEO moves a slider, the card shows a small note,
  "values at default setting — press Test to simulate yours".

### 6.2 Card content (all 4 values the user asked for)
Each card, in this order:
1. **Class badge**: `STRATEGIC` (dark blue) or `OPERATIONAL` (teal). Same badge wherever the countermeasure appears:
   selection list, advisor proposal, comparison table, cost panel headline.
2. Label + one-line description + parameter slider(s).
3. Four values, same layout on every card so they line up:
   - **On-time delivery**: `57% → 88%  (+31 pts)`
   - **Profit change per run**: conservative, `+EUR 9,134` (green) / `−EUR 18,878` (red). Tooltip: "extra unsold stock valued at EUR 0".
   - **Upfront investment**: `EUR 95,000` plus `+ EUR 720 / shift` running cost (EUR 0 shown as "none").
   - **Cost per good set**: `EUR 102.8 → EUR 104.1`.
4. Verdict chip from `verdictOf` (Effective / Costly / No effect / …).
- A grey placeholder ("simulating…") on each card until its values arrive.
- Group the cards: **Operational** first (4 cards), then **Strategic** (2 cards), with a small heading for each group.
- Highlight the best value in each of the 4 rows across the cards (bold or a small ★). This makes the comparison
  readable at a glance.
- Phone width: cards stack in one column. The 4 values stay one per line.

### 6.3 Remove overtime from the UI
Remove the overtime card or checkbox, its parameter slider and any overtime wording in `index.html` / `app.js`
(27 matches today) / `style.css`. Keep the `overtimeMin` column of the per-shift table only if it isn't always 0.
Otherwise hide it.

## 7. Intelligent Shift Advisor (LLM)

- The prompt gets: the scenario facts (as today), the 6 catalogue entries with their **class** and parameters,
  **and the card values** (the 4 numbers + verdict per countermeasure, from the cache, so the LLM reasons on
  simulated numbers). If the cards aren't ready yet, wait for them (show "the advisor is reading the simulations…").
- Output: exactly one `{ id, params, reason }`, validated as today (`parseProposal`, `checkProposal`). Then the pick is
  simulated with the normal 10-run check and shown in the cost panel.
- **"No action" rule:** if no countermeasure improves on-time delivery and none has a positive conservative profit
  (likely in **Standard**), the LLM may return `{ id: 'none', reason }`. The UI then says "No countermeasure pays off in
  this scenario" and simulates nothing. Recommending a measure that loses money to a CEO would be wrong. Add this to
  the prompt and to `parseProposal`.
- The explanation must name the class ("an operational, short-term fix" / "a strategic investment").

### 7.1 Questionnaire (`src/advisor/constraints.js`)
- Delete the **overtime** question (`OPTIONS.overtime`, `OVERTIME_MIN`, `DEFAULT_ANSWERS.overtime`, the overtime branch
  of `applyConstraints`, the line in `describeAnswers`) and its UI control. `validateAnswers` must still accept old
  payloads that contain `overtime` (ignore the key), so no client breaks.
- Rename `fixType` options to match the classes: `operational` ("Operational — quick, no investment"),
  `strategic` ("Strategic — invest for the long term"), `any`. Still a **soft** preference (prompt only).
  Accept the old values `flexible` → `operational` and `permanent` → `strategic`.
- Budget stays a **hard** limit. Extend `investmentOf`: `improve-machine` = EUR 30,000 × minutes, `new-line` = EUR 95,000,
  `extra-supplier` = EUR 2,000, `outsourcing` / `raw-stock` / `finished-stock` = 0 upfront.

## 8. Tests (add to `test/`, keep all existing ones green)

1. Catalogue: 6 entries, each with a `category`. 2 strategic (`improve-machine`, `new-line`), 4 operational.
   No `overtime`. `catalogueFor(x)` returns all 6 for each of the 4 scenarios.
2. `resolveCountermeasure` rejects `overtime`, unknown ids and out-of-range values. The aliases `faster-m3` / `second-m3` resolve.
3. `resolveSelection`: max 3; `raw-stock` + `extra-supplier` gives inventory mode with the second supplier enabled.
4. Backup supplier (jit): with an outage and `extra-supplier`, the source restarts `leadTime` ticks into the window.
   Without an outage, results are identical to the baseline (same seed). Backup parts cost +8%.
5. Outsourcing: never orders when backlog = 0. Never more than `maxSetsPerShift` per shift. Sets arrive the next shift.
   `goodParts` unchanged. Cost = received × 150.
6. The 4 reference service levels and the EUR 102.8 calibration are unchanged when no countermeasure is selected
   (`node src/headless/run.check.mjs` → ALL PASSED).
7. Questionnaire: an old payload with `overtime` and `fixType: 'flexible'` is accepted and mapped. The budget filter removes
   `new-line` at "Up to EUR 60,000" and keeps all operational ones.
8. Advisor: `parseProposal` accepts `{ id: 'none' }` and rejects `overtime`.
9. Cards endpoint: returns 6 entries with the 4 values + category + verdict. A second call with the same key hits the cache.

## 9. Sanity checks on the numbers (run `node src/countermeasures/evaluate.js` and look)

Expected **direction** (not exact values). If a result contradicts this, find out why before shipping:
- Supplier outage: `finished-stock`, `raw-stock` and `extra-supplier` all lift on-time from about 77% toward 100%.
  `extra-supplier` lifts it less (the 240-min gap remains). `new-line` / `improve-machine` barely help (the line has no parts).
- Demand swing: `finished-stock` and `outsourcing` help most. `new-line` lifts delivery but loses money
  (as in section 6 of SIMULATION_CHANGES). `raw-stock` / `extra-supplier` ≈ no effect.
- Machinery breakdown: `finished-stock` and `outsourcing` help. `improve-machine` helps somewhat. Supply measures ≈ no effect.
- Standard: everything ≈ no effect on delivery and negative or zero profit. The advisor should answer "none".

## 10. Documentation

- `SIMULATION_CHANGES.md`: new section "13. One pool of 6 countermeasures". Cover: the pool table with classes, the new
  assumptions (outsourcing EUR 150 / 15 per shift / next shift; jit backup supplier), why overtime left the pool
  (engine kept), the card values, the "none" rule, test count, and a change-log row. Mark section 6 as superseded for the
  catalogue (keep it for history).
- `README.md`: update the CEO flow (cards, classes).

## 11. Done when

- `npm test` all green, `node src/headless/run.check.mjs` ALL PASSED.
- In the UI, for each of the 4 scenarios: 6 cards with badges fill in within about 20 s (20 shifts). Combining up to 3 and
  pressing Test works. "Ask the Intelligent Shift Advisor" returns exactly one pick (or "none" in Standard). The
  side-by-side comparison and the cost panel show the class badge and the new cost lines (outsourcing, backup supplier).
- `results/*_countermeasures.txt` exists for all 4 scenarios, and the directions in section 9 hold.
