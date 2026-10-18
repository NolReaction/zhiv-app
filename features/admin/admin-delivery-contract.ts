import { z } from "zod";
import { hasUserTextControls } from "@/lib/user-text";

export const playerMessageSchema = z.object({
  title: z.string().trim().min(1).refine(value => Array.from(value).length <= 120 && !hasUserTextControls(value)),
  body: z.string().trim().min(1).refine(value => Array.from(value).length <= 2000 && !hasUserTextControls(value, true)),
}).strict();
export type AdminDelivery = "silent" | "notify";
export type AdminPlayerMessage = z.infer<typeof playerMessageSchema>;
export type DeliveryOptions = { delivery?: AdminDelivery; playerMessage?: AdminPlayerMessage };

export function deliveryMessage(delivery: AdminDelivery, title: string, body: string): AdminPlayerMessage | undefined {
  if (delivery === "silent" || (!title.trim() && !body.trim())) return undefined;
  return { title: title.trim(), body: body.trim().replace(/\r\n?/g, "\n") };
}
export function deliveryIssue(delivery: AdminDelivery, title: string, body: string): string | null {
  const message = deliveryMessage(delivery, title, body);
  return message && !playerMessageSchema.safeParse(message).success
    ? "Для письма нужны заголовок до 120 и текст до 2000 символов, без скрытых управляющих знаков." : null;
}
