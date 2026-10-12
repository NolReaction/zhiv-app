import { economyCatalog } from "@/features/economy/domain/model";
import { adminPromoDefinitionSchema, type AdminPromoDefinition, type AdminPromoEntry } from "./admin-promo-api";

export const promoStatusLabels = { active: "Действует", scheduled: "Запланирован", expired: "Истёк", disabled: "Выключен" } as const;
export type PromoStatus = keyof typeof promoStatusLabels;
export const promoItemName = (id: string) => economyCatalog.items.find(item => item.id === id)?.name ?? id;
export function promoStatus(definition: AdminPromoDefinition, serverTime: string): PromoStatus {
  if (!definition.enabled) return "disabled";
  if (definition.startsAt && Date.parse(serverTime) < Date.parse(definition.startsAt)) return "scheduled";
  if (definition.endsAt && Date.parse(serverTime) >= Date.parse(definition.endsAt)) return "expired";
  return "active";
}
const moscow = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", dateStyle: "medium", timeStyle: "short" });
export const promoTime = (instant: string | null, empty = "Без ограничения") => instant ? `${moscow.format(new Date(instant))} МСК` : empty;
/** datetime-local is deliberately Moscow time, regardless of the browser's timezone. */
export function toPromoLocalTime(instant: string | null): string {
  return instant ? new Date(Date.parse(instant) + 3 * 60 * 60 * 1000).toISOString().slice(0, 16) : "";
}
export function fromPromoLocalTime(value: string): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error("Укажите полную дату и время по Москве");
  const milliseconds = Date.parse(`${value}:00+03:00`);
  if (!Number.isFinite(milliseconds) || toPromoLocalTime(new Date(milliseconds).toISOString()) !== value)
    throw new Error("Проверьте дату и время");
  return new Date(milliseconds).toISOString();
}
export function promoPresetEnd(startsAt: string, serverTime: string, days: number): string {
  const start = fromPromoLocalTime(startsAt) ?? serverTime;
  return toPromoLocalTime(new Date(Date.parse(start) + days * 86_400_000).toISOString());
}
export type PromoDraft = { id: string; code: string; title: string; enabled: boolean; startsAt: string; endsAt: string;
  originalStartsAt?: string | null; originalEndsAt?: string | null;
  coins: string; pearls: string; items: { itemId: string; amount: string }[] };
export function promoDraft(entry: AdminPromoEntry | null, id: string, serverTime: string): PromoDraft {
  const value = entry?.definition;
  return { id: value?.id ?? id, code: value?.code ?? "", title: value?.title ?? "", enabled: value?.enabled ?? true,
    startsAt: toPromoLocalTime(value?.startsAt ?? null), endsAt: value ? toPromoLocalTime(value.endsAt) : promoPresetEnd("", serverTime, 7),
    originalStartsAt: value?.startsAt, originalEndsAt: value?.endsAt,
    coins: String(value?.reward.coins ?? 0), pearls: String(value?.reward.pearls ?? 0),
    items: Object.entries(value?.reward.items ?? {}).map(([itemId, amount]) => ({ itemId, amount: String(amount) })) };
}
function amount(value: string, label: string, maximum: number, minimum = 0) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum)
    throw new Error(`${label}: введите целое число от ${minimum} до ${maximum.toLocaleString("ru-RU")}`);
  return Number(value);
}
export function definitionFromPromoDraft(draft: PromoDraft): AdminPromoDefinition {
  if (new Set(draft.items.map(item => item.itemId)).size !== draft.items.length) throw new Error("Предмет добавлен дважды");
  const value = { id: draft.id, code: draft.code.trim().toUpperCase(), title: draft.title.trim(), enabled: draft.enabled,
    startsAt: draft.originalStartsAt !== undefined && toPromoLocalTime(draft.originalStartsAt) === draft.startsAt
      ? draft.originalStartsAt : fromPromoLocalTime(draft.startsAt),
    endsAt: draft.originalEndsAt !== undefined && toPromoLocalTime(draft.originalEndsAt) === draft.endsAt
      ? draft.originalEndsAt : fromPromoLocalTime(draft.endsAt),
    reward: { coins: amount(draft.coins, "Монеты", 1_000_000), pearls: amount(draft.pearls, "Жемчуг", 10_000),
      items: Object.fromEntries(draft.items.map(item => [item.itemId, amount(item.amount, promoItemName(item.itemId), 10_000, 1)])) } };
  if (!/^[A-Z0-9][A-Z0-9_-]{2,39}$/.test(value.code)) throw new Error("Код: 3–40 латинских букв, цифр, - или _");
  if (value.title.length < 1 || value.title.length > 80) throw new Error("Укажите название подарка: от 1 до 80 символов");
  const parsed = adminPromoDefinitionSchema.safeParse(value);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Проверьте состав подарка");
  return parsed.data;
}
