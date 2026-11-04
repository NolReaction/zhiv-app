import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { analyzeProposal } from "./lib/active-fishing-proposal.mjs";

const root = new URL("../", import.meta.url);
const hash = text => createHash("sha256").update(text).digest("hex");

function markdownSnapshot(report, config) {
  const lines = [
    "Снимок расчётного кандидата; длительности и успешность — допущения. Монеты после расхода наживки, по текущим гарантированным ценам продажи рыбы. Водоросли и будущие чертежи оценены в 0 монет.", "",
    "| Набор | Рыб/ч: новичок | Освоивший | Опытный | Монет за 15 мин: освоивший | Заполнить ящик: освоивший |",
    "|---|---:|---:|---:|---:|---:|",
  ];
  for (const scenario of config.scenarios) {
    const rows = report.forecasts.filter(row => row.scenarioId === scenario.id);
    const get = id => rows.find(row => row.profileId === id);
    const regular = get("regular");
    lines.push(`| ${scenario.name} | ${get("novice").fishPerHour.toFixed(1)} | ${regular.fishPerHour.toFixed(1)} | ${get("expert").fishPerHour.toFixed(1)} | ${(regular.netCoinsPerHour / 4).toFixed(0)} | ${(regular.secondsToFillCrate / 60).toFixed(1)} мин |`);
  }
  const maximum = report.selectiveCancelStress.reduce((best, row) => row.bestNetCoinsPolicy.netCoinsPerHour > best.bestNetCoinsPolicy.netCoinsPerHour ? row : best);
  lines.push("", `Максимум отдельного теоретического стресса быстрых идеальных вываживаний и селективных мгновенных отмен: **${maximum.bestNetCoinsPolicy.netCoinsPerHour.toFixed(0)} монет/ч**. Это допущение о заранее известном классе и нулевой цене отмены во времени, а не измеренный предел реальной игры.`, "",
    "Повышенная доступность обычной рыбы — осознанная гипотеза активного режима. Этот отчёт не доказывает сохранение полного календарного срока развития; питание, заказы и будущие находки требуют отдельного общего прогона.");
  return lines.join("\n");
}
export async function runActiveFishingProposal({ write = false } = {}) {
  const configPath = "docs/game/data/active-fishing-balance-v1.json";
  const catalogPath = "apps/api/src/main/resources/world/economy-catalog.json";
  const modelPath = "scripts/lib/active-fishing-proposal.mjs";
  const [configText, catalogText, modelText] = await Promise.all([readFile(new URL(configPath, root), "utf8"),
    readFile(new URL(catalogPath, root), "utf8"), readFile(new URL(modelPath, root), "utf8")]);
  const config = JSON.parse(configText);
  const report = { ...analyzeProposal(config, JSON.parse(catalogText)), sources: {
    config: { path: configPath, sha256: hash(configText) }, catalog: { path: catalogPath, sha256: hash(catalogText) },
    model: { path: modelPath, sha256: hash(modelText) },
  } };
  const rounded = JSON.parse(JSON.stringify(report, (_key, value) => typeof value === "number" ? Number(value.toFixed(8)) : value));
  if (write) {
    const documentPath = new URL("docs/game/active-fishing-proposal.md", root);
    const document = await readFile(documentPath, "utf8");
    const pattern = /<!-- ACTIVE_FISHING_SUMMARY_START -->[\s\S]*?<!-- ACTIVE_FISHING_SUMMARY_END -->/;
    if (!pattern.test(document)) throw new Error("The proposal Markdown summary markers are missing.");
    const summary = `<!-- ACTIVE_FISHING_SUMMARY_START -->\n${markdownSnapshot(rounded, config)}\n<!-- ACTIVE_FISHING_SUMMARY_END -->`;
    await writeFile(new URL("docs/game/data/active-fishing-balance-report.json", root), JSON.stringify(rounded, null, 2) + "\n");
    await writeFile(documentPath, document.replace(pattern, () => summary));
  }
  return rounded;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--write")) throw new Error("Usage: node scripts/analyze-active-fishing.mjs [--write]");
  const report = await runActiveFishingProposal({ write: args.includes("--write") });
  console.log("OFFLINE PROPOSAL; human success/timing are assumptions, not measured runtime or a full-economy guarantee.");
  console.table(report.forecasts.map(row => ({ scenario: row.scenarioId, profile: row.profileId,
    fishPerHour: row.fishPerHour.toFixed(2), coinsPerHour: row.netCoinsPerHour.toFixed(2),
    attemptSeconds: row.averageSecondsPerAttempt.toFixed(2), futureRecipeEquivalentSteadyMinutes:
      row.futureBlueprintForecast.steadyStateActiveMinutesPerBlueprintEquivalent?.toFixed(1) ?? "disabled" })));
  console.table(report.fastPerfectStress.map(row => ({ fastPerfect: row.scenarioId, fishPerHour: row.fishPerHour.toFixed(2), coinsPerHour: row.netCoinsPerHour.toFixed(2) })));
  console.log("THEORETICAL OMNISCIENT INSTANT-CANCEL BOUND; no observed live exploit is asserted.");
  console.table(report.selectiveCancelStress.map(row => ({ cancelStress: row.scenarioId,
    allFishCoinsPerHour: row.allFishSkipNonFish.netCoinsPerHour.toFixed(2),
    bestCoinsPerHour: row.bestNetCoinsPolicy.netCoinsPerHour.toFixed(2),
    acceptOnly: row.bestNetCoinsPolicy.policy.acceptOnlyRarities.join(","), policies: row.evaluatedPolicyCount,
    classFishPerHour: Object.entries(row.bestNetCoinsPolicy.classFishPerHour).filter(([, rate]) => rate > 0)
      .map(([rarity, rate]) => `${rarity}:${rate.toFixed(2)}`).join(",") })));
  console.table(report.legacyLandingNetForecast.map(row => ({ legacyNet: row.scenarioId, profile: row.profileId,
    fishPerHour: row.fishPerHour.toFixed(2), coinsPerHour: row.netCoinsPerHour.toFixed(2), bonusBps: row.assumedSuccessBonusBps })));
}
