import { economyCatalog } from "@/features/economy/model";
import { formatPearls } from "@/features/economy/money";
import { worldCatalog } from "@/features/world/model";

export const analyticsActions: Record<string, string> = {
  start_production: "Начало производства", buy_production_slot: "Место производства", start_collection: "Начало сбора",
  start_exploration: "Начало вылазки", cancel_exploration: "Отмена вылазки", start_construction: "Начало стройки",
  speedup_construction: "Ускорение стройки", claim_job: "Получение результата", sell: "Продажа припасов",
  buy_fishing_item: "Покупка снастей", buy_wardrobe_item: "Покупка одежды", sell_fish: "Продажа рыбы",
  equip_fishing_rod: "Выбор удочки", equip_fishing_bait: "Выбор наживки", equip_fishing_hook: "Выбор крючка",
  refresh_fishing_shop: "Обновление лавки Плёски", start_fishing: "Начало рыбалки",
  market_create: "Выставление на рынок", market_buy: "Покупка на рынке", market_sell: "Продажа на рынке",
  market_cancel: "Возврат с рынка", daily_reward: "Подарок за вход", achievement_reward: "Награда за достижение",
  barter_create: "Предложение обмена", barter_accept: "Получение по обмену", barter_exchange: "Завершение обмена", barter_cancel: "Возврат реликвии",
};
export const analyticsCategory = { gameplay: "Игра", trade: "Торговля", escrow: "Резерв / возврат" };
const formatter = new Intl.NumberFormat("ru-RU");
export const analyticsCount = (value: number) => formatter.format(value);
export const analyticsAction = (id: string) => analyticsActions[id] ?? `Операция ${id}`;
export const analyticsResources = [{ id: "coins", name: "Монеты" }, { id: "pearls", name: "Жемчуг" }, ...economyCatalog.items];
export function analyticsResource(id: string) { return analyticsResources.find(item => item.id === id)?.name ?? `Ресурс ${id}`; }
export function analyticsTarget(id: string | null) {
  if (!id) return "Объект не записан";
  if (id === "fishing_shop") return "Лавка Плёски";
  return [...economyCatalog.buildings, ...economyCatalog.recipes, ...economyCatalog.explorations, ...economyCatalog.items,
    ...(economyCatalog.fishing?.rods ?? []), ...(economyCatalog.fishing?.hooks ?? []), ...worldCatalog.items].find(item => item.id === id)?.name ?? id;
}
export function analyticsAmount(resourceId: string, value: number, signed = false) {
  return resourceId === "pearls" ? formatPearls(value, { signDisplay: signed ? "exceptZero" : "auto" })
    : `${signed && value > 0 ? "+" : ""}${analyticsCount(value)}`;
}
export function analyticsDate(value: string) {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", day: "numeric", month: "short" }).format(new Date(`${value}T00:00:00Z`));
}
export function analyticsPeriod(days: number, now = new Date()) {
  const to = now.toISOString().slice(0, 10), start = new Date(`${to}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { from: start.toISOString().slice(0, 10), to };
}
export function analyticsPeriodError(from: string, to: string, now = new Date()) {
  const valid = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date))
    && new Date(date).toISOString().slice(0, 10) === date;
  if (!valid(from) || !valid(to)) return "Укажите обе даты.";
  if (from > to) return "Начало периода должно быть не позже его конца.";
  if (to > now.toISOString().slice(0, 10)) return "Конец периода не может быть в будущем по UTC.";
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 >= 366) return "Выберите период не длиннее 366 дней.";
  return null;
}
/** User names and unknown catalog IDs are untrusted spreadsheet cells. */
export function analyticsCsv(rows: readonly (readonly (string | number | null)[])[]) {
  return "\uFEFF" + rows.map(row => row.map(value => {
    const raw = String(value ?? "");
    const safe = typeof value === "string" && /^[\s\u0000-\u001f]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
    return `"${safe.replaceAll('"', '""')}"`;
  }).join(";")).join("\r\n");
}
export function downloadAnalyticsCsv(filename: string, rows: readonly (readonly (string | number | null)[])[]) {
  const url = URL.createObjectURL(new Blob([analyticsCsv(rows)], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
}
