import { pathToFileURL } from "node:url";
import { loadJourneyRules, simulateJourney } from "./simulate-player-journey.mjs";
import { lookaheadPolicy } from "./simulate-player-lookahead.mjs";

export const jointPlanningPolicy = Object.freeze({ ...lookaheadPolicy, jointBatchPlanning: true });

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const loaded = await loadJourneyRules();
  try { console.log(JSON.stringify([simulateJourney(loaded, "visits3", 1600, jointPlanningPolicy)], null, 2)); }
  finally { await loaded.close(); }
}
