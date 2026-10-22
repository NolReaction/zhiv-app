"use client";

import { LocateFixed, MapPin, Square } from "lucide-react";
import { SharingSwitch } from "@/components/sharing-switch";
import { useEarthLocation } from "@/features/earth/use-earth-location";
import { useEarthLocationPreference } from "@/features/earth/use-location-preferences";
import type { EarthLocationState } from "@/features/earth/location";
import type { EarthSharingHandle } from "@/features/earth/earth-sharing-panel";
import styles from "./profile-location-settings.module.css";

export type LocationPrivacyState = Pick<EarthSharingHandle, "settings" | "pendingGhost" | "pendingPrivacyMode" | "error" | "off">;

export function ProfileLocationSettingsContent({ enabled, onEnabledChange, location, onLocate, onStop, privacy }: {
  enabled: boolean; onEnabledChange: (enabled: boolean) => void; location: EarthLocationState;
  onLocate: () => void; onStop: () => void; privacy?: LocationPrivacyState;
}) {
  const watching = location.status === "active" || location.status === "requesting";
  const accuracy = location.position ? location.position.accuracy >= 1_000
    ? `${(location.position.accuracy / 1_000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} км`
    : `${Math.max(1, Math.round(location.position.accuracy))} м` : null;
  const confirmedOff = privacy?.settings?.mode === "OFF" && !privacy.pendingGhost;
  return <section className={styles.card} aria-labelledby="profile-location-title">
    <h2 id="profile-location-title"><MapPin size={19} aria-hidden="true" />Геопозиция</h2>
    <div className={styles.setting}>
      <label htmlFor="profile-location-enabled"><strong>Использовать геопозицию</strong>
        <span>Разрешить приложению определять моё место на этом устройстве.</span></label>
      <SharingSwitch id="profile-location-enabled" checked={enabled} onCheckedChange={onEnabledChange} data-audio-cue="ui.click" />
    </div>
    {!enabled ? <div role="status" className={styles.notice}>
      <strong>Геопозиция выключена</strong>
      <p>Поиск и обновления остановлены. Частная точка на устройстве очищена.</p>
      <p>{confirmedOff ? "Доступ друзей к вашему месту закрыт." : "Закрываем доступ друзей. До подтверждения сервера им может быть доступно последнее место."}</p>
      {privacy?.error && <p className={styles.error}>{privacy.error}</p>}
      {privacy && !confirmedOff && <button type="button" onClick={privacy.off} data-audio-cue="ui.click">Повторить закрытие доступа</button>}
    </div> : <>
      <p className={styles.hint}>Включение этого переключателя не передаёт координаты друзьям. Доступ каждому выбирается отдельно в «Людях» или на карте.</p>
      <div className={styles.actions}>
        <button type="button" onClick={onLocate} disabled={location.status === "requesting"} data-audio-cue="ui.click">
          <LocateFixed size={17} aria-hidden="true" />{location.status === "requesting" ? "Определяем…" : "Проверить геопозицию"}
        </button>
        {watching && <button type="button" onClick={onStop} data-audio-cue="ui.click"><Square size={14} aria-hidden="true" />Остановить</button>}
      </div>
      <div role="status" className={styles.result}>
        {location.status === "requesting" ? "Ждём координаты от браузера…" : location.status === "active" && accuracy
          ? `${location.position!.accuracy > 1_000 ? "Примерное место" : "Место определено"} · точность ±${accuracy}`
          : location.error ? "Не удалось определить место." : "Проверка начнётся только после нажатия кнопки."}
        {location.error && <p className={styles.error}>{location.error.replaceAll("«Найти меня»", "«Проверить геопозицию»")}</p>}
      </div>
    </>}
    <details className={styles.details}>
      <summary>Как работает определение места</summary>
      <p>Открытая карта сама определяет ваше место, если геопозиция включена и призрак выключен. При первом запросе браузер спрашивает разрешение. В скрытой вкладке обновления останавливаются.</p>
      <p>Круг на карте показывает погрешность, которую сообщил браузер. Большой круг означает примерное место: его точность зависит от устройства, Wi-Fi и службы геолокации браузера.</p>
      <p>Если разрешение есть, а поиск не работает, проверьте доступ браузера в системных настройках местоположения. На Mac: «Конфиденциальность и безопасность» → «Службы геолокации».</p>
    </details>
  </section>;
}

export function ProfileLocationSettings({ ownerPublicId, visible, privacy }: {
  ownerPublicId: string; visible: boolean; privacy?: LocationPrivacyState;
}) {
  const preference = useEarthLocationPreference(ownerPublicId);
  const location = useEarthLocation({ ownerPublicId, enabled: visible, autoStart: false });
  return <ProfileLocationSettingsContent enabled={preference.enabled} onEnabledChange={preference.setEnabled}
    location={location} onLocate={location.locate} onStop={location.stop} privacy={privacy} />;
}
