# Intelligent Shift Advisor: benchmark

2026-11-05 · 4 scenarios × 6 CEO profiles × 3 repeats = **72 answers** from the real AI · 20 shifts · card values from 10 simulated runs

## Scorecard

| Check | Result | |
|---|---|---|
| Valid answer at the first try | **70 / 72** (97%) | JSON with a pool id and allowed parameters |
| Valid answer (after at most one retry) | **72 / 72** (100%) | otherwise the CEO sees an error |
| Within the CEO's limits (budget) | **72 / 72** (100%) | enforced in code, re-checked here |
| Picks the expected option | **59 / 72** (82%) | the rule for the CEO's goal, below |
| Picks an acceptable option | **71 / 72** (99%) | near ties count: ±1 pt on time, ±max(EUR 500, 5%) profit |
| Says "none" when nothing pays off | **36 / 36** (100%) | Standard scenario |
| Same answer in every repeat | **23 / 24** (96%) | per scenario and profile |
| Names the class of its pick | **35 / 36** (97%) | "operational" / "strategic" |
| Numbers in the explanation found in its input | **180 / 180** (100%) | allowing rounding and %; integers below 13 ignored |
| Explanations with every number found | **72 / 72** (100%) |  |

Average time per answer: 1.3 s.

## The expected option (rule per CEO goal)

Only options the CEO's budget allows and the advisor may pick (not "No effect" / "Harmful") are considered. Values are the simulated card values the AI also reads.

| CEO goal | Expected option |
|---|---|
| No answers ("Give me the best") | Highest on-time delivery among options that do not lose money (if all lose money: the smallest loss) |
| On-time delivery | Highest on-time delivery among options that do not lose money (if all lose money: highest on-time) |
| Profit | Highest profit change (unsold extra stock valued at EUR 0) |
| A balance of both | Options reaching ≥ 95% on time first, then highest profit change |
| Nothing helps | "none" |

## Results per scenario and profile

| Scenario | Profile | Expected | Acceptable | AI picks (each repeat) | Consistent |
|---|---|---|---|---|---|
| standard | best | none | none | none ✅, none ✅, none ✅ | yes |
| standard | delivery | none | none | none ✅, none ✅, none ✅ | yes |
| standard | profit | none | none | none ✅, none ✅, none ✅ | yes |
| standard | balance | none | none | none ✅, none ✅, none ✅ | yes |
| standard | budget-60k | none | none | none ✅, none ✅, none ✅ | yes |
| standard | no-investment | none | none | none ✅, none ✅, none ✅ | yes |
| demand-swing | best | finished-stock | finished-stock | finished-stock ✅, finished-stock ✅, finished-stock ✅ | yes |
| demand-swing | delivery | finished-stock | finished-stock | finished-stock ✅, finished-stock ✅, finished-stock ✅ | yes |
| demand-swing | profit | finished-stock | finished-stock | finished-stock ✅, finished-stock ✅, finished-stock ✅ | yes |
| demand-swing | balance | finished-stock | finished-stock | finished-stock ✅, finished-stock ✅, finished-stock ✅ | yes |
| demand-swing | budget-60k | finished-stock | finished-stock | finished-stock ✅, finished-stock ✅, improve-machine ❌ | no |
| demand-swing | no-investment | finished-stock | finished-stock | finished-stock ✅, finished-stock ✅, finished-stock ✅ | yes |
| supplier-outage | best | finished-stock | improve-machine, extra-supplier, raw-stock, finished-stock | extra-supplier ✅, extra-supplier ✅, extra-supplier ✅ | yes |
| supplier-outage | delivery | finished-stock | improve-machine, extra-supplier, raw-stock, finished-stock | extra-supplier ✅, extra-supplier ✅, extra-supplier ✅ | yes |
| supplier-outage | profit | extra-supplier | extra-supplier, finished-stock | finished-stock ✅, finished-stock ✅, finished-stock ✅ | yes |
| supplier-outage | balance | extra-supplier | extra-supplier, finished-stock | extra-supplier ✅, extra-supplier ✅, extra-supplier ✅ | yes |
| supplier-outage | budget-60k | extra-supplier | extra-supplier, finished-stock | finished-stock ✅, finished-stock ✅, finished-stock ✅ | yes |
| supplier-outage | no-investment | finished-stock | raw-stock, finished-stock | finished-stock ✅, finished-stock ✅, finished-stock ✅ | yes |
| machinery-breakdown | best | none | none | none ✅, none ✅, none ✅ | yes |
| machinery-breakdown | delivery | none | none | none ✅, none ✅, none ✅ | yes |
| machinery-breakdown | profit | none | none | none ✅, none ✅, none ✅ | yes |
| machinery-breakdown | balance | none | none | none ✅, none ✅, none ✅ | yes |
| machinery-breakdown | budget-60k | none | none | none ✅, none ✅, none ✅ | yes |
| machinery-breakdown | no-investment | none | none | none ✅, none ✅, none ✅ | yes |

## Answers that differ from the rule (1)

- **demand-swing / budget-60k #3**: picked `improve-machine`, expected `finished-stock` (>= 95% on time, then highest profit). Reason given: "This is a strategic investment that balances on-time delivery improvement (+25.1 percentage points, from 0.569 to 0.82) and profit increase (+€3,228 per run). It fits the CEO's investment limit (€60,000 upfront cost)."

## Numbers not found in the AI's input (0 answers)

Usually a number the AI calculated itself (a difference or a sum). Not necessarily wrong, but not checked by the simulation.

None.
