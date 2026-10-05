import { pathToFileURL } from "node:url";
import { readEconomyCatalog } from "./audit-economy-progression.mjs";
import { auditEconomicMath } from "./lib/economy-math.mjs";

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  console.log(JSON.stringify(auditEconomicMath(readEconomyCatalog()), null, 2));
}
