# Instructions: full interface, manual countermeasure selection, Current Situation bar, shift limit

**For the implementing agent.** This continues
[INSTRUCTIONS_UI_AND_ADVISOR.md](INSTRUCTIONS_UI_AND_ADVISOR.md) and [INSTRUCTIONS_IMPROVE_AND_COMPARE.md](INSTRUCTIONS_IMPROVE_AND_COMPARE.md).
Both are built (sections 8 and 9 of [SIMULATION_CHANGES.md](SIMULATION_CHANGES.md); 149 tests pass). Read this whole
document and the current code before you start.

## Goal: five changes
1. **Full interface back.** The old controls and metrics (now hidden with `legacy-hidden`) become visible again, *next to* the new features. **Every section gets its own collapse/expand toggle.**
2. **"How to improve the results?" shows the three countermeasures.** The CEO can pick one, or **any combination**, and test it. If unsure, the CEO clicks **Ask the Intelligent Shift Advisor**, which opens today's questionnaire + LLM flow unchanged.
3. **A comparison table of the three countermeasures**, as a **placeholder only** for now.
4. **A "Current Situation" bar at the top**: finished-goods stock, raw-material stock, last maintenance. It's **visual only**, with demo values from a JSON file.
5. **A manual shift limit next to Simulate** (1–60, default 20). It applies **everywhere**: the run, the Results, the AI check, and the side-by-side comparison. Keep the **Instant Simulation** button.

**User decisions:**
- per-section toggles only (no master switch);
- any combination of countermeasures allowed;
- the shift limit applies everywhere;
- plausible demo values for the Current Situation.

## Hard constraints (unchanged)
- **Do not change simulation behaviour.**
  - `npm test` must stay green (149 today) plus the new tests.
  - `node src/headless/run.check.mjs` must print `ALL PASSED`.
  - The 4 reference scenarios at 20 shifts must give the same numbers.
- **Don't break** the main diagram, the side-by-side comparison (`src/public/pipeline-view.js`, `src/ui/compare-runner.js`), or the existing CEO flow.
- **Secrets stay on the server.** The LLM is only called through `src/advisor/llm.js`.
- **No new npm dependencies.**
- **The LLM never produces numbers.**
- **Line endings:** keep each file's existing ones (`engine.js` and `run.js` are CRLF).
- Only **Demand Swing** has countermeasures. For other scenarios, keep the "no options" answer.

---

## Step 1: Bring the old interface back, with per-section toggles
**Show again:** remove `legacy-hidden` from:
- `<section id="controls">`;
- `<section id="metrics">`;
- `#suggestion-banner`.

Keep the `legacy-hidden` CSS class (it may be used elsewhere).

**Page order, top to bottom:**
1. Header
2. **Current Situation** (new, Step 4)
3. Scenario bar (Scenario, **Shifts** (new, Step 5), Speed, Simulate, Instant Simulation, status)
4. Diagram (`#pipeline-container`, with the suggestion banner)
5. Results
6. AI shift advisor (improve panel, Step 2)
7. Side-by-side comparison
8. **Advanced controls** (the old `#controls`)
9. **Advanced metrics** (the old `#metrics`)

**Collapse toggles.** Give every section above (except the header) a section header row: title on the left, and a small chevron button on the right (`aria-expanded`, `aria-controls`).
- Clicking the button collapses or expands the section body. The header row stays visible.
- Inside **Advanced controls**, each existing `.controls-row` group gets its own small toggle too: Simulation Control, Scenarios, Plant default, Realism, Speed, Source, Cycle times, Buffers, Machines.
- Inside **Advanced metrics**, the same for its blocks: summary cards, Orders & economics + per-shift table, sparkline, per-machine table.
- **Defaults:** the CEO sections start expanded; *Advanced controls* and *Advanced metrics* start **collapsed**.
- **Remember** each section's state in `localStorage` (key `ui.collapsed.<sectionId>`). Wrap every read and write in `try/catch`, so the page works without storage.
- Make one generic helper, e.g. `makeCollapsible(sectionEl, { id, title, defaultCollapsed })`, rather than one handler per section.

**The old controls act on the same session engine as the CEO run.** Keep the Results honest:
- **Server (`POST /api/control`):** when an action **resets or reconfigures** the engine, set `session.scenario = null` and drop `session.advice` and the comparison (`dropCompare(session)`).
  - Reconfiguring actions: `reset`, `resetToDefaults`, `loadPreset`, `loadPlantDefault`, `configureScenario` or any realism key, `spawnMachine`, `removeMachine`, and parameter changes (`cycleTime`, `bufferCapacity`, `sourceInterval`, `materialStock`, `rejectRate`).
  - Then `/api/results` returns `idle` and the Results / advisor reset.
  - `play`, `pause` and `speed` keep the CEO run.
- **Client:** when the results become `idle` this way, clear the tiles and show "The run was changed with the advanced controls – click Simulate to start a new run."

## Step 2: "How to improve the results?" shows the countermeasures
Clicking **How to improve the results?** after a Demand Swing run opens an **improve panel** in `#advisor`, in this order:

### 2a. Three countermeasure cards (manual selection)
**Data.** Add `GET /api/countermeasures`. It returns `catalogueFor(disruptionId)` for the current run's scenario, or `[]`, so the client gets ids, labels, descriptions, cost notes and parameter bounds from **one source** (`src/countermeasures/catalog.js`).

**One card per countermeasure** (Overtime on busy shifts, Faster M3, Second M3), each with:
- a **select** checkbox/toggle on the card;
- the label and the one-paragraph description;
- the cost note;
- the **parameter control**, built from the bounds. Use a select with every step between min and max, defaulting to `default`:
  - Overtime: max minutes per shift, 30–240 in steps of 30;
  - Faster M3: minutes saved, 1 or 2;
  - Second M3: release every 7–11 minutes.

Selected cards are highlighted. Any combination of 1–3 cards is allowed.

**Buttons under the cards:**
- primary **Test my selection**: disabled until at least one card is selected;
- secondary **Ask the Intelligent Shift Advisor**: opens the existing questionnaire, unchanged, with **Find my countermeasure** and **Give me the best**.

Both paths end in the **same proposal card** as today, followed by **Compare side by side**:
- the title says "Your selection" (manual) or "The advisor's choice" (LLM);
- the manual path has no AI reason, only the settings, the cost note(s), the simulation check and the verdict.

**Other scenarios:** keep today's "No countermeasures are available yet for …" (or "nothing to fix" for Standard). Show no cards, no table and no advisor button.

### 2b. Placeholder comparison table
Under the cards, add a table titled "Compare the countermeasures":

| Countermeasure | On time | Profit change | One-time investment | Running cost | Overtime hours | Extra unsold stock | Verdict |
|---|---|---|---|---|---|---|---|
| Overtime on busy shifts | — | — | — | — | — | — | — |
| Faster M3 | — | — | — | — | — | — | — |
| Second M3 | — | — | — | — | — | — | — |

- Build the rows from the catalogue (not hard-coded labels).
- Every value is `—`.
- Caption: "Placeholder – these figures will be filled from the simulation in a later step."
- Mark the table body with `data-placeholder="true"` so it's easy to wire up later.
- Style it like the rest of the light theme (light zebra rows, numbers right-aligned).

## Step 3: Combinations in the backend
**Catalogue (`src/countermeasures/catalog.js`).** Add:

```js
// selection = [{ id, params }], 1..3 entries, unique ids, all offered for disruptionId
export function resolveSelection(selection, disruptionId)
  // -> { items: [{ cm, params }], label: 'Overtime on busy shifts + Faster M3', override: { config, initialFinishedGoods? } }
```

Validate every item with `resolveCountermeasure` (bounds, steps, unknown parameters). Reject an empty selection, duplicate ids, more than 3 items, or a non-array.

**Merge rules** (combine the overrides, don't just shallow-merge them):

| Selected | Machines | Source interval | Overtime |
|---|---|---|---|
| faster-m3 | M3 cycle − `minutesSaved` | 9 (2 min saved) or 10 (1 min) | — |
| second-m3 | add M3b as a copy of M3 **after** any faster-m3 change, so M3b is fast too | `releaseInterval` | — |
| overtime | — | — | `{ enabled: true, maxMinutesPerShift }` |
| several | apply in the order faster-m3 → second-m3 | the **smallest** interval of the selected items | as above |

Keep `resolveCountermeasure` working: a one-item selection must give **exactly the same override** as today, and a test checks this.

**Investment of a faster second machine.** The rate card prices a cycle-time reduction "per tick **per machine**". Today `oneTimeCosts` in `src/economics/costs.js` skips spawned machines (`if (!bm) continue;`), so a fast M3b would not be charged.
- **Change:** for a machine that isn't in the baseline config, compare its cycle time and reject rate with the baseline machine of its **station** (`baseId(m.id)` → `M3`), and charge the reduction.
- This changes nothing for existing runs: in all of them, spawned machines have the baseline cycle.
- Add a test: Faster M3 (2 min) + Second M3 is charged 2 × 2 × 30,000 + 95,000.

**Evaluator (`src/countermeasures/evaluate.js`).** Add `evaluateSelection(disruptionId, selection, opts)`, which builds the variant from `resolveSelection(...).override`. Make `evaluateCountermeasure` a thin wrapper around it, with the same output shape (`countermeasure.label` = the combined label; add `countermeasure.items`). The base cache stays keyed by disruption, seeds and shifts.

**Advice in the session.** Change `session.advice` to:

```js
{ scenarioId, selection: [{ id, params }], label, source: 'manual' | 'advisor', shifts }
```

- The LLM path stores a one-item selection.
- `buildEngines` / `CompareRunner` in `src/ui/compare-runner.js` use `resolveSelection`.
- The comparison title shows the combined label.

**Endpoint:** `POST /api/countermeasures/test` with `{ selection }`.
- 409 if the run is not finished or a comparison is running;
- 400 on an invalid selection (the message from `resolveSelection`).
- Otherwise run `evaluateSelection(..., { seeds: range(1, 10), shifts: session.runShifts })`, store `session.advice` (`source: 'manual'`), and return the same shape as the advisor's `proposed` answer, without `reason`.

**LLM path:** unchanged (one countermeasure, questionnaire constraints), but pass `shifts: session.runShifts` to the check.

## Step 4: "Current Situation" bar (visual only)
**Data file `src/data/current_situation.json`** (demo values):

```json
{
  "asOf": "2026-11-05T06:00:00",
  "source": "demo",
  "finishedGoods": { "value": 24, "unit": "sets" },
  "rawMaterial":   { "value": 160, "unit": "units" },
  "maintenance": [
    { "machine": "M1", "name": "Machining",     "lastCompleted": "2026-10-29", "type": "Tool change" },
    { "machine": "M2", "name": "Quality check", "lastCompleted": "2026-10-21", "type": "Gauge calibration" },
    { "machine": "M3", "name": "Assembly",      "lastCompleted": "2026-11-02", "type": "Preventive maintenance" },
    { "machine": "M4", "name": "Packaging",     "lastCompleted": "2026-10-15", "type": "Inspection" }
  ]
}
```

**Endpoint:** `GET /api/current-situation` returns the file. Validate the shape on load; if the file is missing or broken, return `{ source: 'unavailable' }` and let the UI show "No data".

**UI.** A slim horizontal bar under the header, collapsible like the other sections:
- title **Current Situation**;
- three compact tiles in one row:
  - **Finished-goods stock** "24 sets";
  - **Raw-material stock** "160 units";
  - **Last maintenance** "M3 Assembly – 2 Nov 2026 (3 days ago)". Show the most recent entry; a small "all machines" toggle lists the four.
- a muted label on the right: "Demo data – not connected · as of 5 Nov 2026, 06:00";
- a one-line note: "The simulation starts from the reference setting (empty warehouse); these values are not used in it yet."

Compute "days ago" in the browser from the date. Wrap the tiles on narrow screens.

**Not connected:** don't read these values anywhere in the simulation.

## Step 5: Manual shift limit
**UI.** In the scenario bar, add **Shifts**: `<input type="number" id="shift-limit" min="1" max="60" step="1" value="20">`, placed between Scenario and Speed. Keep **Simulate** and **Instant Simulation** next to each other.
- Invalid input (empty, < 1, > 60, not an integer) disables both buttons and shows a short inline hint.
- If the scenario is **Supplier Outage** and shifts < 12, show a small note: "The supplier outage happens in shifts 11–12; choose at least 12 shifts to see all of it."
- The status line becomes "Running – shift N of X".

**Server.**
- `runScenario` accepts `params.shifts`. Validate an integer from 1 to 60 (400 otherwise; default 20) and store it as `session.runShifts`.
- `buildUiScenario(id, shifts = 20)` in `src/ui/scenarios.js` builds demand of length `shifts`: flat 34 × shifts, or rows 1…shifts of the demand profile (60 rows exist).
- Replace every use of the constant `RUN_SHIFTS` in `server.js`, `src/ui/compare-runner.js` and the run summary with the session value. Keep `RUN_SHIFTS = 20` as the **default** only. Places to change:
  - `runShifts` in `configureScenario`;
  - the Instant loop;
  - `/api/results` (`shiftsTotal`, `done`);
  - `CompareRunner` (`doneA` / `doneB`, from `advice.shifts`);
  - the evaluator calls (`shifts`).
- The tiles and the LLM facts already use `summary.shifts`. Check that the text everywhere says "over N shifts", not a fixed 20.
- **Reference values hold only at 20 shifts.** When `shifts ≠ 20`, show a small muted note under the Results: "Reference values of the data package refer to 20 shifts."

## Step 6: Tests (`test/`)
- `selection.test.js`:
  - a one-item selection equals `resolveCountermeasure`'s override (all three ids);
  - Faster M3 + Second M3 gives M3 and M3b both at the faster cycle, and the interval is the minimum;
  - Overtime + Faster M3 has both the overtime config and the faster M3;
  - empty selections, duplicates, 4 items, unknown ids, out-of-range parameters and a non-array are rejected.
- `economics-failures.test.js` (or a new file):
  - Faster M3 (2) + Second M3 investment = 2 × 2 × 30,000 + 95,000;
  - a plain Second M3 is unchanged (95,000).
- `ui-scenarios.test.js`: `buildUiScenario(id, n)` gives demand of length `n` for all 4 ids; 0, 61, 2.5 and a missing value are handled (throw, or default 20, as you define it; test it).
- Server/compare:
  - a 5-shift run finishes with `orders.rows.length === 5`;
  - `CompareRunner` with `advice.shifts = 5` stops both engines at plant tick 2,400;
  - engine A still equals a solo run.
- A test that `POST /api/control` with `reset` (or a cycle-time change) after a finished CEO run makes `/api/results` return `idle`. If testing the server directly is awkward, test the helper you extract for it.
- `current-situation.test.js`: the JSON loader returns the demo data and handles a missing or broken file.
- No test may use the network. The LLM and the evaluator stay mocked where they are today.

## Step 7: Docs
- In [SIMULATION_CHANGES.md](SIMULATION_CHANGES.md), add a section **"10. Full interface, manual selection, Current Situation, shift limit"**: what was built, why, how it was validated (test count, reference check), and how to use it. Add a **change-log row**. This file is a deliverable and must stay current.
- In `README.md`, update the "CEO interface" section.

## Acceptance checklist
- [ ] The old Advanced controls and Advanced metrics are visible again (collapsed by default), and **every section and sub-block** has its own collapse toggle, remembered across reloads.
- [ ] Using an advanced control that resets or reconfigures the engine clears the Results with a clear message.
- [ ] **Current Situation** shows finished-goods stock, raw-material stock and last maintenance, labelled as demo data.
- [ ] **Shifts** (1–60, default 20) sits next to **Simulate** and **Instant Simulation**. It drives the run, Results, AI check and comparison, with an outage hint when it's under 12.
- [ ] For Demand Swing, **How to improve the results?** shows three cards with parameter controls. Any combination can be tested with **Test my selection**, which leads to the proposal card and then **Compare side by side**.
- [ ] **Ask the Intelligent Shift Advisor** opens the existing questionnaire, and the LLM flow works as before.
- [ ] The placeholder comparison table is shown, with all values "—".
- [ ] For other scenarios, "no options" appears, with no cards and no table.
- [ ] `npm test` is all green, and `node src/headless/run.check.mjs` prints `ALL PASSED`.
- [ ] `SIMULATION_CHANGES.md` (section 10 + change log) and `README.md` are updated.
