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
  if (ios && !standalone) return { supported: false, reason: "На iPhone и iPad откройте сайт в Safari или Chrome → «Поделиться» → «На экран „Домой“», затем запустите приложение со значка. Инструкция есть в настройках → «Установить приложение». Нужна iOS 16.4 или новее." };
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return { supported: false, reason: "В этом режиме браузера нет Web Push. Откройте сайт в полном обновлённом браузере в обычном режиме. Настройки сохранятся для другого поддерживаемого устройства." };
  }
  if (Notification.permission === "denied") return { supported: false, reason: deniedPermissionReason() };
  return { supported: true, reason: null };
}
function deniedPermissionReason() {
  if (/YaBrowser/i.test(navigator.userAgent) && !/iPad|iPhone|iPod/.test(navigator.userAgent)) {
    return /Android/i.test(navigator.userAgent)
      ? "Уведомления запрещены. В Яндекс Браузере откройте «Настройки → Уведомления → Уведомления от сайтов», разрешите их для этого сайта и вернитесь сюда."
      : "Уведомления запрещены. В Яндекс Браузере откройте «Настройки → Сайты → Уведомления», разрешите их для этого сайта и вернитесь сюда.";
  }
  return "Уведомления запрещены в настройках устройства или браузера. Разрешите их для приложения и вернитесь сюда.";
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
  const registration = await browserDeadline(navigator.serviceWorker.getRegistration("/"), "Приложение долго готовит уведомления. Закройте его и откройте снова.");
  return registration?.pushManager ? browserDeadline(registration.pushManager.getSubscription(), "Не удалось проверить подписку устройства. Повторите подключение.") : null;
}
// PushManager has one subscription per browser registration, not one per account.
// Serialize mutations and invalidate awaiting work when authentication changes.
let activeOwner: string | null | undefined;
let ownerGeneration = 0;
let subscriptionOperation: Promise<unknown> = Promise.resolve();
let queuedOperations = 0;
let nativeSubscribePending: Promise<PushSubscription> | null = null;
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
function withSubscriptionLock<T>(operation: () => Promise<T>, immediate = false): Promise<T> {
  if (immediate && queuedOperations > 0) return Promise.reject(new Error("Подписка ещё обновляется. Подождите немного и нажмите кнопку снова."));
  queuedOperations++;
  // The explicit connect gesture cannot wait in a promise queue: WebKit may
  // consume its activation before PushManager.subscribe is reached.
  let pending: Promise<T>;
  try { pending = immediate ? operation() : subscriptionOperation.then(operation, operation); }
  catch (error) { pending = Promise.reject(error); }
  pending = pending.finally(() => { queuedOperations--; });
  subscriptionOperation = pending.then(() => undefined, () => undefined);
  return pending;
}
function browserDeadline<T>(pending: Promise<T>, message: string, signal?: AbortSignal, milliseconds = 10_000,
  mapError: (error: unknown) => unknown = () => new Error(message)): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const finish = (result: { value: T } | { error: unknown }) => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if ("value" in result) resolve(result.value); else reject(result.error);
    };
    const abort = () => finish({ error: new DOMException("Подготовка отменена", "AbortError") });
    const timer = setTimeout(() => finish({ error: new Error(message) }), milliseconds);
    // Both handlers remain attached after a timeout: a late native rejection
    // is consumed and a late result cannot continue binding another profile.
    void pending.then(value => finish({ value }), error => finish({ error: mapError(error) }));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
export async function clearPreviousNotificationOwner(owner: string | null) {
  const generation = ownerGeneration;
  return withSubscriptionLock(async () => {
    if (generation !== ownerGeneration || (activeOwner !== undefined && activeOwner !== owner)) return;
    const previous = rememberedNotificationOwner();
    if (!previous || previous === owner) return;
    const subscription = await currentPushSubscription();
    if (generation !== ownerGeneration || rememberedNotificationOwner() !== previous) return;
    if (subscription) await browserDeadline(subscription.unsubscribe(), "Браузер долго отключает подписку прежнего профиля. Откройте приложение заново.");
    if (generation === ownerGeneration && rememberedNotificationOwner() === previous) rememberNotificationOwner(null);
  });
}
function publicKeyBytes(value: string): ArrayBuffer {
  try {
    const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0));
    if (bytes.length === 65 && bytes[0] === 4) return bytes.buffer;
  } catch { /* Invalid server configuration is explained without a native exception. */ }
  throw new Error("Сервер пока не подготовлен к отправке уведомлений");
}
export type PreparedPushConnection = { readonly snapshot: NotificationSnapshot; readonly subscription: PushSubscription | null };
type PreparedState = { owner: string; registration: ServiceWorkerRegistration; applicationServerKey: ArrayBuffer;
  priorOwner: string | null; assertOwner: () => void; preparedAt: number; used: boolean };
const preparations = new WeakMap<PreparedPushConnection, PreparedState>();
const PREPARATION_TTL_MS = 5 * 60_000;
function requireConfigured(owner: string, snapshot: NotificationSnapshot) {
  if (snapshot.ownerPublicId !== owner || !snapshot.delivery.configured || !snapshot.delivery.publicKey) throw new Error("Отправка уведомлений ещё не подключена. Ваши настройки можно сохранить.");
  return publicKeyBytes(snapshot.delivery.publicKey);
}
function assertRememberedOwner(previous: string | null) {
  if (rememberedNotificationOwner() !== previous) throw new Error("Подписка изменилась в другой вкладке. Откройте настройки заново.");
}
function sameKey(previous: ArrayBuffer | null | undefined, current: ArrayBuffer) {
  return !previous || previous.byteLength === current.byteLength && new Uint8Array(previous).every((value, index) => value === new Uint8Array(current)[index]);
}
/** Preparation may restore the app worker; permissions and existing subscriptions never change here. */
export async function preparePushConnection(owner: string, signal?: AbortSignal): Promise<PreparedPushConnection> {
  const assertOwner = ownedOperation(owner);
  return withSubscriptionLock(async () => {
    assertOwner();
    const support = notificationSupport();
    if (!support.supported) throw new Error(support.reason ?? "Уведомления недоступны");
    const priorOwner = rememberedNotificationOwner();
    const authenticated = await getNotificationSettings(owner, signal);
    assertOwner();
    const applicationServerKey = requireConfigured(owner, authenticated);
    let registration = await browserDeadline(navigator.serviceWorker.getRegistration("/"), "Приложение долго готовит уведомления. Закройте его и откройте снова.", signal);
    assertOwner();
    // A failed installation can leave no registration (or an empty one).
    // Retrying settings must repair it instead of waiting for another app launch.
    if (!registration?.active && !registration?.installing && !registration?.waiting) {
      registration = await browserDeadline(navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }),
        "Не удалось подготовить уведомления. Проверьте интернет и нажмите «Повторить проверку».", signal);
      assertOwner(); assertRememberedOwner(priorOwner);
    }
    if (!registration?.active) {
      await browserDeadline(navigator.serviceWorker.ready, "Подготовка уведомлений затянулась. Проверьте интернет и нажмите «Повторить проверку».", signal);
      assertOwner(); assertRememberedOwner(priorOwner);
      registration = await browserDeadline(navigator.serviceWorker.getRegistration("/"), "Не удалось проверить готовность уведомлений. Откройте приложение заново.", signal);
      assertOwner();
    }
    if (!registration?.active) throw new Error("Браузер не смог подготовить уведомления. Нажмите «Повторить проверку».");
    const subscription = await browserDeadline(registration.pushManager.getSubscription(), "Не удалось проверить подписку устройства. Повторите подключение.", signal);
    if (signal?.aborted) throw new DOMException("Подготовка отменена", "AbortError");
    assertOwner();
    assertRememberedOwner(priorOwner);
    const prepared: PreparedPushConnection = { snapshot: authenticated, subscription };
    preparations.set(prepared, { owner, registration, applicationServerKey, priorOwner, assertOwner, preparedAt: Date.now(), used: false });
    return prepared;
  });
}
function subscriptionError(error: unknown): Error {
  const name = error instanceof Error ? error.name : "";
  if (Notification.permission === "denied") return new Error(deniedPermissionReason());
  if (name === "NotAllowedError") return new Error("Браузер не разрешил подписку. Нажмите «Подключить на устройстве» ещё раз и подтвердите разрешение.");
  if (name === "InvalidStateError") return new Error("Подписка устройства устарела. Повторите подключение; при необходимости закройте приложение и откройте снова.");
  if (name === "NotSupportedError") return new Error("Этот режим браузера не поддерживает push. На iPhone откройте приложение с экрана «Домой».");
  if (name === "AbortError") return new Error("Браузер прервал подключение уведомлений. Проверьте интернет и попробуйте ещё раз.");
  if (name === "SecurityError") return new Error("Браузер заблокировал уведомления. Откройте приложение через HTTPS с экрана «Домой».");
  return new Error("Не удалось создать подписку в браузере. Проверьте интернет и повторите подключение.");
}
export async function connectPush(owner: string, snapshot: NotificationSnapshot, prepared?: PreparedPushConnection,
  onStage?: (stage: "subscribing" | "saving") => void): Promise<NotificationSnapshot> {
  requireConfigured(owner, snapshot);
  const state = prepared && preparations.get(prepared);
  if (!prepared || !state || state.owner !== owner || state.used || Date.now() - state.preparedAt > PREPARATION_TTL_MS) {
    throw new Error("Подготовка подключения устарела. Подождите обновления настроек и нажмите кнопку снова.");
  }
  state.assertOwner(); assertRememberedOwner(state.priorOwner);
  if (snapshot.delivery.publicKey !== prepared.snapshot.delivery.publicKey) throw new Error("Сервер обновил настройки уведомлений. Повторите подключение.");
  const support = notificationSupport();
  if (!support.supported) throw new Error(support.reason ?? "Уведомления недоступны");
  if (nativeSubscribePending) throw new Error("Браузер ещё завершает подписку. Подождите немного; если ожидание затянулось, закройте приложение и откройте снова.");
  state.used = true;
  const assertCurrent = () => { state.assertOwner(); assertRememberedOwner(state.priorOwner); };
  return withSubscriptionLock(async () => {
    assertCurrent();
    if (!state.registration.active) throw new Error("Приложение ещё готовится. Откройте его заново и повторите подключение.");
    let subscription = prepared.subscription;
    if (subscription && ((state.priorOwner !== null && state.priorOwner !== owner) || !sameKey(subscription.options?.applicationServerKey, state.applicationServerKey))) {
      // Cleanup is an explicit button action, never a side effect of opening
      // settings. Authenticate again before touching a shared registration.
      await getNotificationSettings(owner); assertCurrent();
      const current = await browserDeadline(state.registration.pushManager.getSubscription(), "Не удалось проверить старую подписку. Повторите подключение.");
      assertCurrent();
      if (current?.endpoint !== subscription.endpoint) throw new Error("Подписка изменилась. Обновите настройки и попробуйте снова.");
      await browserDeadline(subscription.unsubscribe(), "Браузер долго отключает старую подписку. Откройте приложение заново.");
      assertCurrent();
      rememberNotificationOwner(null);
      throw new Error("Старая подписка отключена. Нажмите «Подключить на устройстве» ещё раз, чтобы разрешить новую.");
    }
    if (!subscription) {
      onStage?.("subscribing");
      let native: Promise<PushSubscription>;
      // No requestPermission(), await, fetch or lock queue before this call.
      // subscribe itself presents the permission prompt in the button gesture.
      try { native = state.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: state.applicationServerKey }); }
      catch (error) { throw subscriptionError(error); }
      nativeSubscribePending = native;
      void native.then(() => { if (nativeSubscribePending === native) nativeSubscribePending = null; },
        () => { if (nativeSubscribePending === native) nativeSubscribePending = null; });
      subscription = await browserDeadline(native,
        "Браузер долго создаёт подписку. Подтвердите запрос разрешения; если он не появился, закройте приложение и откройте снова.", undefined, 30_000, subscriptionError);
    }
    assertCurrent();
    onStage?.("saving");
    const authenticated = await getNotificationSettings(owner);
    assertCurrent();
    requireConfigured(owner, authenticated);
    if (authenticated.delivery.publicKey !== prepared.snapshot.delivery.publicKey) throw new Error("Сервер обновил ключ уведомлений. Повторите подключение.");
    const current = await browserDeadline(state.registration.pushManager.getSubscription(), "Не удалось проверить подписку перед сохранением. Повторите подключение.");
    assertCurrent();
    if (current?.endpoint !== subscription.endpoint) throw new Error("Подписка устройства изменилась. Обновите настройки и подключите её снова.");
    const data = subscription.toJSON();
    if (!data.endpoint || !data.keys?.p256dh || !data.keys.auth) throw new Error("Браузер не смог создать подписку. Попробуйте ещё раз.");
    // Keep an unbound native subscription after a server failure. Another tab
    // can have successfully saved this same endpoint, so rollback-unsubscribe
    // would revoke its working delivery. A fresh explicit retry can bind it.
    const result = await saveNotificationSubscription(owner, { endpoint: data.endpoint, keys: { p256dh: data.keys.p256dh, auth: data.keys.auth } });
    assertCurrent();
    if (result.ownerPublicId !== owner) throw new Error("Профиль изменился. Откройте настройки заново.");
    if (!result.subscription.subscribed) throw new Error("Сервер не подтвердил подключение уведомлений. Повторите попытку.");
    rememberNotificationOwner(owner);
    return result;
  }, true);
}
export async function disconnectPush(owner: string): Promise<NotificationSnapshot | null> {
  const assertOwner = ownedOperation(owner);
  return withSubscriptionLock(async () => {
    assertOwner();
    const priorOwner = rememberedNotificationOwner();
    const assertCurrent = () => { assertOwner(); assertRememberedOwner(priorOwner); };
    await getNotificationSettings(owner);
    assertCurrent();
    const subscription = await currentPushSubscription();
    assertCurrent();
    if (!subscription) { rememberNotificationOwner(null); return null; }
    const result = await removeNotificationSubscription(owner, subscription.endpoint);
    assertCurrent();
    await browserDeadline(subscription.unsubscribe(), "Браузер долго отключает уведомления. Откройте приложение заново.");
    assertCurrent();
    rememberNotificationOwner(null);
    return result;
  });
}
