import type { MailMessage } from "@/features/mailbox/model";

type MailState = Map<string, Map<string, MailMessage>>;
const globalMail = globalThis as typeof globalThis & { zhivDevMail?: MailState };
export function devMailMessages(owner: string) {
  const state = globalMail.zhivDevMail ??= new Map();
  let messages = state.get(owner);
  if (!messages) { messages = new Map(); state.set(owner, messages); }
  return messages;
}
export function resetDevMailState() { delete globalMail.zhivDevMail; }
