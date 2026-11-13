import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Preferences } from "@capacitor/preferences";
import { Network } from "@capacitor/network";
import { LocalNotifications } from "@capacitor/local-notifications";
import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";
import { Share } from "@capacitor/share";
import { configureDeviceCapabilities, updateDeviceEnvironment, resetDeviceEnvironment, reportMemoryPressure } from "@/lib/device-runtime";
import { createNativeNotifications, configureNativeNotifications, queueNativeNotificationLink, NATIVE_NOTIFICATION_PREFERENCE_KEY } from "@/features/notifications/native-notifications";
import { flushNativeSettings } from "./native-storage";

type Insets = { top: number; right: number; bottom: number; left: number };
interface HardwareBridge {
  getSafeArea(): Promise<Insets>;
  getState(): Promise<{ authenticated: boolean }>;
  addListener(event: "memoryWarning", listener: () => void): Promise<PluginListenerHandle>;
  addListener(event: "safeAreaChange", listener: (insets: Insets) => void): Promise<PluginListenerHandle>;
  addListener(event: "sessionChange", listener: (state: { authenticated: boolean }) => void): Promise<PluginListenerHandle>;
}
const bridge = registerPlugin<HardwareBridge>("MochlikNative");
const permission = (value: string) => value === "granted" ? "granted" as const : value === "denied" ? "denied" as const : "default" as const;

/** Installs system capabilities; no permissions are requested during startup. */
export async function installNativeHardware(): Promise<() => void> {
  if (!Capacitor.isNativePlatform()) return () => {};
  const handles: PluginListenerHandle[] = [];
  let disposed = false, appVersion = 0, networkVersion = 0, sessionVersion = 0, insetVersion = 0;
  const keep = async (pending: Promise<PluginListenerHandle>) => { const handle = await pending; if (disposed) await handle.remove(); else handles.push(handle); };
  const service = createNativeNotifications({
    read: async () => (await Preferences.get({ key: NATIVE_NOTIFICATION_PREFERENCE_KEY })).value,
    write: async value => { await Preferences.set({ key: NATIVE_NOTIFICATION_PREFERENCE_KEY, value }); },
    checkPermission: async () => permission((await LocalNotifications.checkPermissions()).display),
    requestPermission: async () => permission((await LocalNotifications.requestPermissions()).display),
    pending: async () => (await LocalNotifications.getPending()).notifications,
    cancel: async ids => { await LocalNotifications.cancel({ notifications: ids.map(id => ({ id })) }); },
    clearDelivered: async () => {
      const delivered = await LocalNotifications.getDeliveredNotifications();
      const notifications = delivered.notifications.filter(item => item.extra?.source === "mochlik-game");
      if (notifications.length) await LocalNotifications.removeDeliveredNotifications({ notifications });
    },
    schedule: async reminders => {
      await LocalNotifications.schedule({ notifications: reminders.map(reminder => ({
        id: reminder.id, title: reminder.title, body: reminder.body, extra: reminder.extra,
        schedule: { at: new Date(reminder.at), allowWhileIdle: false }, channelId: "mochlik-game",
        autoCancel: true, group: "mochlik-game",
      })) });
    },
    now: Date.now,
  });
  configureNativeNotifications(service);
  configureDeviceCapabilities({
    haptic: async kind => {
      if (kind === "bite") await Haptics.notification({ type: NotificationType.Success });
      else await Haptics.impact({ style: ImpactStyle.Light });
    },
    share: async data => {
      // Browser File objects do not grant the native plugin arbitrary filesystem access.
      if (data.files?.length) return "unavailable";
      if (data.url) {
        try { if (!["http:", "https:"].includes(new URL(data.url).protocol)) return "unavailable"; }
        catch { return "unavailable"; }
      }
      try { await Share.share({ title: data.title, text: data.text, url: data.url, dialogTitle: "Поделиться Мохликом" }); return "shared"; }
      catch (cause) {
        const message = cause instanceof Error ? cause.message : "";
        return /cancel|dismiss/i.test(message) ? "cancelled" : "failed";
      }
    },
  });
  const insets = (value: Insets) => {
    if (disposed) return;
    for (const side of ["top", "right", "bottom", "left"] as const) {
      const number = value[side];
      if (Number.isFinite(number) && number >= 0 && number <= 300) document.documentElement.style.setProperty(`--native-safe-area-${side}`, `${number}px`);
    }
  };
  try {
    await keep(App.addListener("appStateChange", state => {
      appVersion++; updateDeviceEnvironment({ active: state.isActive });
      if (!state.isActive) void flushNativeSettings().catch(() => undefined);
      if (state.isActive) {
        // Existing reconcilers listen to focus; native active state remains the authority for gameplay.
        window.dispatchEvent(new Event("focus"));
        void service.reconcile().catch(() => undefined);
      }
    }));
    const initialAppVersion = appVersion;
    const state = await App.getState();
    if (initialAppVersion === appVersion) updateDeviceEnvironment({ active: state.isActive });
    await keep(Network.addListener("networkStatusChange", status => {
      networkVersion++; updateDeviceEnvironment({ connected: status.connected });
      window.dispatchEvent(new Event(status.connected ? "online" : "offline"));
    }));
    const initialNetworkVersion = networkVersion;
    const network = await Network.getStatus();
    if (initialNetworkVersion === networkVersion) updateDeviceEnvironment({ connected: network.connected });
    await keep(bridge.addListener("memoryWarning", reportMemoryPressure));
    await keep(bridge.addListener("safeAreaChange", value => { insetVersion++; insets(value); }));
    const initialInsetVersion = insetVersion;
    const currentInsets = await bridge.getSafeArea();
    if (initialInsetVersion === insetVersion) insets(currentInsets);
    await keep(bridge.addListener("sessionChange", value => {
      sessionVersion++;
      if (!value.authenticated) void service.reset().catch(() => undefined);
    }));
    const initialSessionVersion = sessionVersion;
    const session = await bridge.getState();
    if (initialSessionVersion === sessionVersion && !session.authenticated) await service.reset();
    await keep(LocalNotifications.addListener("localNotificationActionPerformed", event => queueNativeNotificationLink(event.notification.extra)));
    if (Capacitor.getPlatform() === "android") await LocalNotifications.createChannel({ id: "mochlik-game", name: "Дела в лесу", description: "Напоминания о стройке, путешествиях и производстве", importance: 3, visibility: 0 });
    await service.hydrate();
  } catch (cause) {
    disposed = true;
    await Promise.allSettled(handles.map(handle => handle.remove()));
    configureNativeNotifications(null); resetDeviceEnvironment();
    throw cause;
  }
  return () => {
    disposed = true;
    for (const handle of handles) void handle.remove();
    configureNativeNotifications(null); resetDeviceEnvironment();
  };
}
