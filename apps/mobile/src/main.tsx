import { createRoot } from "react-dom/client";
import { Capacitor } from "@capacitor/core";
import "./style.css";

const element = document.getElementById("root");
if (!element) throw new Error("Missing mobile root element");
const root = createRoot(element);
let starting = false;
let dispose: (() => void) | undefined;

async function start() {
  if (starting) return;
  starting = true;
  root.render(<main className="mobile-start" aria-busy="true"><h1>Открываем Мохлика…</h1><p>Подготавливаем данные устройства</p></main>);
  const cleanup: Array<() => void> = [];
  try {
    if (!Capacitor.isNativePlatform()) {
      root.render(<main className="mobile-start"><h1>Мобильная версия Мохлика</h1><p>Эта сборка использует системные возможности iPhone и Android. Для запуска установите её из Xcode или Android Studio.</p><a href="https://im-alive.ru/">Открыть веб-версию</a></main>);
      return;
    }
    const [{ initializeNativeStorage }, { initializeMobileTransport }, { NativeBridge }, { createMobileSession }, { configureClientPlatform }] = await Promise.all([
      import("./native-storage"), import("./mobile-transport"), import("./native-bridge"), import("./mobile-session"), import("@/lib/client-platform"),
    ]);
    const session = createMobileSession({
      getState: () => NativeBridge.getState(), login: () => NativeBridge.login(), cancelLogin: () => NativeBridge.cancelLogin(),
      hydrate: initializeNativeStorage,
      subscribe: async listener => { const handle = await NativeBridge.addListener("sessionChange", listener); return () => { void handle.remove(); }; },
    });
    cleanup.push(() => session.dispose());
    await initializeMobileTransport(() => session.getSnapshot());
    const platform = Capacitor.getPlatform();
    configureClientPlatform({
      kind: platform === "ios" ? "ios" : "android", appVersion: "0.2.0",
      login: () => session.login(), logout: () => NativeBridge.logout(), openAccount: () => NativeBridge.openWebsite({ path: "/?auth=account-proof" }),
      openDiagnostics: () => window.dispatchEvent(new Event("mochlik:open-diagnostics")),
    });
    const { installNativeLinkHandler } = await import("./native-link-handler");
    cleanup.push(installNativeLinkHandler());
    const [{ App }, { Geolocation }, { configureEarthLocationEnvironment }, { createNativeEarthLocationEnvironment }] = await Promise.all([
      import("@capacitor/app"), import("@capacitor/geolocation"), import("@/features/earth/location"), import("@/features/earth/native-location"),
    ]);
    cleanup.push(configureEarthLocationEnvironment(() => createNativeEarthLocationEnvironment({ app: App, geolocation: Geolocation })));
    await session.initialize();
    // Import runtime/game modules only after account-specific journals and settings are restored.
    const { installNativeHardware } = await import("./native-hardware");
    cleanup.push(await installNativeHardware());
    const { installNativeLocationPublisher } = await import("./native-location-publisher");
    await installNativeLocationPublisher();
    const { MobileApplication } = await import("./mobile-app");
    dispose = () => { for (const stop of cleanup.reverse()) stop(); };
    root.render(<MobileApplication session={session} />);
  } catch {
    for (const stop of cleanup.reverse()) stop();
    root.render(<main className="mobile-start"><h1>Не удалось запустить приложение</h1><p>Проверьте, что установлена свежая сборка. Данные аккаунта остаются на сервере.</p><button onClick={() => { void start(); }}>Повторить</button></main>);
  } finally { starting = false; }
}

window.addEventListener("beforeunload", () => dispose?.(), { once: true });
void start();
