import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { analyzeProposal } from "./lib/active-fishing-proposal.mjs";

const root = new URL("../", import.meta.url);
const hash = text => createHash("sha256").update(text).digest("hex");

function markdownSnapshot(report, config) {
  const lines = [
    "Расчёт конечного выезда: останавливаемся при полном ящике или исчерпании забросов. Серия нефишовых исходов переносится между выездами; ниже средние установившегося потока, первый выезд из нулевой серии рассчитан отдельно в JSON. Успешность и длительности — гипотезы о навыке, не замеры и не скрытая случайная потеря после победы.", "",
    "| Набор | Рыб/выезд: новичок | Освоивший | Опытный | Монет/выезд: освоивший | Активных минут/выезд |",
    "|---|---:|---:|---:|---:|---:|",
  ];
  for (const scenario of config.scenarios) {
    const rows = report.forecasts.filter(row => row.scenarioId === scenario.id);
    const get = id => rows.find(row => row.profileId === id).finiteTrip.stationaryTrip;
    const regular = get("regular");
    lines.push(`| ${scenario.name} | ${get("novice").expectedFish.toFixed(2)} | ${regular.expectedFish.toFixed(2)} | ${get("expert").expectedFish.toFixed(2)} | ${regular.expectedNetCoins.toFixed(1)} | ${(regular.expectedActiveSeconds / 60).toFixed(1)} |`);
  }
  lines.push("", "Монеты — при продаже всего улова по обычным текущим ценам, после расхода наживки на каждый начатый заброс. Находки оценены в 0 монет. Топливо не продаётся за монеты в этом кандидате.", "",
    "| Набор | Рыб/день при 1 / 2 / 3 заходах | Из них обычных при 1 / 2 / 3 заходах | Активных минут/день при 3 заходах |", "|---|---:|---:|---:|");
  for (const scenario of config.scenarios) {
    const finite = report.forecasts.find(row => row.scenarioId === scenario.id && row.profileId === "regular").finiteTrip;
    const visits = finite.dailyVisitSchedules;
    lines.push(`| ${scenario.name} | ${visits.map(row => row.expectedFishPerDay.toFixed(1)).join(" / ")} | ${visits.map(row => row.expectedCommonFishPerDay.toFixed(1)).join(" / ")} | ${visits[2].requiredActiveMinutesPerDay.toFixed(1)} |`);
  }
  lines.push("", "Заходы равномерно распределены по суткам, в каждый расходуется весь доступный запас; времени на мини-игры хватает. Короткое восстановление во время самой сессии для этой таблицы не прибавлено. Число заходов не является ограничением игры, это сценарии присутствия.", "",
    "Запас бака 2/3/4 выезда; один выезд восстанавливается за 120 минут на любой ступени. Долгосрочный максимум при достаточной частоте заходов — 12 выездов в сутки, или не более 36/60/96 рыб при ящике 3/5/8. Это потолок вместимости, не обещание улова и не ежедневная выдача топлива. Начальный полный бак не добавляется к каждому следующему дню.", "",
    "Прежние неограниченные показатели рыб/активный час и стресс мгновенных отмен оставлены в JSON только как диагностика темпа. Для бюджета важны конечные выезды, расход топлива, обычная рыба для кухни и заданий. Отдельный стресс перебора классов тоже ограничен числом забросов и не возвращает топливо. Полный срок развития этим отчётом не подтверждён.");
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
  console.log("OFFLINE FUEL-BOUNDED PROPOSAL; human success/timing are assumptions, not measured gameplay or full-economy validation.");
  console.table(report.forecasts.map(row => ({ scenario: row.scenarioId, profile: row.profileId,
    fishPerTrip: row.finiteTrip.stationaryTrip.expectedFish.toFixed(2), coinsPerTrip: row.finiteTrip.stationaryTrip.expectedNetCoins.toFixed(2),
    activeMinutesPerTrip: (row.finiteTrip.stationaryTrip.expectedActiveSeconds / 60).toFixed(2),
    dryTripPercent: (row.finiteTrip.stationaryTrip.emptyTripProbability * 100).toFixed(4),
    fishPerDayOneVisit: row.finiteTrip.dailyVisitSchedules[0].expectedFishPerDay.toFixed(2),
    fishPerDayThreeVisits: row.finiteTrip.dailyVisitSchedules[2].expectedFishPerDay.toFixed(2) })));
  console.log("THEORETICAL OMNISCIENT CANCEL STRESS; cast allowance, bait and outing fuel still consumed. Not an observed exploit.");
  console.table(report.fuelBoundedSelectiveCancelStress.map(row => ({ scenario: row.scenarioId,
    bestNetCoinsPerTrip: row.bestNetCoinsPerFuelPolicy.stationaryTrip.expectedNetCoins.toFixed(2),
    acceptOnly: row.bestNetCoinsPerFuelPolicy.acceptOnlyRarities.join(","), policies: row.evaluatedPolicyCount })));
}
