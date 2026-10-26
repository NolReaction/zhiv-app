import { economyCatalog, economyTradeRelationsSchema, type EconomyCatalog, type EconomyState, type EconomyTradeRelations,
  type EconomyWeeklyOrder, type TradeResidentId } from "./model";
import { obtainableResidentOrderItems } from "./order-effort";
import { orderDifficulty } from "./order-difficulty";

export type { TradeResidentId } from "./model";
export const TRADE_RESIDENT_IDS: readonly TradeResidentId[] = ["plesk", "builder", "lopukh", "kamneshmyg", "leaftail"];
type RelationSource = Partial<Pick<EconomyState, "tradeRelations">> & { catalog?: EconomyCatalog; serverTime?: string };
type Source = Pick<EconomyState, "buildings"> & Partial<Pick<EconomyState, "fishing" | "progression">> & RelationSource;
type Terms = EconomyWeeklyOrder["stages"][number];
const DAY_MS = 86_400_000;
const MAX_XP = 1_000_000;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const pairs = (value: Record<string, number>) => Object.entries(value).sort(([a], [b]) => compare(a, b));
/** UTF-16 FNV-1a; all canonical JSON inputs are mirrored by the API. */
export function tradeHash(value: string): number {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) result = Math.imul(result ^ value.charCodeAt(index), 0x01000193);
  return result >>> 0;
}
export function tradeOrderFingerprint(order: Terms): string {
  const input: unknown[] = [order.id, order.residentId, pairs(order.items), order.coins];
  if ([order.reputationXp, order.effortSeconds, order.manufacturingSeconds, order.fishingUncertain].some(value => value != null))
    input.push(order.reputationXp ?? 0, order.effortSeconds ?? 0, order.manufacturingSeconds ?? 0, Boolean(order.fishingUncertain));
  if ((order.pearls ?? 0) > 0) input.push(order.pearls);
  return String(tradeHash(JSON.stringify(input)));
}
export function tradeRelationsState(state: Partial<Pick<EconomyState, "tradeRelations">>): EconomyTradeRelations {
  return economyTradeRelationsSchema.parse(state.tradeRelations);
}
export function tradeResidentAvailable(state: Pick<EconomyState, "buildings">, residentId: TradeResidentId,
  catalog = (state as Source).catalog ?? economyCatalog): boolean {
  if (residentId === "lopukh") return (state.buildings.woodlot ?? 0) > 0;
  if (residentId === "kamneshmyg") return (state.buildings.quarry ?? 0) > 0;
  if (residentId === "leaftail") return (state.buildings.home ?? 1) >= (catalog.leaftailShop?.requiredHomeLevel ?? 3);
  return true;
}
function clock(state: RelationSource, now?: number) { return now ?? (state.serverTime ? Date.parse(state.serverTime) : Date.now()); }
/** Activity never changes permanent reputation. Its clock is evaluated from the
 * authoritative action/snapshot time, without a write during a preview. */
export function tradeActivityBps(state: RelationSource, residentId: TradeResidentId, catalog = state.catalog ?? economyCatalog, now?: number): number {
  const config = catalog.tradeRelations?.activity;
  if (!config) return 10000;
  const saved = tradeRelationsState(state).activity[residentId];
  if (!saved) return 0;
  const elapsed = Math.max(0, Math.floor((clock(state, now) - Date.parse(saved.updatedAt)) / 1000));
  const decay = Math.max(0, elapsed - config.graceSeconds);
  return Math.max(0, saved.pointsBps - Math.floor(10000 * Math.min(decay, config.decaySeconds) / config.decaySeconds));
}
/** One-time local-profile upgrade; SQL V78 anchors production profiles once.
 * New accounts already contain an empty activity map and receive no free favor. */
export function migrateTradeActivity(state: EconomyState, now: number) {
  if (state.tradeRelations?.activity !== undefined) return;
  const relations = tradeRelationsState(state);
  state.tradeRelations = { ...relations, activity: Object.fromEntries(Object.entries(relations.reputation)
    .filter(([, xp]) => xp > 0).map(([id]) => [id, { pointsBps: 10000, updatedAt: new Date(now).toISOString() }])) };
}
function refreshTradeActivity(relations: EconomyTradeRelations, residentId: TradeResidentId, now: number, catalog: EconomyCatalog) {
  const config = catalog.tradeRelations?.activity;
  if (!config) return;
  const saved = relations.activity[residentId];
  if (saved && now < Date.parse(saved.updatedAt)) return;
  const current = tradeActivityBps({ tradeRelations: relations }, residentId, catalog, now);
  relations.activity[residentId] = { pointsBps: Math.min(10000, current + config.recoveryBps), updatedAt: new Date(now).toISOString() };
}
export function tradeRelationProgress(state: RelationSource, residentId: TradeResidentId, catalog = state.catalog ?? economyCatalog, now?: number) {
  const config = catalog.tradeRelations, relations = tradeRelationsState(state), xp = relations.reputation[residentId] ?? 0;
  const ranks = config?.ranks ?? [{ id: "acquaintance", name: "Знакомый", requiredXp: 0, bonusBps: 0 }];
  let rankIndex = 0;
  for (let index = 1; index < ranks.length; index++) if (xp >= ranks[index].requiredXp) rankIndex = index;
  const rank = ranks[rankIndex], nextRank = ranks[rankIndex + 1] ?? null;
  const currentDay = relations.dailyCycle >= Math.floor(clock(state, now) / DAY_MS);
  const activityBps = tradeActivityBps(state, residentId, catalog, now), rankBonusBps = Math.min(config?.maxBonusBps ?? 0, rank.bonusBps);
  return { residentId, xp, rankIndex, rank, nextRank,
    activityBps, rankBonusBps, bonusBps: Math.floor(rankBonusBps * activityBps / 10000),
    progressXp: nextRank ? xp - rank.requiredXp : 0, requiredXp: nextRank ? nextRank.requiredXp - rank.requiredXp : 0,
    dailyOrderXpRemaining: Math.max(0, (config?.dailyOrderXpCap ?? 0) - (currentDay ? relations.dailyOrderXp[residentId] ?? 0 : 0)),
    dailyPurchaseXpRemaining: Math.max(0, (config?.dailyPurchaseXpCap ?? 0) - (currentDay ? relations.dailyPurchaseXp[residentId] ?? 0 : 0)) };
}
export function tradeRelationBonusBps(state: RelationSource, residentId: TradeResidentId, catalog = state.catalog ?? economyCatalog, now?: number): number {
  return tradeRelationProgress(state, residentId, catalog, now).bonusBps;
}
function scaledCeiling(value: number, numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(numerator) || numerator < 0
    || !Number.isSafeInteger(denominator) || denominator <= 0) throw new RangeError("Invalid trade duration");
  const answer = Math.floor(value / denominator) * numerator + Math.ceil(value % denominator * numerator / denominator);
  if (!Number.isSafeInteger(answer)) throw new RangeError("Trade duration exceeds safe range");
  return answer;
}
/** Applicable food and resident speed share one divisor, with one integer ceiling. */
export function tradeWorkDuration(state: RelationSource, seconds: number, residentId: TradeResidentId, foodBps = 0,
  catalog = state.catalog ?? economyCatalog, now?: number): number {
  if (!Number.isInteger(foodBps) || foodBps < 0 || foodBps > 10000) throw new RangeError("Invalid meal speed");
  return scaledCeiling(seconds, 10000, 10000 + foodBps + tradeRelationBonusBps(state, residentId, catalog, now));
}
/** Adding food to a saved job must retain the resident speed frozen at its start. */
export function tradeMealDuration(remaining: number, savedTradeBps: number, foodBps: number): number {
  if (!Number.isInteger(savedTradeBps) || savedTradeBps < 0 || savedTradeBps > 1000
    || !Number.isInteger(foodBps) || foodBps < 0 || foodBps > 10000) throw new RangeError("Invalid saved work bonus");
  return scaledCeiling(remaining, 10000 + savedTradeBps, 10000 + savedTradeBps + foodBps);
}
export function tradeDiscountedPrice(state: RelationSource, residentId: TradeResidentId, baseCoins: number,
  catalog = state.catalog ?? economyCatalog, now?: number): number {
  return scaledCeiling(baseCoins, 10000 - tradeRelationBonusBps(state, residentId, catalog, now), 10000);
}
function dailyRelations(state: EconomyState, now: number) {
  const current = tradeRelationsState(state), cycle = Math.floor(now / DAY_MS);
  return current.dailyCycle >= cycle ? current : { ...current, dailyCycle: cycle, dailyOrderXp: {}, dailyPurchaseXp: {} };
}
export function awardTradeOrderXp(state: EconomyState, residentId: TradeResidentId, amount: number, now: number,
  weekly = false, catalog = economyCatalog): number {
  const config = catalog.tradeRelations;
  if (!config || !Number.isSafeInteger(amount) || amount < 0) return 0;
  const relations = dailyRelations(state, now), before = relations.reputation[residentId] ?? 0;
  const awarded = Math.min(amount, MAX_XP - before, weekly ? amount : Math.max(0, config.dailyOrderXpCap - (relations.dailyOrderXp[residentId] ?? 0)));
  refreshTradeActivity(relations, residentId, now, catalog);
  relations.reputation[residentId] = before + awarded;
  if (!weekly) relations.dailyOrderXp[residentId] = (relations.dailyOrderXp[residentId] ?? 0) + awarded;
  state.tradeRelations = relations;
  return awarded;
}
/** Consumable bait is never friendship progress. Other resellable goods must
 * cost more than their entire NPC resale value, including old frozen quotes. */
export function tradePurchaseXpEligible(kind: string, paid: number, resaleCoins = 0): boolean {
  return kind !== "bait" && paid > 0 && paid > resaleCoins;
}
export function awardTradePurchaseXp(state: EconomyState, residentId: TradeResidentId, now: number, catalog = economyCatalog): number {
  const config = catalog.tradeRelations;
  if (!config) return 0;
  const relations = dailyRelations(state, now), before = relations.reputation[residentId] ?? 0;
  const awarded = Math.min(config.purchaseXp, MAX_XP - before, Math.max(0, config.dailyPurchaseXpCap - (relations.dailyPurchaseXp[residentId] ?? 0)));
  if (!awarded) return 0;
  relations.reputation[residentId] = before + awarded;
  relations.dailyPurchaseXp[residentId] = (relations.dailyPurchaseXp[residentId] ?? 0) + awarded;
  state.tradeRelations = relations;
  return awarded;
}
export type WeeklyOrderCandidate = { id: string; templateId: string; residentId: TradeResidentId; name: string; description: string;
  stages: Terms[]; coins: number; pearls: number; reputationXp: number; effortSeconds: number; manufacturingSeconds: number; fishingUncertain: boolean };
export type WeeklyOrderOffer = { id: string; slot: number; templateId: string; residentId: TradeResidentId; name: string; description?: string;
  items: Record<string, number>; coins: number; pearls?: number; availableAt: string; reputationXp?: number; effortSeconds?: number;
  manufacturingSeconds?: number; fishingUncertain?: boolean; requiredBuildings?: Record<string, number> | null;
  weekly: true; stage: number; stages: number; expiresAt: string };
function weeklyCandidate(template: NonNullable<EconomyCatalog["tradeRelations"]>["weekly"]["templates"][number]): WeeklyOrderCandidate {
  const input = [template.id, template.residentId, template.requiredHomeLevel, pairs(template.requiredBuildings),
    template.stages.map(stage => [stage.id, pairs(stage.items), stage.coins, stage.reputationXp, stage.effortSeconds, stage.manufacturingSeconds, stage.fishingUncertain, ...((stage.pearls ?? 0) > 0 ? [stage.pearls] : [])])];
  const stages = template.stages.map(stage => ({ ...stage, residentId: template.residentId, items: { ...stage.items },
    requiredBuildings: { home: template.requiredHomeLevel, ...template.requiredBuildings } }));
  return { id: `weekly_choice1_${template.id}_${tradeHash(JSON.stringify(input))}`, templateId: template.id,
    residentId: template.residentId, name: template.name, description: template.description, stages,
    coins: stages.reduce((sum, stage) => sum + stage.coins, 0), pearls: stages.reduce((sum, stage) => sum + (stage.pearls ?? 0), 0), reputationXp: stages.reduce((sum, stage) => sum + stage.reputationXp, 0),
    effortSeconds: stages.reduce((sum, stage) => sum + stage.effortSeconds, 0),
    manufacturingSeconds: stages.reduce((sum, stage) => sum + stage.manufacturingSeconds, 0), fishingUncertain: stages.some(stage => stage.fishingUncertain) };
}
export function weeklyOrderBoard(state: Source, now: number, catalog = state.catalog ?? economyCatalog): {
  offers: WeeklyOrderCandidate[]; active: WeeklyOrderOffer | null; progress: EconomyWeeklyOrder | null; availableAt: string | null; canChoose: boolean;
} {
  const config = catalog.tradeRelations, relations = tradeRelationsState(state), weekly = relations.weekly;
  const progress = weekly && now < Date.parse(weekly.expiresAt) ? weekly : null;
  const terms = progress?.stages[progress.stage];
  const active: WeeklyOrderOffer | null = progress && terms ? { ...terms,
    id: `${progress.id}_${progress.stage}_${tradeOrderFingerprint(terms)}`, slot: -1, templateId: terms.id,
    description: terms.description ?? undefined, availableAt: progress.acceptedAt, weekly: true, stage: progress.stage, stages: progress.stages.length, expiresAt: progress.expiresAt } : null;
  const availableAt = relations.weeklyAvailableAt, canChoose = Boolean(config) && !active && (!availableAt || now >= Date.parse(availableAt));
  if (!config || !canChoose) return { offers: [], active, progress, availableAt, canChoose };
  const reachable = obtainableResidentOrderItems(state, catalog);
  const templates = config.weekly.templates.filter(template => tradeResidentAvailable(state, template.residentId, catalog)
    && (state.buildings.home ?? 1) >= template.requiredHomeLevel
    && Object.entries(template.requiredBuildings).every(([id, level]) => (state.buildings[id] ?? 0) >= level)
    && template.stages.every(stage => Object.keys(stage.items).every(id => reachable.has(id))));
  const cycle = Math.floor(now / (config.weekly.durationSeconds * 1000));
  const offers = TRADE_RESIDENT_IDS.flatMap(residentId => ["ordinary", "challenging", "masterful"].flatMap(difficulty => {
    const choices = templates.filter(template => template.residentId === residentId
      && orderDifficulty(template.stages.reduce((sum, stage) => sum + stage.effortSeconds, 0), true) === difficulty)
      .sort((a, b) => compare(a.id, b.id));
    const selected = choices[tradeHash(`weekly1:${cycle}:${residentId}:${difficulty}`) % choices.length];
    return selected ? [weeklyCandidate(selected)] : [];
  }));
  return { offers, active, progress, availableAt, canChoose };
}
export function acceptWeeklyOrder(state: EconomyState, candidate: WeeklyOrderCandidate, now: number, catalog = economyCatalog) {
  const config = catalog.tradeRelations;
  if (!config) throw new RangeError("Weekly orders unavailable");
  const relations = tradeRelationsState(state), acceptedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + config.weekly.durationSeconds * 1000).toISOString();
  state.tradeRelations = { ...relations, weeklyAvailableAt: expiresAt, weekly: {
    id: `weekly1_${Math.floor(now / 1000)}_${tradeHash(candidate.id)}`, templateId: candidate.templateId,
    residentId: candidate.residentId, name: candidate.name, description: candidate.description,
    stages: candidate.stages.map(stage => ({ ...stage, items: { ...stage.items }, requiredBuildings: { ...stage.requiredBuildings } })),
    stage: 0, acceptedAt, expiresAt } };
}
