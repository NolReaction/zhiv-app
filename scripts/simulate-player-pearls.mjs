import { pathToFileURL } from "node:url";
import { loadJourneyRules, simulateJourney } from "./simulate-player-journey.mjs";
import { lookaheadPolicy } from "./simulate-player-lookahead.mjs";

export const pearlResearchBudgets = [0, 100, 1000, 5000, 20000];

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const loaded = await loadJourneyRules();
  try {
    const results = pearlResearchBudgets.map(pearlBudget => simulateJourney(loaded, "visits3", 1600, { ...lookaheadPolicy, pearlBudget }));
    console.log(JSON.stringify({ assumption: "Hypothetical confirmed initial pearl balances; no earning/payment API, production speedup or market purchases", results }, null, 2));
  } finally { await loaded.close(); }
}
