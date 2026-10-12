import { getNotificationSettings, saveNotificationSubscription, removeNotificationSubscription } from "./notification-api";
import type { NotificationSnapshot } from "./notification-contract";

export type NotificationTarget = "checkin" | "activities" | "production" | "construction";
export type NotificationLink = { ownerPublicId: string; target: NotificationTarget };
export function parseNotificationLink(value: string, origin: string): NotificationLink | null {
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || url.pathname !== "/") return null;
    const ownerPublicId = url.searchParams.get("owner");
    if (!ownerPublicId || ownerPublicId.length > 128) return null;
    if (url.searchParams.get("notification") === "checkin") return { ownerPublicId, target: "checkin" };
    const section = url.searchParams.get("section");
    if (url.searchParams.get("notification") === "world" && (section === "activities" || section === "production" || section === "construction")) {
      return { ownerPublicId, target: section };
    }
  } catch { /* Invalid or external notification targets never navigate. */ }
  return null;
}

export function notificationSupport(): { supported: boolean; reason: string | null } {
  if (typeof window === "undefined") return { supported: false, reason: null };
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (!window.isSecureContext) return { supported: false, reason: "Уведомления работают при безопасном подключении HTTPS. Настройки уже можно сохранить." };
  if (ios && !standalone) return { supported: false, reason: "На iPhone и iPad добавьте приложение на экран «Домой» через меню «Поделиться», затем откройте его оттуда. Нужна iOS 16.4 или новее." };
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return { supported: false, reason: "В этом браузере нет Web Push. Настройки сохранятся для другого поддерживаемого устройства." };
  }
  if (Notification.permission === "denied") return { supported: false, reason: "Уведомления запрещены в настройках браузера или устройства. Разрешите их там, затем вернитесь сюда." };
  return { supported: true, reason: null };
}

const OWNER_KEY = "zhiv.push-owner.v1";
export function rememberedNotificationOwner(): string | null {
  try { return localStorage.getItem(OWNER_KEY); } catch { return null; }
}
export function rememberNotificationOwner(owner: string | null) {
  try { if (owner) localStorage.setItem(OWNER_KEY, owner); else localStorage.removeItem(OWNER_KEY); } catch { /* Private browsing can restrict storage. */ }
}
export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  const registration = await navigator.serviceWorker.getRegistration("/");
  return registration?.pushManager?.getSubscription() ?? null;
}
// PushManager has one subscription per browser registration, not one per account.
// Serialize mutations and invalidate awaiting work when authentication changes.
let activeOwner: string | null | undefined;
let ownerGeneration = 0;
let subscriptionOperation: Promise<unknown> = Promise.resolve();
export function setActiveNotificationOwner(owner: string | null) {
  if (activeOwner !== owner) { activeOwner = owner; ownerGeneration += 1; }
}
function ownedOperation(owner: string) {
  const generation = ownerGeneration;
  return () => {
    if (generation !== ownerGeneration || (activeOwner !== undefined && activeOwner !== owner)) {
      throw new Error("Профиль изменился. Откройте настройки заново.");
    }
  };
}
function withSubscriptionLock<T>(operation: () => Promise<T>): Promise<T> {
  const pending = subscriptionOperation.then(operation, operation);
  subscriptionOperation = pending.then(() => undefined, () => undefined);
  return pending;
}
export async function clearPreviousNotificationOwner(owner: string | null) {
  const generation = ownerGeneration;
  return withSubscriptionLock(async () => {
    if (generation !== ownerGeneration || (activeOwner !== undefined && activeOwner !== owner)) return;
    const previous = rememberedNotificationOwner();
    if (!previous || previous === owner) return;
    const subscription = await currentPushSubscription();
    if (generation !== ownerGeneration || rememberedNotificationOwner() !== previous) return;
    if (subscription) await subscription.unsubscribe();
    if (generation === ownerGeneration && rememberedNotificationOwner() === previous) rememberNotificationOwner(null);
  });
}
function publicKeyBytes(value: string): ArrayBuffer {
  const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0));
  if (bytes.length !== 65 || bytes[0] !== 4) throw new Error("Сервер пока не подготовлен к отправке уведомлений");
  return bytes.buffer;
}
export async function connectPush(owner: string, snapshot: NotificationSnapshot): Promise<NotificationSnapshot> {
  if (snapshot.ownerPublicId !== owner || !snapshot.delivery.configured || !snapshot.delivery.publicKey) throw new Error("Отправка уведомлений ещё не подключена. Ваши настройки можно сохранить.");
  const assertOwner = ownedOperation(owner);
  assertOwner();
  const support = notificationSupport();
  if (!support.supported) throw new Error(support.reason ?? "Уведомления недоступны");
  publicKeyBytes(snapshot.delivery.publicKey);
  // This call must stay before the first await: Safari requires the explicit button gesture.
  const permission = await Notification.requestPermission();
  assertOwner();
  if (permission !== "granted") throw new Error(permission === "denied" ? "Уведомления запрещены. Изменить разрешение можно в настройках браузера." : "Уведомления не включены. Можно вернуться к этому позже.");
  return withSubscriptionLock(async () => {
    assertOwner();
    const authenticated = await getNotificationSettings(owner);
    assertOwner();
    if (!authenticated.delivery.configured || !authenticated.delivery.publicKey) throw new Error("Отправка уведомлений ещё не подключена.");
    const applicationServerKey = publicKeyBytes(authenticated.delivery.publicKey);
    const registration = await navigator.serviceWorker.getRegistration("/");
    assertOwner();
    if (!registration?.active) throw new Error("Приложение ещё готовится. Откройте его заново и повторите подключение.");
    let subscription = await registration.pushManager.getSubscription();
    assertOwner();
    const priorOwner = rememberedNotificationOwner();
    const priorKey = subscription?.options?.applicationServerKey;
    const rotatedKey = priorKey && !new Uint8Array(priorKey).every((value, index) => value === new Uint8Array(applicationServerKey)[index]);
    if (subscription && (priorOwner !== owner || rotatedKey)) {
      await subscription.unsubscribe(); subscription = null; assertOwner();
    }
    const created = !subscription;
    subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
    try {
      assertOwner();
      const data = subscription.toJSON();
      if (!data.endpoint || !data.keys?.p256dh || !data.keys.auth) throw new Error("Браузер не смог создать подписку. Попробуйте ещё раз.");
      const result = await saveNotificationSubscription(owner, { endpoint: data.endpoint, keys: { p256dh: data.keys.p256dh, auth: data.keys.auth } });
      assertOwner();
      if (result.ownerPublicId !== owner) throw new Error("Профиль изменился. Откройте настройки заново.");
      rememberNotificationOwner(owner);
      return result;
    } catch (error) {
      // Another browser tab may already have rebound the shared registration.
      const remembered = rememberedNotificationOwner();
      if (created && (!remembered || remembered === owner || remembered === priorOwner)) await subscription.unsubscribe().catch(() => false);
      throw error;
    }
  });
}
export async function disconnectPush(owner: string): Promise<NotificationSnapshot | null> {
  const assertOwner = ownedOperation(owner);
  return withSubscriptionLock(async () => {
    assertOwner();
    await getNotificationSettings(owner);
    assertOwner();
    const subscription = await currentPushSubscription();
    assertOwner();
    if (!subscription) { rememberNotificationOwner(null); return null; }
    const result = await removeNotificationSubscription(owner, subscription.endpoint);
    assertOwner();
    await subscription.unsubscribe();
    assertOwner();
    rememberNotificationOwner(null);
    return result;
  });
}
