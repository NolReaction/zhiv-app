import { StrictMode, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Geolocation } from "@capacitor/geolocation";
import { Preferences } from "@capacitor/preferences";
import { createEarthLocationController, type EarthLocationStatus } from "@/features/earth/location";
import { createNativeEarthLocationEnvironment } from "@/features/earth/native-location";
import { createMobileLocationPreferenceStore } from "./location-preference";
import "./style.css";

const preference = createMobileLocationPreferenceStore(Preferences);
const native = Capacitor.isNativePlatform();
const available = native && ["Geolocation", "App", "Preferences"].every(name => Capacitor.isPluginAvailable(name));
const platform = Capacitor.getPlatform();
const labels: Record<EarthLocationStatus, string> = {
  idle: "Готов к поиску", requesting: "Определяем положение…", active: "Положение получено",
  paused: "Поиск приостановлен", denied: "Доступ запрещён", unavailable: "Положение недоступно",
  timeout: "Не удалось дождаться сигнала", unsupported: "Геолокация недоступна", insecure: "Нужен защищённый запуск",
};

function DeviceLab() {
  const controller = useMemo(() => createEarthLocationController("device-lab", () =>
    createNativeEarthLocationEnvironment({ geolocation: Geolocation, app: App }),
  ), []);
  const location = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  const setting = useSyncExternalStore(preference.subscribe, preference.getSnapshot, preference.getServerSnapshot);
  const [permission, setPermission] = useState("Ещё не проверено");
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!available) return;
    void preference.hydrate();
    return controller.activate();
  }, [controller]);
  useEffect(() => {
    controller.setAllowed(available && setting.ready && setting.enabled);
    controller.setEnabled(available);
  }, [controller, setting.ready, setting.enabled]);
  useEffect(() => {
    if (!location.position) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [location.position]);

  async function checkPermission() {
    setPermissionBusy(true);
    try {
      const result = await Geolocation.checkPermissions();
      const permitted = result.location === "granted" || result.coarseLocation === "granted";
      setPermission(permitted ? result.location === "granted" ? "Разрешено системой" : "Разрешено примерное положение" :
        result.location === "denied" ? "Запрещено в настройках телефона" : "Телефон спросит при нажатии «Найти меня»");
    } catch { setPermission("Проверьте, включены ли службы геолокации на телефоне"); }
    finally { setPermissionBusy(false); }
  }

  const age = location.position ? Math.max(0, Math.floor((now - location.position.timestamp) / 1000)) : null;
  const canLocate = available && setting.ready && setting.enabled && !setting.saving;
  return <main>
    <header>
      <div className="brand" aria-hidden="true">м</div>
      <div><p className="eyebrow">Мохлик · Лаборатория</p><h1>Проверка устройства</h1></div>
    </header>
    <p className="intro">Первый шаг к мобильному приложению: геопозиция и настройки на вашем телефоне.</p>
    <div className="platform"><span className={available ? "dot" : "dot muted"} />{platform === "ios" ? "iPhone / iPad" : platform === "android" ? "Android" : "Предпросмотр в браузере"}<span>Этап 1</span></div>
    {!available && <aside role="status">{native ? "Нативные плагины не подключены. Выполните mobile:sync и пересоберите приложение." :
      "Это предпросмотр экрана. Для проверки системного доступа установите сборку из Xcode или Android Studio."}</aside>}

    <section aria-labelledby="location-title">
      <div className="section-heading"><h2 id="location-title">Моя геопозиция</h2><span className="badge">Только на экране</span></div>
      <p>Поиск работает, пока приложение открыто. Координаты остаются в памяти и не отправляются на сервер.</p>
      <label className="setting">
        <span>Разрешить поиск в приложении<small>Этот выбор сохранится после перезапуска</small></span>
        <input type="checkbox" checked={setting.enabled} disabled={!available || !setting.ready}
          onChange={event => {
            const enabled = event.target.checked;
            if (!enabled) { controller.stop(); controller.setAllowed(false); }
            void preference.setEnabled(enabled);
          }} />
      </label>
      {available && !setting.ready && <p role="status">Читаем сохранённую настройку…</p>}
      {setting.saving && <p role="status">Сохраняем выбор…</p>}
      {setting.error && <div role="alert"><p>{setting.error}</p><button className="secondary" onClick={() => { void preference.setEnabled(setting.enabled); }}>Повторить сохранение</button></div>}
      <div className="position" aria-live="polite">
        <p className="status">{labels[location.status]}</p>
        {location.position ? <>
          <div className="coordinates">{location.position.latitude.toFixed(6)}<br />{location.position.longitude.toFixed(6)}</div>
          <dl><div><dt>Погрешность</dt><dd>± {Math.round(location.position.accuracy)} м</dd></div>
            <div><dt>Измерено</dt><dd>{new Date(location.position.timestamp).toLocaleTimeString("ru-RU")}</dd></div></dl>
          <p className="freshness">{age !== null && age > 60 ? "Последняя точка устарела" : "Последняя полученная точка"}</p>
        </> : <p>Нажмите «Найти меня», чтобы запросить положение.</p>}
      </div>
      {location.status === "denied" && <p role="alert">Разрешите геопозицию в настройках этого приложения на телефоне, затем повторите поиск.</p>}
      {["unavailable", "timeout"].includes(location.status) && <p role="alert">Проверьте службы геолокации и повторите поиск. Помещение может ухудшать приём сигнала.</p>}
      <div className="actions">
        <button disabled={!canLocate} onClick={() => controller.locate({ fresh: true })}>Найти меня</button>
        <button className="secondary" disabled={!available} onClick={() => controller.stop()}>Остановить и очистить</button>
      </div>
    </section>

    <section aria-labelledby="permission-title">
      <h2 id="permission-title">Разрешение телефона</h2>
      <p>Система хранит разрешение отдельно от настройки выше. Его можно изменить в настройках iOS или Android.</p>
      <p className="permission" role="status">{permission}</p>
      <button className="secondary" disabled={!available || permissionBusy} onClick={() => { void checkPermission(); }}>Проверить разрешение</button>
    </section>

    <section className="checklist" aria-labelledby="check-title">
      <h2 id="check-title">Что попробовать</h2>
      <ol><li>Разрешите поиск и получите точку.</li><li>Сверните приложение: поиск должен остановиться. Вернитесь и проверьте обновление.</li><li>Закройте и откройте приложение: настройка сохранится, новый поиск запускается кнопкой.</li><li>Запретите доступ в настройках телефона и повторите поиск.</li></ol>
    </section>
    <footer>Вход в аккаунт, игра и фоновая передача геопозиции — следующие этапы. Этот стенд их ещё не включает.</footer>
  </main>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing mobile root element");
createRoot(root).render(<StrictMode><DeviceLab /></StrictMode>);
