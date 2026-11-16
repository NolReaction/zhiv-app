import { Capacitor, registerPlugin } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { installClientPersistence, setClientReceiptStorage } from "@/lib/client-persistence";
import { installClientJournalStorage } from "@/lib/client-journal-storage";
import { createNativeSettingsStorage } from "./native-storage/settings";
import { createNativeRequestOutbox, type NativeOutboxPort, type OutboxRequest } from "./native-storage/outbox";
import { createNativeJournalStorage, type NativeJournalPort } from "./native-storage/journals";

const database = registerPlugin<NativeOutboxPort & NativeJournalPort>("MochlikStorage");
const settings = createNativeSettingsStorage(Preferences);
const journals = createNativeJournalStorage(database);
let outbox: ReturnType<typeof createNativeRequestOutbox> | undefined;
let activeOwner: string | undefined;
let initialized = false;

/** Called before importing/mounting shared game components, then before account changes. */
export async function initializeNativeStorage(userId?: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  if (!outbox) outbox = createNativeRequestOutbox(database, window.localStorage);
  setClientReceiptStorage(undefined);
  initialized = false;
  activeOwner = undefined;
  // Invalidate ports even when a new session belongs to the same account.
  const restoredJournals = journals.hydrate(userId);
  installClientJournalStorage(owner => journals.forOwner(owner));
  await Promise.all([settings.hydrate(), outbox.hydrate(userId), restoredJournals]);
  activeOwner = userId;
  initialized = true;
  installClientPersistence({ settings: settings.storage, receipts: outbox.receipts });
}
export async function prepareNativeRequest(request: OutboxRequest) {
  if (!Capacitor.isNativePlatform()) return { settle: async () => {} };
  if (!outbox || !initialized || request.userId !== activeOwner) throw new Error("Хранилище аккаунта ещё не готово");
  return outbox.prepare(request);
}
export const flushNativeSettings = settings.flush;
export const getNativeSettingsStatus = settings.getSnapshot;
export const subscribeNativeSettings = settings.subscribe;
