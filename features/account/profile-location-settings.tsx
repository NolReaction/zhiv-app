"use client";

import { LocateFixed, MapPin, Square } from "lucide-react";
import { useSyncExternalStore } from "react";
import { SharingSwitch } from "@/components/sharing-switch";
import { useEarthLocation } from "@/features/earth/use-earth-location";
import { useEarthLocationPreference } from "@/features/earth/use-location-preferences";
import type { EarthLocationState } from "@/features/earth/location";
import type { EarthSharingHandle } from "@/features/earth/earth-sharing-panel";
import { getClientPlatform } from "@/lib/client-platform";
import { backgroundLocationChoice } from "@/features/earth/native-publisher";
import styles from "./profile-location-settings.module.css";

export type LocationPrivacyState = Pick<EarthSharingHandle, "settings" | "pendingGhost" | "pendingPrivacyMode" | "error" | "off">;

export function ProfileLocationSettingsContent({ enabled, onEnabledChange, location, onLocate, onStop, privacy }: {
  enabled: boolean; onEnabledChange: (enabled: boolean) => void; location: EarthLocationState;
  onLocate: () => void; onStop: () => void; privacy?: LocationPrivacyState;
}) {
  const native = getClientPlatform();
  const background = useSyncExternalStore(backgroundLocationChoice.subscribe, backgroundLocationChoice.getSnapshot, backgroundLocationChoice.getServerSnapshot);
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
        {location.status === "requesting" ? native ? "Ждём координаты от телефона…" : "Ждём координаты от браузера…" : location.status === "active" && accuracy
          ? `${location.position!.accuracy > 1_000 ? "Примерное место" : "Место определено"} · точность ±${accuracy}`
          : location.error ? "Не удалось определить место." : "Проверка начнётся только после нажатия кнопки."}
        {location.error && <p className={styles.error}>{location.error.replaceAll("«Найти меня»", "«Проверить геопозицию»")}</p>}
      </div>
    </>}
    {background.available && <>
      <div className={styles.setting}>
        <label htmlFor="profile-location-background"><strong>Передавать при свёрнутом приложении</strong>
          <span>Продолжать уже включённый обмен с выбранными близкими, в том числе при заблокированном экране.</span></label>
        <SharingSwitch id="profile-location-background" checked={background.enabled} disabled={background.busy || !enabled}
          onCheckedChange={value => { void backgroundLocationChoice.setEnabled(value); }} data-audio-cue="ui.click" />
      </div>
      <p className={styles.hint}>Этот выбор не добавляет получателей и не продлевает доступ. Телефон показывает индикатор или уведомление. Принудительное закрытие и ограничения системы могут остановить передачу.</p>
      {background.error && <p className={styles.error} role="alert">{background.error}</p>}
    </>}
    <details className={styles.details}>
      <summary>Как работает определение места</summary>
      {native ? <>
        <p>Первый поиск начинается по нажатию «Найти меня» или «Проверить геопозицию». Разрешение запрашивает и хранит система телефона.</p>
        <p>Частный поиск работает в открытом приложении. Передача друзьям включается отдельно; продолжение при сворачивании разрешается переключателем выше.</p>
        <p>Точность зависит от условий приёма и выбранного системного разрешения. Изменить доступ можно в настройках этого приложения на телефоне.</p>
      </> : <>
      <p>Открытая карта сама определяет ваше место, если геопозиция включена и призрак выключен. При первом запросе браузер спрашивает разрешение. В скрытой вкладке обновления останавливаются.</p>
      <p>Разрешение хранит браузер. Если доступ выдан только на один сеанс или в настройках выбрано «Спрашивать», при следующем входе запрос может появиться снова.</p>
      <p>Круг на карте показывает погрешность, которую сообщил браузер. Большой круг означает примерное место: его точность зависит от устройства, Wi-Fi и службы геолокации браузера.</p>
      <p>Если разрешение есть, а поиск не работает, проверьте доступ браузера в системных настройках местоположения. На Mac: «Конфиденциальность и безопасность» → «Службы геолокации».</p>
      </>}
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
