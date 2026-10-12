import { getDevIdentity } from "./api-store";
import { defaultNotificationPreferences, type NotificationPreferences, type NotificationSnapshot } from "@/features/notifications/notification-contract";

type Store = Map<string, NotificationPreferences>;
const globalNotifications = globalThis as typeof globalThis & { zhivDevNotificationPreferences?: Store };
function store(): Store { return globalNotifications.zhivDevNotificationPreferences ??= new Map(); }
export function resetDevNotificationsForTests() { store().clear(); }
export type DevNotificationResult = { kind: "ok"; value: NotificationSnapshot } | { kind: "unauthorized" } | { kind: "owner-mismatch" };
export function getDevNotifications(token: string | undefined, expectedOwnerPublicId: string): DevNotificationResult {
  const identity = getDevIdentity(token);
  if (!identity) return { kind: "unauthorized" };
  if (identity.user.publicId !== expectedOwnerPublicId) return { kind: "owner-mismatch" };
  const preferences = store().get(expectedOwnerPublicId) ?? defaultNotificationPreferences(identity.profile.timeZone);
  return { kind: "ok", value: { ownerPublicId: expectedOwnerPublicId, preferences: structuredClone(preferences),
    delivery: { configured: false, publicKey: null, reason: "not_configured" }, subscription: { subscribed: false } } };
}
export function saveDevNotificationPreferences(token: string | undefined, owner: string, preferences: NotificationPreferences): DevNotificationResult {
  const identity = getDevNotifications(token, owner);
  if (identity.kind !== "ok") return identity;
  store().set(owner, structuredClone(preferences));
  return getDevNotifications(token, owner);
}
