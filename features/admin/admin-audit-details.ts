import { economyCatalog } from "@/features/economy/domain/model";
import { worldCatalog } from "@/features/world/domain/model";
import { GAME_ITEMS, GAME_ACHIEVEMENTS } from "@/features/game/game-rewards";

const labels: Record<string, string> = {
  revoke_sessions: "Завершение сеансов", grant_item: "Календарный предмет", grant_achievement: "Достижение",
  grant_resource: "Прежние ресурсы", grant_world_item: "Предмет мира", grant_find: "Находка",
  grant_economy: "Выдача игроку", adjust_economy: "Корректировка баланса", mail_broadcast: "Рассылка игрокам", promo_create: "Создание промокода", promo_update: "Изменение промокода",
  promo_delete: "Удаление промокода", set_tag: "Тег", ban: "Блокировка", unban: "Разблокировка",
  watch: "Наблюдение", unwatch: "Снятие наблюдения", clear_signal: "Сигнал проверен",
};
export const adminActionName = (action: string) => labels[action] ?? action;
const count = (value: number) => new Intl.NumberFormat("ru-RU").format(value);
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" ? value : "";
const number = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
const catalogName = (id: string) => [...economyCatalog.items, ...economyCatalog.buildings,
  ...(economyCatalog.fishing?.rods ?? []), ...(economyCatalog.fishing?.hooks ?? []),
  ...worldCatalog.items, ...worldCatalog.finds].find(item => item.id === id)?.name ?? id;

/** Audit payloads use visible currency units. Unknown historical shapes remain readable. */
export function adminActionDetails(details: string): string {
  try {
    const payload = record(JSON.parse(details));
    const value = payload.request ? record(payload.request) : payload;
    const delivery = value.delivery === "notify" ? " · Письмо и уведомление" : value.delivery === "silent" ? " · Тихо" : "";
    if ((value.kind === "item" || value.kind === "achievement") && text(value.rewardId)) {
      const reward = (value.kind === "item" ? GAME_ITEMS : GAME_ACHIEVEMENTS).find(item => item.id === value.rewardId);
      return `${value.kind === "item" ? "Календарный предмет" : "Достижение"}: ${reward?.title ?? text(value.rewardId)}${delivery}`;
    }
    if (value.coinsDelta !== undefined || value.pearlsDelta !== undefined) {
      const signed = (amount: unknown) => typeof amount === "number" && Number.isSafeInteger(amount) ? `${amount > 0 ? "+" : ""}${count(amount)}` : "?";
      return `Монеты: ${signed(value.coinsDelta)} · Жемчуг: ${signed(value.pearlsDelta)}${delivery}`;
    }
    if (value.audience === "all" || value.audience === "players") return `${text(value.title) || "Письмо"} · ${value.audience === "all" ? "всем доступным аккаунтам" : "выбранным игрокам"} · ${value.notify ? "почта и уведомление" : "только почта"}`;
    if (value.promoId) {
      const definition = record(value.definition);
      const code = text(definition.code) || text(value.promoId);
      return `${code}${definition.title ? ` · ${text(definition.title)}` : ""}${value.action === "delete" ? " · удалён" : definition.enabled === false ? " · выключен" : ""}`;
    }
    if (value.coins !== undefined || value.pearls !== undefined || value.items !== undefined || value.buildings !== undefined) {
      const result: string[] = [];
      if (number(value.coins)) result.push(`+${count(number(value.coins))} монет`);
      if (number(value.pearls)) result.push(`+${count(number(value.pearls))} жемчуга`);
      for (const [id, quantity] of Object.entries(record(value.items))) if (number(quantity)) result.push(`${catalogName(id)} × ${count(number(quantity))}`);
      for (const [id, level] of Object.entries(record(value.buildings))) if (number(level)) result.push(`${catalogName(id)} → ур. ${count(number(level))}`);
      for (const [id, slots] of Object.entries(record(value.productionSlots))) if (number(slots)) result.push(`${catalogName(id)} → ${count(number(slots))} мест`);
      for (const key of ["rods", "hooks"]) if (Array.isArray(value[key])) for (const id of value[key]) if (typeof id === "string") result.push(catalogName(id));
      return (result.join(" · ") || "Без новых начислений") + delivery;
    }
    if (value.action === "grant_resource") {
      const resources: Record<string, string> = { sparks: "Искры", wood: "Дерево", stone: "Камень" };
      return `${resources[text(value.target)] ?? text(value.target)}: +${count(number(value.amount))}`;
    }
    if (value.action === "set_tag") return value.tag ? `[${text(record(value.tag).text)}] · ${text(record(value.tag).color)}` : "Тег снят";
    if (value.target) return catalogName(text(value.target));
    return adminActionName(text(value.action)) || "Записано в журнал";
  } catch { return "Записано в журнал"; }
}
