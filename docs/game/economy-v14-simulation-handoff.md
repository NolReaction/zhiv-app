# Economy v14 simulation checkpoint — unfinished

The user stopped work and requested a handoff. **Do not claim the month target is achieved.** The strongest new finding is that a more capable material-trip strategy reached the actual home finale in **25.33 days free / 24.33 days with externally funded slots**, at three 30-minute visits per day. That experiment needs review and matched reruns, but already invalidates treating the slower planner as a reliable month guarantee.

## Completion and model

`WorldUpgradeContent` shows `WorldHomeFinale` when the home reaches its catalog maximum and no construction remains. Currently that is claimed home level 5. All buildings, warehouse 10, every recipe, and maximum reputation are separate optional goals.

The script starts a fresh account, uses actual TypeScript domain commands, canonical reward eligibility/amounts and a dated reward receipt helper. It pays for second/third production slots through `buy_production_slot`. Free runs receive no fictional funds. External-slot stress runs add exactly 3500 stored / 1750 visible pearls in the explicit `externalSlotBudget` ledger row, then pay normal prices and obey unlocks. Real payments remain disabled; the alternative is a declared sensitivity assumption.

Visits occur every eight hours. First visit is 60 minutes (45 for the 15-minute case); later visits are 15/20/30/60 minutes. Each manual command has an explicit default cost of two seconds. The 1/4-second variants are sensitivity checks, not observed user timings. `activeHours` includes production waiting inside visits; `manualHours` is command count × assumed seconds. Production does not restart offline. One item occupies each owned slot.

Current visible orders and construction goals determine ingredient demand; bounded batching prepares at most the owned slot count. The simulator upgrades warehouse 2/3 using real costs. It uses current ordinary orders, mining and fishing for income, and consumes owned optional meals after reserving current needs. It does not optimize food manufacturing, tackle purchases, weeklies or market trading. Recipe-source choice still underuses bundled expedition alternatives.

## Saved evidence

- `economy-v14-scenarios.json`: checkpoint metadata, complete ledgers and snapshots. `releaseValidated: false`. Distinct policy variants are explicitly separated.
- `economy-v14-opportunistic-experiment.json`: two completed but unreviewed route-aware cases. **Not connected to the stable executable script.**
- `economy-v14-opportunistic-experiment.txt`: the archived experimental function and integration notes for the next agent.
- `tests/economy-progression-scenarios.test.mjs`: 3/3 passed. Free 20-minute seed 1 reached home 5 at 40.67 days / 4978 commands; external-slot seed 7 at 39.67 days / 5007 commands. Seeded short replay and all item/currency conservation passed.

Earlier matched single-batch policy, two seconds/action: v13 15/20/30/60 minutes reached home 5 at 44.67 / 36.00 / 26.67 / 21.35 days. Candidate2 v14 gave 50.67 / 42.33 / 29.33 / 16.33 days. Seeds 1/7/42 at 20 minutes were 42.33 days in that v14 policy. These are not the final bounded-batch or route-aware strategy.

Stable bounded-batch v14 sensitivities: external slots 20/30 minutes = 40.00 / 27.33 days; 20-minute manual 1/4 seconds = 40.67 / 41.67; second slots only = 41.33; no meals = 40.00. The full free 20-minute snapshot was not saved by the source test; only its test diagnostic above is available.

The route experiment used only guaranteed outputs useful for the currently visible order/upgrade, never random loot or future orders. It avoided sending the hero away when a crop would need collection during the active visit. Free 30-minute run: 27 opportunistic trips (20 forest, 4 coastal deposits, 3 old woodland), 4167 commands, home 5 at 25.33 days. Paid-slot run: 26 trips, 4632 commands, home 5 at 24.33 days. It has no matched v13 run, no 20-minute case, no seed matrix, and no independent review. The stable script retains only non-behavioral concurrency/work/ready-idle instrumentation added alongside it; syntax was checked after removing the route policy, but there was no additional full run.

## Reproduce

Current source, complete suite (potentially several minutes):

```bash
CHOKIDAR_USEPOLLING=1 SIM_OUTPUT=/tmp/economy-v14-scenarios.json node scripts/audit-progression-scenarios.mjs
```

One selected case:

```bash
CHOKIDAR_USEPOLLING=1 SIM_CASES=free-20m-seed1 SIM_OUTPUT=/tmp/economy-v14-free20.json node scripts/audit-progression-scenarios.mjs
```

Source tests without rebuilding `dist`:

```bash
CHOKIDAR_USEPOLLING=1 node --test --test-concurrency=1 tests/economy-progression-scenarios.test.mjs
```

To reconstruct the frozen baseline (the existing `/tmp/zhiv-v13-baseline` is transient):

```bash
mkdir -p /tmp/zhiv-v13-baseline
git archive 50181334a2d94e04765a4c96090609f994b15715 | tar -x -C /tmp/zhiv-v13-baseline
ln -s "$(pwd)/node_modules" /tmp/zhiv-v13-baseline/node_modules
CHOKIDAR_USEPOLLING=1 ECONOMY_SOURCE_ROOT=/tmp/zhiv-v13-baseline SIM_OUTPUT=/tmp/economy-v13-scenarios.json node scripts/audit-progression-scenarios.mjs
```

The current runner uses current scenario policy with baseline domain/reward modules. This is the intended route for honest identical-policy comparison. Do not compare a new capable planner against the old inefficient policy as an economy improvement.

## Next work

1. Review and integrate or replace the archived opportunistic-trip policy. Check current shared stock, route input costs, hero crop conflicts, and reserved storage before relying on it.
2. Run the same final strategy against frozen v13 and current v14, including 15/20/30-minute visits, externally funded full slots, seeds 1/7/42, and 1/2/4-second command timing.
3. Recalibrate content and materials from those results; paid capacity and useful trips currently allow shorter completion than a month at 3 × 30 minutes. Do not manufacture a month using artificial waits or planner inefficiency.
4. Audit stock capacity, actual queue concurrency, miner and hero utilization, route starts, reward claim dates, pearl conservation, and cash surplus.
5. Add a genuinely funded weekly/reputation strategy separately. `scripts/audit-reputation-pace.mjs` is a theoretical fixture with supplied ingredients, not a funded progression playthrough.
6. Keep old no-gift/no-slot continuous/early/third/fourth tests distinct. They were not updated or rerun by this simulation task; their former v13 expectations may need review after catalog changes.

No commits, pushes, deployment or CI waits were performed by the simulation agent.
