"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { ArrowLeft, Bell, ChevronRight, MapPin, Settings2, Smartphone, Volume2 } from "lucide-react";
import { InstallPanel } from "@/features/pwa/install-panel";
import { SharingSwitch as Switch } from "@/components/sharing-switch";
import { AudioSettingsPanel } from "@/features/audio/ui/audio-settings";
import { NotificationSettingsPanel, type NotificationSettingsExit } from "@/features/notifications/notification-settings";
import { useSectionGuideLauncherPreference } from "@/features/onboarding/use-section-guide-preferences";
import { WorldTapHintSetting } from "@/features/world/ui/profile/world-tap-hint-setting";
import { ProfileLocationSettings, type LocationPrivacyState } from "./profile-location-settings";
import styles from "./profile-settings.module.css";

const screens = [
  { id: "installation", title: "Установить приложение", description: "Значок на экране и инструкция для вашего браузера", icon: Smartphone },
  { id: "notifications", title: "Уведомления", description: "События, тихие часы и частота сообщений", icon: Bell },
  { id: "location", title: "Геопозиция", description: "Полное отключение, проверка разрешения и точности", icon: MapPin },
  { id: "audio", title: "Звук", description: "Музыка, окружение и громкость игры", icon: Volume2 },
  { id: "appearance", title: "Внешний вид", description: "Простой вид, подсказки и ромбики на карте", icon: Settings2 },
] as const;

type SettingsScreen = typeof screens[number]["id"];

export function ProfileSettings({ ownerPublicId, isOnline, onSessionLost, simpleView, onSimpleViewChange, notificationSettingsExit, active = true, locationPrivacy }: {
  ownerPublicId: string;
  isOnline: boolean;
  onSessionLost: () => void;
  simpleView: boolean;
  onSimpleViewChange: (value: boolean) => void;
  notificationSettingsExit: RefObject<NotificationSettingsExit | null>;
  active?: boolean;
  locationPrivacy?: LocationPrivacyState;
}) {
  const { showSectionGuideLauncher, setShowSectionGuideLauncher } = useSectionGuideLauncherPreference(ownerPublicId);
  const [screen, setScreen] = useState<SettingsScreen | null>(null);
  const [visited, setVisited] = useState<SettingsScreen[]>([]);
  const entryRefs = useRef<Partial<Record<SettingsScreen, HTMLButtonElement | null>>>({});
  const backRef = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<SettingsScreen | "back" | null>(null);

  useEffect(() => {
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target === "back") backRef.current?.focus();
    else if (target) entryRefs.current[target]?.focus();
  }, [screen]);

  function openScreen(next: SettingsScreen) {
    pendingFocus.current = "back";
    setVisited(previous => previous.includes(next) ? previous : [...previous, next]);
    setScreen(next);
  }

  function goBack() {
    const leave = () => { pendingFocus.current = screen; setScreen(null); };
    if (screen === "notifications" && notificationSettingsExit.current) notificationSettingsExit.current.requestLeave(leave);
    else leave();
  }

  const currentTitle = screens.find(item => item.id === screen)?.title;

  return <div className={styles.settings} data-profile-settings-screen={screen ?? "menu"}>
    <section className={styles.menu} hidden={screen !== null} aria-labelledby="profile-settings-title">
      <header className={styles.heading}>
        <h2 id="profile-settings-title">Настройки</h2>
        <p>Выберите, что хотите настроить</p>
      </header>
      <div className={styles.entries}>
        {screens.map(({ id, title, description, icon: Icon }) => <button key={id} type="button"
          ref={element => { entryRefs.current[id] = element; }}
          className={styles.entry} onClick={() => openScreen(id)} data-audio-cue="ui.open">
          <span className={styles.icon}><Icon size={21} aria-hidden="true" /></span>
          <span className={styles.entryText}><strong>{title}</strong><span>{description}</span></span>
          <ChevronRight size={19} className={styles.chevron} aria-hidden="true" />
        </button>)}
      </div>
    </section>
    {screen && <div className={styles.screenNavigation}>
      <button ref={backRef} type="button" className={styles.back} onClick={goBack}
        aria-label={`Вернуться к настройкам из раздела «${currentTitle}»`} data-audio-cue="ui.close">
        <ArrowLeft size={18} aria-hidden="true" />Все настройки
      </button>
      <span className={styles.currentTitle} aria-hidden="true">{currentTitle}</span>
    </div>}
    {/* Keep visited screens mounted so returning does not discard notification drafts. */}
    {visited.includes("installation") && <div className={styles.screen} hidden={screen !== "installation"}>
      <InstallPanel compact context="settings" />
    </div>}
    {visited.includes("notifications") && <div className={styles.screen} hidden={screen !== "notifications"}>
      <NotificationSettingsPanel ownerPublicId={ownerPublicId} isOnline={isOnline} onSessionLost={onSessionLost} exitRef={notificationSettingsExit} />
    </div>}
    {visited.includes("audio") && <div className={styles.screen} hidden={screen !== "audio"}>
      <AudioSettingsPanel />
    </div>}
    {visited.includes("location") && <div className={styles.screen} hidden={screen !== "location"}>
      <ProfileLocationSettings ownerPublicId={ownerPublicId} visible={active && screen === "location"} privacy={locationPrivacy} />
    </div>}
    {visited.includes("appearance") && <section className={`${styles.screen} ${styles.appearanceCard}`} hidden={screen !== "appearance"} aria-labelledby="appearance-title">
      <h2 id="appearance-title"><Settings2 size={19} aria-hidden="true" />Внешний вид</h2>
      <div className={styles.appearanceSetting}>
        <label htmlFor="simple-view"><strong>Простой вид</strong><span>Знакомая кнопка без полянки. Вход в игру остаётся доступным.</span></label>
        <Switch id="simple-view" checked={simpleView} onCheckedChange={onSimpleViewChange} data-audio-cue="ui.click" />
      </div>
      <div className={styles.appearanceSetting}>
        <label htmlFor="section-guide-launcher"><strong>Кнопка «Что здесь делать?»</strong><span>Кнопка ручного запуска подсказок в разделах игры. Продолжение приостановленной подсказки доступно и со скрытой кнопкой.</span></label>
        <Switch id="section-guide-launcher" checked={showSectionGuideLauncher} onCheckedChange={setShowSectionGuideLauncher} data-audio-cue="ui.click" />
      </div>
      <WorldTapHintSetting owner={ownerPublicId} />
      <p className={styles.hint}>Настройки сохраняются на этом устройстве.</p>
    </section>}
  </div>;
}
