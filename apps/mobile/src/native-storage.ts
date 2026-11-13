import { Capacitor, registerPlugin } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { installClientPersistence, setClientReceiptStorage } from "@/lib/client-persistence";
import { createNativeSettingsStorage } from "./native-storage/settings";
import { createNativeRequestOutbox, type NativeOutboxPort, type OutboxRequest } from "./native-storage/outbox";

const database = registerPlugin<NativeOutboxPort>("MochlikStorage");
const settings = createNativeSettingsStorage(Preferences);
let outbox: ReturnType<typeof createNativeRequestOutbox> | undefined;
let activeOwner: string | undefined;
let initialized = false;

/** Called before importing/mounting shared game components, then before account changes. */
export async function initializeNativeStorage(userId?: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  await settings.hydrate();
  if (!outbox) outbox = createNativeRequestOutbox(database, window.localStorage);
  if (!initialized || activeOwner !== userId) {
    setClientReceiptStorage(undefined);
    await outbox.hydrate(userId);
    activeOwner = userId;
    initialized = true;
  }
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
