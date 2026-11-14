import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { PushNotifications } from "@capacitor/push-notifications";
import { NativeBridge } from "./native-bridge";
import { configureNativeRemotePush, createNativeRemotePush, REMOTE_PUSH_CONSENT_KEY, type RemotePushPermission } from "@/features/notifications/native-remote-push";
import { getNativePushSettings, subscribeNativePush, unsubscribeNativePush } from "@/features/notifications/native-remote-api";
import { queueNativeNotificationLink } from "@/features/notifications/native-notifications";
import { deviceIsActive, deviceIsOnline, subscribeDeviceEnvironment } from "@/lib/device-runtime";

const permission = (value: string): RemotePushPermission => value === "granted" ? "granted" : value === "denied" ? "denied" : "default";

/** No prompts at startup. Persisted consent may reconnect after checking the same native session. */
export async function installNativeRemotePush(): Promise<() => void> {
  if (!Capacitor.isNativePlatform()) return () => {};
  let disposed = false;
  let sessionVersion = 0;
  let registration: { resolve: (token: string) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> } | null = null;
  const handles: PluginListenerHandle[] = [];
  const cancelRegistration = () => {
    if (!registration) return;
    const pending = registration; registration = null; clearTimeout(pending.timeout);
    pending.reject(new Error("Подключение уведомлений остановлено."));
  };
  const service = createNativeRemotePush({
    read: async () => (await Preferences.get({ key: REMOTE_PUSH_CONSENT_KEY })).value,
    write: async value => { if (value === null) await Preferences.remove({ key: REMOTE_PUSH_CONSENT_KEY }); else await Preferences.set({ key: REMOTE_PUSH_CONSENT_KEY, value }); },
    configuration: () => NativeBridge.getPushConfiguration(),
    permission: async () => permission((await PushNotifications.checkPermissions()).receive),
    requestPermission: async () => permission((await PushNotifications.requestPermissions()).receive),
    register: (expectedUserId, expectedSessionGeneration) => {
      // Android serializes token creation against asynchronous Firebase deletion in native code.
      if (Capacitor.getPlatform() === "android") return NativeBridge.registerRemotePush({ expectedUserId, expectedSessionGeneration }).then(value => value.token);
      return new Promise<string>((resolve, reject) => {
        if (disposed || registration) { reject(new Error("Подключение уведомлений уже выполняется.")); return; }
        const pending = { resolve, reject, timeout: setTimeout(() => {
          if (registration !== pending) return;
          registration = null; reject(new Error("Телефон не подтвердил подключение. Проверьте сеть и настройку push в сборке."));
        }, 20_000) };
        registration = pending;
        void PushNotifications.register().catch(() => {
          if (registration !== pending) return;
          registration = null; clearTimeout(pending.timeout);
          reject(new Error("Не удалось зарегистрировать телефон для сообщений сервера. Проверьте настройку сборки."));
        });
      });
    },
    stop: async fence => {
      cancelRegistration();
      await NativeBridge.stopRemotePush({ expectedUserId: fence.userId, expectedSessionGeneration: fence.generation });
    },
    activate: (expectedUserId, ownerPublicId, expectedSessionGeneration) => NativeBridge.activateRemotePush({ expectedUserId, ownerPublicId, expectedSessionGeneration }),
    getSettings: getNativePushSettings, subscribe: subscribeNativePush, unsubscribe: unsubscribeNativePush,
  });
  configureNativeRemotePush(service);
  const keep = async (pending: Promise<PluginListenerHandle>) => { const handle = await pending; if (disposed) await handle.remove(); else handles.push(handle); };
  const restore = () => { if (!disposed && deviceIsActive(document) && deviceIsOnline()) void service.refresh().catch(() => undefined); };
  let detachEnvironment: (() => void) | null = null;
  try {
    await keep(PushNotifications.addListener("registration", event => {
      if (disposed) return;
      if (Capacitor.getPlatform() === "android") {
        // onNewToken has no account epoch. Treat it as a hint and reread under the native barrier,
        // rather than binding a delayed token from an earlier account/registration attempt.
        void service.refresh().catch(() => undefined);
        return;
      }
      if (registration) {
        const pending = registration; registration = null; clearTimeout(pending.timeout); pending.resolve(event.value);
      } else void service.tokenChanged(event.value).catch(() => undefined);
    }));
    await keep(PushNotifications.addListener("registrationError", () => {
      if (!registration) return;
      const pending = registration; registration = null; clearTimeout(pending.timeout);
      pending.reject(new Error("Система не подключила push. Проверьте разрешение, сеть и настройку подписанной сборки."));
    }));
    await keep(PushNotifications.addListener("pushNotificationActionPerformed", event => {
      if (!disposed && event.actionId === "tap") queueNativeNotificationLink(event.notification.data);
    }));
    await keep(NativeBridge.addListener("sessionChange", state => {
      sessionVersion++;
      cancelRegistration();
      void service.setSession(state).catch(() => undefined);
    }));
    const expectedVersion = sessionVersion;
    const state = await NativeBridge.getState();
    if (expectedVersion === sessionVersion) void service.setSession(state).catch(() => undefined);
    window.addEventListener("focus", restore);
    window.addEventListener("online", restore);
    document.addEventListener("visibilitychange", restore);
    detachEnvironment = subscribeDeviceEnvironment(restore);
  } catch (cause) {
    disposed = true; service.dispose(); cancelRegistration();
    await Promise.allSettled(handles.map(handle => handle.remove()));
    configureNativeRemotePush(null);
    throw cause;
  }
  return () => {
    disposed = true; service.dispose(); cancelRegistration();
    window.removeEventListener("focus", restore); window.removeEventListener("online", restore);
    document.removeEventListener("visibilitychange", restore); detachEnvironment?.();
    for (const handle of handles) void handle.remove();
    configureNativeRemotePush(null);
  };
}
