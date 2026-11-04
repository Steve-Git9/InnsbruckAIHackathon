# Instructions: CEO interface + AI shift advisor (for the implementing agent)

You are changing the web interface of the production-line simulation in this folder, and connecting it to an LLM.
Read this whole document before you start. Background on the project: [SIMULATION_CHANGES.md](SIMULATION_CHANGES.md) and [DATA_README.md](DATA_README.md).

## Goal
The user of the interface is a **CEO** of the plant. In this order, they:
1. pick a disruption;
2. click **Simulate** and watch the existing animated line run;
3. read a clean **Results** summary in tiles;
4. click **Explain me these results**: the LLM explains the run in plain words;
5. click **How to improve the results?**: the LLM proposes **one** countermeasure from the existing catalogue (only demand swing has countermeasures for now), and the simulation checks it.

## Hard constraints (do not break these)
- **Do not change simulation behaviour.**
  - `npm test` must stay green (109 tests today).
  - `node src/headless/run.check.mjs` must still print `ALL PASSED`.
  - The 4 reference scenarios must give the same numbers.
  - Only add things that are off by default.
- **Keep the animated simulation diagram exactly as it is** (`#pipeline-svg`, `buildPipeline` / `updatePipeline` in `src/public/app.js`).
- **Do not delete the old controls and metrics.** Hide them: `app.js` still references their elements, and removing them would throw errors.
- **Secrets:**
  - `CLIENT_ID` and `CLIENT_SECRET` live in `.env`, which is already git-ignored.
  - Call the LLM **only from the server**. Never send the secret to the browser, never put it in a response body or error message, never log it.
- **No new npm dependencies.** Node ≥ 20 has `fetch`; parse `.env` yourself.
- **The LLM never produces numbers.** Every number shown comes from the simulation. The LLM only words them, and picks a countermeasure **id + parameters** from the catalogue.
- Code style: ES modules, same style as the existing files, short plain comments.
- **Line endings:** `src/simulation/engine.js` and `src/headless/run.js` use CRLF. Keep each file's existing line endings.

---

## Step 1: Light theme
File: `src/public/style.css` (the colour tokens are in `:root` at the top).

1. Change the `:root` tokens to a light palette, for example:
   - `--bg: #f6f7f9`
   - `--surface: #ffffff`
   - `--surface2: #eef0f4`
   - `--border: #d9dde5`
   - `--text: #1f2430`
   - `--text-dim: #5b6475`
   - `--accent: #4f46e5`

   Keep the state colours (processing green, starved amber, blocked red, down purple, bottleneck orange), but make sure they read well on white.
2. Find the **hard-coded dark colours** and change them to light equivalents. There are about 56 hex colours in `style.css` and about 41 in `app.js`. In `app.js` they are mainly the colour maps in `updateMachine` and the SVG drawing code:
   - `arcColours`, `textColours`, `bgColours`, `strokeColours`, `fillColours`;
   - e.g. `IDLE: '#2e3347'`, `bgColours` like `#166534` / `#1e293b`, and text such as `#94a3b8`.

   Machine boxes should get light tinted backgrounds (e.g. pale green for PROCESSING, pale amber for STARVED, pale red for BLOCKED, pale purple for DOWN) with dark text.
3. The header badges and the per-shift table added earlier (end of `style.css`) need light colours too.
4. **Check:** every text in the diagram is readable, and no dark panel is left.

## Step 2: Top bar with scenario selector and Simulate button
**File `src/public/index.html`.** Directly under the `<header>` and above `#pipeline-container`, add:

```html
<div id="scenario-bar">
  <label for="scenario-select">Scenario</label>
  <select id="scenario-select">
    <option value="standard" selected>Standard</option>
    <option value="demand-swing">Demand Swing</option>
    <option value="supplier-outage">Supplier Outage</option>
    <option value="machinery-breakdown">Machinery Breakdown</option>
  </select>
  <button id="btn-simulate" type="button">Simulate</button>
  <span id="run-status"></span>   <!-- e.g. "Running – shift 7 of 20" / "Finished – 20 shifts" -->
</div>
```

**Scenario definitions.** Create `src/ui/scenarios.js`. Each scenario starts from `DEFAULT_CONFIG`, with material set to unlimited (`source.materialStock = -1`), seed 1, a run length of **20 shifts**, and no starting stock. These match the reference scenarios of the data package:

| UI value | Demand | Outage | Breakdowns | Catalogue disruption id |
|---|---|---|---|---|
| `standard` | flat 34 per shift | none | off | none |
| `demand-swing` | first 20 rows of `demand_profile.csv` (`loadDemand()` in `src/data/loaders.js`) | none | off | `demand-swing` |
| `supplier-outage` | flat 34 | `{ startTick: 4800, endTick: 5760 }` (shifts 11–12) | off | none yet |
| `machinery-breakdown` | flat 34 | none | `{ enabled: true }` | none yet |

Export a function like `buildUiScenario(id)` that returns `{ id, label, configureOptions, disruptionId }`. Reuse `engine.configureScenario(...)` (it already accepts `seed`, `demand`, `outage`, `failures`, `initialFinishedGoods`).

**Auto-stop after 20 shifts (engine, off by default).** In `src/simulation/engine.js`, add an optional `config.runShifts`. In `_closeShiftIfDue()`, right after a shift row is closed:

```js
if (this._config.runShifts && this.orders.rows.length >= this._config.runShifts) {
  this.pause();
  this.emit('run-complete', this.getState());
}
```

Accept `runShifts` in `configureScenario`, and add a unit test: a 2-shift run pauses with `orders.rows.length === 2`. The headless runner calls `_tick()` directly, so `pause()` does not affect it.

**Server.** In `src/server.js`, add the action `runScenario` to `POST /api/control` with `params: { scenario }`:
1. Validate `scenario` against the 4 ids (return 400 otherwise).
2. `engine.loadConfig(DEFAULT_CONFIG with materialStock -1)`, then `engine.configureScenario({ ...options, runShifts: 20 })`.
3. Store `session.scenario = id` and clear `session.advice`.
4. Set speed 10 with `controls.setSpeed(engine, 10)`, then `controls.play(engine)`.

A full run is 9,600 ticks: at 10× (100 ticks/s) it takes about 1.5 minutes. Do not change the speed rules in `src/controls.js`.

**UI (`app.js`).** Clicking **Simulate**:
- posts `runScenario`;
- clears the Results and Advisor panels;
- disables **Simulate** and the advisor buttons while running;
- shows "Running – shift N of 20" in `#run-status`, using `state.plantTick` from the SSE stream: shift = `ceil(plantTick / 480)`.

When the run finishes, enable the buttons and load the results (Step 3). Clicking **Simulate** again restarts the run.

## Step 3: Hide the old UI, add the Results tiles
**Hide (do not delete):** in `index.html`, add a `legacy-hidden` class (`display: none !important`) to:
- `<section id="controls">`;
- `<section id="metrics">`;
- `#suggestion-banner`;
- the old "Realism" and "Plant default" rows (they're inside `#controls`).

Below `#pipeline-container`, add:

```html
<section id="results">
  <h2>Results</h2>
  <div id="results-empty">Choose a scenario and click Simulate.</div>
  <div id="result-tiles" class="tiles"></div>
</section>
```

**Pure summary builder:** create `src/ui/run-summary.js`, with `buildRunSummary(engine, scenario)` returning plain JSON. Reuse:
- `liveResult(engine)` and `machineKpis(engine, totalTicks)` from `src/simulation/summary.js`;
- `computeEconomics(result, engine.getConfig(), DEFAULT_CONFIG, RATE_CARD)` from `src/economics/costs.js` (the server already loads `RATE_CARD`);
- `bottleneckLoss(engine.getHistory(), { outage: cfg.source.outage, config: cfg })` from `src/analysis/analysis.js`;
- `engine.events` for breakdowns.

It must contain at least:
- `scenario: { id, label }`, `shifts`;
- `orders: { ordered, shippedOnTime, serviceLevel, late (= ordered − shippedOnTime), backlogEnd }`;
- `production: { goodParts, goodPerShift, scrap, released, lineYield }`;
- `money: { profit, costPerGoodUnit, revenue, lostSalesPenalty }`;
- `worstShift: { shift, orders, shippedOnTime, short }`: the shift with the largest shortfall, or `null`;
- `bottleneck: { machine, utilisation, lostMinutes, mainCause }`: from `bottleneckLoss`; `mainCause` is the largest loss category in plain words;
- `disruption`, depending on the scenario:
  - outage: `{ window: 'shifts 11–12', sourceHaltedMinutes: 960, bottleneckStarvedByOutageMinutes }`;
  - breakdowns: `{ count, downMinutesByMachine, availabilityByMachine }`;
  - demand swing: `{ peakShift, peakOrders, minOrders }`;
  - standard: `null`;
- `perShift`: the rows from `shiftRowsFromEngine(engine)`.

**Endpoint:** `GET /api/results` returns:
- `{ status: 'idle' | 'running' | 'done', scenario, shiftsDone, shiftsTotal: 20, summary }`;
- `summary` only when `done`, i.e. 20 shift rows are closed.

**Tiles:** render each as a card with a title, a big value and a one-line caption.

| Tile | Big value | Caption |
|---|---|---|
| Orders on time | `serviceLevel` % (green ≥ 95, amber 80–95, red < 80) | "X of Y sets delivered on time" |
| Late / missed sets | `late` | "backlog at the end: N sets" |
| Sets produced | `goodParts` | "≈ N per shift · scrap N" |
| Profit | EUR `profit` | "cost per good set EUR N" |
| Bottleneck | machine id + utilisation % | "lost N min, mainly: `mainCause`" |
| Worst shift | "Shift N" | "ordered N, on time N" (or "No shift missed orders") |
| Disruption | scenario-specific (see `summary.disruption`) | e.g. "Supplier stopped for shifts 11–12" / "7 breakdowns, M3 down 210 min" / "Peak order: 61 sets in shift 1" / "No disruption" |

Keep the layout calm: a grid of 3–4 tiles per row, using the light theme tokens. Show **Results** only when `status === 'done'`. Before that, show `#results-empty` or the running status.

## Step 4: "Explain me these results" (LLM)
**LLM client:** create `src/advisor/llm.js`. It mirrors `api.py`:
- **Credentials:** `CLIENT_ID` and `CLIENT_SECRET` from `process.env`. If they're missing, parse `.env` in the repo root: `KEY=VALUE` lines, ignore `#` comments and blank lines, strip quotes.
- **Request:** `POST ${LLM_BASE_URL}/api/v1/llm/chat`.
  - Default `LLM_BASE_URL` is `https://ca-backend-mciai-prod.mangoforest-0c569892.swedencentral.azurecontainerapps.io` (from `api.py`); allow an env override.
  - Headers: `X-Client-ID`, `X-Client-Secret`, `Content-Type: application/json`.
  - Body: `{ model: 'gpt-4o', messages, temperature, maxTokens }`.
- **Response:** the text is `json.data.content`.
- Timeout 30 s with `AbortController`.
- Export `chat(messages, { temperature, maxTokens })`. Make the function **injectable**, e.g. `createAdvisor({ chat })`, so tests can mock it.
- **Errors:** throw a clean message such as "The AI service is not reachable" or "AI credentials missing". It must never contain the secret.

**Endpoint:** `POST /api/advisor/explain`.
- It requires the run to be `done` (409 otherwise).
- Build the facts with `buildRunSummary`. Send the compact JSON (drop long arrays except `perShift`).
- System prompt (adapt the wording, keep the rules):

  > You are the AI shift advisor of Smart Tech Components, a plant that makes TV stand-and-frame sets on a 4-station line (M1 machining, M2 quality check, M3 assembly — the bottleneck, M4 packaging).
  > You talk to the CEO: plain business language, no jargon.
  > Use ONLY the numbers in the FACTS JSON. Do not calculate new numbers, do not estimate, do not invent causes that the facts do not show.
  > Structure: 1) What happened (2–3 sentences). 2) Main cause. 3) Impact on customers and on money. Maximum 180 words. Do not recommend actions (there is a separate button for that).

- User message: `FACTS:\n<json>`.
- Use `temperature 0.2` and `maxTokens 600`.
- Return `{ text }`. On LLM failure return 502 with `{ error }`.

**UI:** below **Results**, add an `#advisor` section containing:
- the two buttons;
- an output card `#advisor-output`, labelled "AI explanation – based only on the simulation numbers above".

Show a spinner while waiting, and disable both buttons during a request.

## Step 5: "How to improve the results?" (LLM proposes, simulation checks)
**Endpoint:** `POST /api/advisor/improve`. It requires `done` (409 otherwise). Use the existing catalogue `src/countermeasures/catalog.js`: `catalogueFor(disruptionId)` and `resolveCountermeasure(id, params, disruptionId)`.

1. **No catalogue for this scenario** (`standard`, `supplier-outage`, `machinery-breakdown`): **do not call the LLM.** Return:
   - `{ status: 'no-options', text: 'No countermeasures are available yet for <label>.' }`;
   - for `standard`, use "This is the normal week without disruption; there is nothing to fix."
2. **Demand swing:** call the LLM.
   - **System prompt:** same role and rules as Step 4, plus:

     > Choose exactly ONE countermeasure from the CATALOGUE. Answer with JSON only, no text around it: {"countermeasureId": "<id>", "params": { ... }, "reason": "<2–4 sentences for the CEO, using only numbers from FACTS>"}. Parameters must be within min/max and steps; omit a parameter to use its default.

   - **User message:** `FACTS:\n<json>\n\nCATALOGUE:\n<JSON.stringify(catalogueFor('demand-swing'))>`.
   - **Do not ask the CEO clarifying questions** (out of scope for now).
   - **Parse** the answer: strip json code fences and take the first `{…}` block. **Validate** with `resolveCountermeasure(id, params, 'demand-swing')`.
     - If parsing or validation fails, retry **once**, adding the error to the conversation.
     - If it fails again, return 502 with `{ error: 'The AI gave an invalid proposal' }`.
3. **Check the proposal in the simulation** (the core of our concept):
   - Call `evaluateCountermeasure('demand-swing', id, params, { seeds: range(1, 10) })` from `src/countermeasures/evaluate.js`. It runs 10 runs without and 10 runs with the countermeasure, takes about 10–20 s, and caches the "without" runs.
   - Return `{ status: 'proposed', countermeasure: { id, label, params, cost }, reason, check: { runs, without, with, change, verdict } }`.

**UI:** show a proposal card with:
- the countermeasure name and settings (e.g. "Overtime on busy shifts – max 120 min per shift");
- the AI's reason;
- the cost note;
- "Simulation check (10 runs)", with on-time % before → after, the profit change (use `change.profitConservative.mean`; show the official one smaller), and a verdict badge from `check.verdict.code`:
  - `effective` → green "✅ Works";
  - `costly` → red "❌ Costs more than it earns";
  - otherwise → grey, using `check.verdict.text`.

While the check runs, show "Testing the proposal in the simulation…".

**State the difference in the UI:** a small note under the check says "The check compares averages of 10 runs; the animation above is one run". Otherwise the CEO may wonder why the numbers differ slightly.

For `no-options`, show the text in the same card, neutral style.

## Step 6: Docker and docs
- In `docker-compose.yml`, add `env_file: .env` to the `app` service, so the container gets the credentials. The image copies only `src/`, so `.env` is not inside it.
- In `README.md`, add a short "CEO interface" section: choose a scenario → Simulate → Results → Explain / Improve. Say that the LLM needs `.env` with `CLIENT_ID` / `CLIENT_SECRET`.
- In [SIMULATION_CHANGES.md](SIMULATION_CHANGES.md):
  - add a section **"8. CEO interface and AI shift advisor"**: what was built, why, how it was validated, how to run it;
  - add a **change-log row**.

  This document is a deliverable that is kept up to date after every change.

## Tests to add (`test/`)
- `ui-scenarios.test.js`:
  - each of the 4 ids builds the expected options (outage window, `failures.enabled`, demand length 20, flat 34 for the others);
  - an unknown id throws.
- Engine: `runShifts` pauses after N shifts. Without `runShifts`, behaviour is unchanged.
- `run-summary.test.js`: run the engine headless for 20 shifts (call `_tick()` until 20 rows) for `demand-swing` and `supplier-outage`, then check:
  - `buildRunSummary` fields exist;
  - `late = ordered − shippedOnTime`;
  - the service level equals the order book's;
  - `worstShift` is the max shortfall;
  - the outage scenario has `disruption.window`.
- `advisor.test.js`, with a **mocked** `chat`:
  - explain sends the FACTS and returns the text;
  - improve for `supplier-outage` returns `no-options` and **does not call** `chat`;
  - improve with an invalid id, then a valid answer, retries once and succeeds;
  - two invalid answers return an error;
  - a valid proposal calls the evaluator. Inject or mock it, so tests stay fast.
- Make sure no test makes a real network call.

## Acceptance checklist
- [ ] Light theme everywhere; the diagram is readable.
- [ ] The top bar shows **Standard** selected by default, next to the **Simulate** button.
- [ ] Each of the 4 options runs the animated simulation and stops by itself after 20 shifts (about 1.5 min).
- [ ] Nothing of the old UI is visible below the diagram; only Results (tiles) and the Advisor section.
- [ ] The tiles show the summary after the run, with numbers matching `/api/kpis`.
- [ ] **Explain me these results** returns a plain-language explanation using only simulation numbers.
- [ ] **How to improve the results?**:
  - for **Demand Swing**, proposes exactly one of `overtime` / `faster-m3` / `second-m3`, then shows the simulation check and a verdict;
  - for the other options, shows "no options" without calling the LLM.
- [ ] The secret never appears in the browser (check the network tab and the page source), in logs, or in errors.
- [ ] `npm test` is all green, and `node src/headless/run.check.mjs` prints `ALL PASSED`.
- [ ] `SIMULATION_CHANGES.md` and `README.md` are updated.
