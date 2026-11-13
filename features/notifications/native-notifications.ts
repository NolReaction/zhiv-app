import type { EconomyView } from "@/features/economy/domain/model";
import type { NotificationSnapshot } from "./notification-contract";
import { planNativeGameReminders, type LocalGameReminder } from "./native-notification-plan";

export const NATIVE_NOTIFICATION_PREFERENCE_KEY = "mochlik.local-reminders.v1";
export type NativeReminderPermission = "default" | "granted" | "denied";
type PendingReminder = { id: number; extra?: { source?: string } };
export type NativeReminderPort = {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  checkPermission(): Promise<NativeReminderPermission>;
  requestPermission(): Promise<NativeReminderPermission>;
  pending(): Promise<PendingReminder[]>;
  cancel(ids: number[]): Promise<void>;
  clearDelivered(): Promise<void>;
  schedule(reminders: LocalGameReminder[]): Promise<void>;
  now(): number;
};

export function createNativeNotifications(port: NativeReminderPort) {
  let owner: string | null = null, enabledOwner: string | null = null, generation = 0;
  let snapshot: NotificationSnapshot | null = null;
  let game: Pick<EconomyView, "ownerPublicId" | "jobs"> | null = null;
  let serverOffset = 0, lastSignature = "", error = "";
  let ledgerOwner: string | null = null, scheduled: number[] = [], history: number[] = [];
  let queue: Promise<unknown> = Promise.resolve(), hydrated: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const changed = () => { for (const listener of listeners) listener(); };
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const pending = queue.then(run, run);
    queue = pending.catch(() => undefined);
    return pending;
  }
  function hydrate() {
    return hydrated ??= port.read().then(value => {
      try {
        const parsed: unknown = JSON.parse(value ?? "null");
        if (parsed && typeof parsed === "object") {
          if ("owner" in parsed && typeof parsed.owner === "string" && /^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){2}$/.test(parsed.owner)) enabledOwner = parsed.owner;
          if ("ledgerOwner" in parsed && typeof parsed.ledgerOwner === "string") ledgerOwner = parsed.ledgerOwner;
          const times = (value: unknown): number[] => Array.isArray(value) ? value.filter((at): at is number => typeof at === "number" && Number.isFinite(at)).slice(-128) : [];
          if ("scheduled" in parsed) scheduled = times(parsed.scheduled);
          if ("history" in parsed) history = times(parsed.history);
        }
      } catch { /* Invalid local consent is disabled. */ }
    }).catch(() => {
      enabledOwner = null;
      error = "Не удалось прочитать настройки напоминаний. Подключите их повторно в настройках приложения.";
      changed();
    });
  }
  function advanceLedger() {
    const now = port.now();
    // Assume a due system notification was delivered even if the user dismissed it while the app was closed.
    history = [...history, ...scheduled.filter(at => at <= now)].filter(at => at > now - 7 * 86400_000).slice(-128);
    scheduled = scheduled.filter(at => at > now);
  }
  function persist() { return port.write(JSON.stringify({ owner: enabledOwner, ledgerOwner, scheduled, history })); }
  async function clearPending() {
    const pending = (await port.pending()).filter(item => item.extra?.source === "mochlik-game");
    if (pending.length) await port.cancel(pending.map(item => item.id));
    lastSignature = "";
  }
  async function reconcileCurrent(expectedGeneration: number) {
    if (expectedGeneration !== generation) return;
    const current = () => expectedGeneration === generation;
    const permission = await port.checkPermission();
    if (!current()) return;
    const now = port.now();
    advanceLedger();
    // A cold offline launch must not erase still-valid system reminders before fresh game data arrives.
    if (owner && owner === enabledOwner && permission === "granted" && (!snapshot || !game)) return;
    const reminders = owner && owner === enabledOwner && snapshot?.ownerPublicId === owner && game?.ownerPublicId === owner && permission === "granted"
      ? planNativeGameReminders(game, snapshot.preferences, now + serverOffset, now, history) : [];
    const signature = JSON.stringify(reminders);
    if (lastSignature === signature) return;
    await clearPending();
    if (!current()) return;
    scheduled = reminders.map(reminder => reminder.at);
    ledgerOwner = owner;
    await persist();
    if (!current()) return;
    if (reminders.length) {
      await port.schedule(reminders);
      if (!current()) { await clearPending(); return; }
    }
    lastSignature = signature; error = ""; changed();
  }
  function reconcile() {
    const expectedGeneration = generation;
    return serial(async () => {
      await hydrate();
      try { await reconcileCurrent(expectedGeneration); }
      catch (cause) { error = "Не удалось обновить напоминания на телефоне. Повторите подключение в настройках."; changed(); throw cause; }
    });
  }
  return {
    hydrate,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getError: () => error,
    async setOwner(next: string | null) {
      if (next === owner) return;
      owner = next; generation++; snapshot = null; game = null;
      const expectedGeneration = generation;
      await serial(async () => {
        await hydrate();
        if (expectedGeneration !== generation) return;
        const restoredOwner = enabledOwner === owner && ledgerOwner === owner;
        if (!restoredOwner) await clearPending();
        await port.clearDelivered();
        if (expectedGeneration !== generation) return;
        advanceLedger();
        if (!restoredOwner) scheduled = [];
        if (ledgerOwner !== owner) { ledgerOwner = owner; history = []; }
        if (enabledOwner !== owner) enabledOwner = null;
        await persist();
        changed();
      });
    },
    async status(expectedOwner: string) {
      await hydrate();
      const permission = await port.checkPermission();
      return { permission, enabled: expectedOwner === owner && expectedOwner === enabledOwner, error };
    },
    async enable(expectedOwner: string) {
      // The OS permission request belongs to the user's button gesture, before queued I/O.
      const expectedGeneration = generation;
      const permission = await port.requestPermission();
      if (permission !== "granted") throw new Error("Разрешите уведомления в настройках приложения на телефоне.");
      await serial(async () => {
        await hydrate();
        if (expectedOwner !== owner || expectedGeneration !== generation) throw new Error("Профиль изменился. Откройте настройки заново.");
        const previousOwner = enabledOwner;
        enabledOwner = expectedOwner;
        try { await persist(); }
        catch (cause) { enabledOwner = previousOwner; throw cause; }
        if (expectedGeneration !== generation) return;
        changed();
        await reconcileCurrent(expectedGeneration);
      });
    },
    async disable(expectedOwner: string) {
      if (owner !== expectedOwner) throw new Error("Профиль изменился. Откройте настройки заново.");
      enabledOwner = null; generation++; changed();
      await serial(async () => { await hydrate(); enabledOwner = null; advanceLedger(); scheduled = []; await clearPending(); await port.clearDelivered(); await persist(); });
    },
    setPreferences(value: NotificationSnapshot) {
      if (value.ownerPublicId !== owner) return Promise.resolve();
      snapshot = value; return reconcile();
    },
    setGame(expectedOwner: string, value: Pick<EconomyView, "ownerPublicId" | "jobs">, serverNow: number) {
      if (expectedOwner !== owner || value.ownerPublicId !== owner || !Number.isFinite(serverNow)) return Promise.resolve();
      game = value; serverOffset = serverNow - port.now(); return reconcile();
    },
    reconcile,
    // Called by native logout/401, including a cold start with no valid session.
    reset() {
      owner = null; generation++; game = null; snapshot = null; enabledOwner = null;
      return serial(async () => { await hydrate(); enabledOwner = null; scheduled = []; history = []; ledgerOwner = null; await clearPending(); await port.clearDelivered(); await persist(); changed(); });
    },
  };
}
export type NativeNotifications = ReturnType<typeof createNativeNotifications>;
let installed: NativeNotifications | null = null;
export function configureNativeNotifications(value: NativeNotifications | null) { installed = value; }
export function getNativeNotifications() { return installed; }
let pendingLink: { ownerPublicId: string; target: LocalGameReminder["extra"]["target"] } | null = null;
export function queueNativeNotificationLink(value: unknown) {
  if (!value || typeof value !== "object" || !("source" in value) || value.source !== "mochlik-game"
    || !("ownerPublicId" in value) || typeof value.ownerPublicId !== "string" || value.ownerPublicId.length > 40
    || !("target" in value) || !["activities", "mine", "production", "construction"].includes(String(value.target))) return;
  pendingLink = { ownerPublicId: value.ownerPublicId, target: value.target as LocalGameReminder["extra"]["target"] };
  if (typeof window !== "undefined") window.dispatchEvent(new Event("mochlik:notification-open"));
}
export function takeNativeNotificationLink() { const value = pendingLink; pendingLink = null; return value; }
