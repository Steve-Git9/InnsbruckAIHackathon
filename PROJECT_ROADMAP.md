# Project roadmap: our proposal to Smart Tech Components

## The situation in one paragraph
Smart Tech Components runs a 4-station line that makes TV stand-and-frame sets: M1 machining, M2 quality check,
M3 assembly (the bottleneck), M4 packaging. It makes about 37 good sets per shift. Customers order shift by shift, and the orders swing a lot.
A supplier can fail. Today the plant misses many orders: only **57%** are delivered on time with the real demand, and **48%** with a supplier outage.
The client wants two things from us as an AI consultancy:
1. **A reliable digital model of the line** (the simulation), and
2. **An AI shift advisor** that tells the shift supervisor what is happening, what to do, and *proves* that it works.

Our pitch is **"AI that proposes, a simulation that checks"**: the supervisor only ever sees recommendations
that have been tested on the digital model, with their effect on deliveries and on money.

---

## The 4 phases

| # | Phase | Question it answers | Status |
|---|---|---|---|
| 1 | Realistic simulation | "Can we trust the model?" | **Done**: see SIMULATION_CHANGES.md |
| 2 | Find the countermeasures | "What should the plant actually do?" | Next |
| 3 | AI shift advisor | "How does the supervisor get this every shift?" | After 2 |
| 4 | Proposal package | "Why should the client buy it?" | Last |

---

## Phase 1: Realistic simulation (done, just verify)
**What:** reproducible runs, orders and outage inside the engine, costs, breakdowns, raw-material supply, scenario runner.
**How to check:** restart the server, then run `npm test` and `node src/headless/run.check.mjs` (should print ALL PASSED), then `npm run scenarios`.
**Output:** SIMULATION_CHANGES.md (our documentation for the jury).

---

## Phase 2: Find the countermeasures (the consulting answer)
This phase is the heart of the recommendation. The data package asks for **every scenario twice: without and with our countermeasure.**

**Step 2.1: list the levers the plant can pull** (all priced in `rate_card.csv`):

| Lever | Helps against | Cost |
|---|---|---|
| Start with finished-goods stock (e.g. 30–60 sets) | demand swings, outage | holding cost only |
| Raw-material safety stock | supplier outage | raw holding cost |
| Second supplier | supplier outage | EUR 2,000 one-time + 8% on parts |
| Expediting | supplier outage | +40% on parts |
| Parallel M3 (second assembly machine) | too little capacity | EUR 720/shift + 49.48/shift depreciation |
| Faster M3 (−1 tick cycle time) | too little capacity | EUR 30,000 one-time per tick |
| Lower reject rate at M2 | lost parts | EUR 8,000 per percentage point |
| Bigger buffer in front of M3 | small flow losses | EUR 150 per slot |

**Step 2.2: test them.** For each of the 4 reference scenarios, run each lever and some combinations with the scenario runner
(30 seeds, the same seeds for all). Compare **service level** and **profit** with the "without" row.

**Step 2.3: pick a recommendation per scenario.** The best is the highest profit that still meets a service-level goal (for example ≥ 95%).
Profit already includes the lost-sales penalty (EUR 90 per late unit), so it balances cost against missed orders.

**Output:** the **results table** (4 scenarios × without/with), plus 2–3 sentences per scenario on why the lever works.
*Example of the expected type of finding:* demand swings are not solved by a faster machine on average capacity. They are solved by a finished-goods buffer
built in quiet shifts. The outage is solved most cheaply by raw safety stock or a second supplier.

---

## Phase 3: The AI shift advisor
**Who uses it:** the shift supervisor, at the start of or during a shift.
**What it does, in 3 steps:**

1. **Explain**: in plain words, what happened and why.
   *"Shift 11: only 18 sets made. Cause: supplier outage since minute 1; M3 waited 420 minutes for parts."*
   The numbers come from our analysis code (`src/analysis/analysis.js`), **never invented by the AI**.
2. **Propose**: 1–3 actions for the next shifts, chosen from the fixed list in Phase 2.
   *"Order 120 parts from the second supplier now; build 40 sets of stock before shift 28 (56 orders expected)."*
3. **Check**: every proposal is run in the simulation (30 seeds) **before** the supervisor sees it.
   Only proposals that improve service level or profit are shown, with the evidence:
   *"Tested: service level 48% → 79%, profit +EUR 9,400 over 20 shifts."*

**How we build it (technical):**

| Piece | File (new) | What it does |
|---|---|---|
| Fact pack | `src/advisor/facts.js` | Collects KPIs, the per-shift summary and the bottleneck loss into a short text/JSON |
| LLM call | `src/advisor/llm.js` | Calls the hackathon API (gpt-4o, as in `api.py`); keys come from `.env` |
| Action catalogue | `src/advisor/actions.js` | The allowed actions with their limits (e.g. stock 0–100), as JSON |
| Verifier | `src/advisor/verify.js` | Runs each proposal against the baseline with the scenario runner and accepts or rejects it |
| Advisor flow | `src/advisor/advisor.js` | facts → LLM (explain + propose JSON) → verify → final report |
| UI | "Ask the advisor" button + panel | Shows explanation, verified proposals, evidence |

**Why this design is better than "just ask ChatGPT":**
- **No made-up numbers.** The AI only words facts that we computed.
- **No unsafe advice.** It can only pick from priced, bounded actions.
- **Proof.** Every recommendation is tested on the model, and we show the before/after numbers.
- **Repeatable.** Same input, same answer, because runs are seeded.

**Output:** a working demo. Load the "Both" scenario, click "Ask the advisor", read the explanation and the verified proposals.

---

## Phase 4: The proposal package (what we hand in and present)
1. **Pitch deck** (about 10 slides):
   - client problem (57% / 48% service level);
   - our approach;
   - simulation (why trustworthy);
   - results table;
   - advisor demo screenshots;
   - business case (EUR per shift saved);
   - roadmap for real deployment (connect to live machine data).
2. **Live demo script** (3 minutes): normal line → outage hits → advisor explains → advisor proposes → check shows the improvement.
3. **Documents:** SIMULATION_CHANGES.md (the model), the results table, and a short advisor design note.
4. **Business case:** profit with versus without our recommendations over 20 shifts, scaled to a year (240 shifts).

---

## Suggested schedule

| Day | Work |
|---|---|
| Day 1 | Verify Phase 1. Phase 2: test the levers, fill the results table |
| Day 2 | Phase 3: fact pack, action catalogue, verifier (no AI yet: it works with hand-written proposals) |
| Day 3 | Phase 3: connect the LLM, UI panel, end-to-end demo |
| Day 4 | Phase 4: deck, demo rehearsal, final documents |

## Who does what (suggestion for a team of 3–4)
- **Analyst:** Phase 2 experiments, results table, business case.
- **Developer:** advisor code and UI (Phase 3).
- **Storyteller:** deck, demo script, documents (Phase 4). Starts on Day 2 using early results.
- **Everyone:** rehearse the demo on the last day.
