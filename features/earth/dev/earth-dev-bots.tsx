"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Bot, MapPin, RefreshCw, X } from "lucide-react";
import { useDevBots, type DevBotsController } from "@/features/world/dev/use-dev-bots";
import type { DevBot, DevBotAction } from "@/features/world/dev/dev-bot-model";
import type { EarthPosition } from "../location";
import { moveBotPosition, nearbyBotPosition, parseBotPosition, type BotPosition } from "./bot-position";
import styles from "./earth-dev-bots.module.css";

type Props = {
  ownerPublicId: string; online: boolean; commandsAvailable: boolean; position: EarthPosition | null;
  readCenter: () => { latitude: number; longitude: number } | null;
  onChanged: () => void; onFocus: (circleId: string) => void;
  otherPanelOpen?: boolean; onOpen?: () => void;
};
type Command = (action: DevBotAction) => Promise<void>;
const stamp = (value: string | null) => value ? new Date(value).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "ещё нет";

export function EarthDevBotControls({ bot, disabled, now, position, readCenter, command, onFocus }: {
  bot: DevBot; disabled: boolean; now: number; position: EarthPosition | null;
  readCenter: Props["readCenter"]; command: Command; onFocus: Props["onFocus"];
}) {
  const point = bot.earth.position;
  const pointKey = point ? `${point.latitude}:${point.longitude}:${point.accuracyMeters}` : "none";
  const confirmedDraft = { source: pointKey, latitude: point ? String(point.latitude) : "", longitude: point ? String(point.longitude) : "", accuracy: String(point?.accuracyMeters ?? 20) };
  const [draft, setDraft] = useState(confirmedDraft);
  if (draft.source !== pointKey) setDraft(confirmedDraft);
  const { latitude, longitude, accuracy } = draft;
  const [localError, setLocalError] = useState<string | null>(null);
  const parsed = parseBotPosition(latitude, longitude, accuracy);
  const wait = bot.earth.nextPublishAt ? Math.max(0, Math.ceil((Date.parse(bot.earth.nextPublishAt) - now) / 1000)) : 0;
  const movingDisabled = disabled || bot.earth.mode === "SHARING" && wait > 0;
  const nearby = nearbyBotPosition(position, now);
  const put = (next: BotPosition | null) => {
    if (!next || movingDisabled) return;
    const valid = parseBotPosition(String(next.latitude), String(next.longitude), String(next.accuracyMeters));
    if (!valid) { setLocalError("Проверь координаты и погрешность."); return; }
    setLocalError(null);
    setDraft({ source: pointKey, latitude: String(Number(valid.latitude.toFixed(6))), longitude: String(Number(valid.longitude.toFixed(6))), accuracy: String(valid.accuracyMeters) });
    void command({ action: "set_earth_position", botId: bot.id, ...valid });
  };
  const setMode = (mode: "OFF" | "SHARING" | "GHOST") => {
    if (!disabled && (mode !== "SHARING" || point)) void command({ action: "set_earth_sharing", botId: bot.id, mode, precision: bot.earth.precision, durationMinutes: 60 });
  };
  const checkInWait = bot.lastCheckInAt ? Math.max(0, Math.ceil((Date.parse(bot.lastCheckInAt) + 30_000 - now) / 1000)) : 0;
  return <div className={styles.tools}>
    {localError && <p role="alert" className={styles.error}>{localError}</p>}
    <div className={styles.modes} role="group" aria-label="Геопозиция бота">
      <button type="button" data-audio-cue="ui.click" aria-pressed={bot.earth.mode === "SHARING"} disabled={disabled || !point}
        onClick={() => setMode("SHARING")}>Обновлять</button>
      <button type="button" data-audio-cue="ui.click" aria-pressed={bot.earth.mode === "GHOST"} disabled={disabled}
        onClick={() => setMode("GHOST")}>Призрак</button>
      <button type="button" data-audio-cue="ui.click" aria-pressed={bot.earth.mode === "OFF"} disabled={disabled}
        onClick={() => setMode("OFF")}>Убрать</button>
    </div>
    <p className={styles.hint}>{bot.earth.mode === "GHOST" ? "Друг видит прежнее место. Передвижение ниже меняет только тестовый GPS."
      : bot.earth.mode === "OFF" ? "Геопозиция закрыта. Поставь бота, затем нажми «Обновлять»."
        : wait > 0 ? `Следующее обновление через ${wait} с` : "Точка обновится после передвижения."}</p>
    <div className={styles.actions}>
      <button type="button" data-audio-cue="ui.click" disabled={movingDisabled} onClick={() => {
        if (movingDisabled) return;
        const center = readCenter(); if (center) put({ ...center, accuracyMeters: 20 }); else setLocalError("Дождись загрузки карты и повтори.");
      }}>В центре карты</button>
      <button type="button" data-audio-cue="ui.click" disabled={movingDisabled || !nearby} onClick={() => put(nearbyBotPosition(position, Date.now()))}>Рядом со мной</button>
    </div>
    {!nearby && <p className={styles.hint}>Для «Рядом со мной» сначала нажми «Найти меня».</p>}
    <div className={styles.steps} role="group" aria-label="Передвинуть тестовый GPS на 100 метров">
      {([{ title: "На север", arrow: "↑", bearing: 0 }, { title: "На запад", arrow: "←", bearing: 270 },
        { title: "На юг", arrow: "↓", bearing: 180 }, { title: "На восток", arrow: "→", bearing: 90 }]).map(step =>
        <button key={step.bearing} type="button" data-audio-cue="ui.click" aria-label={`${step.title} на 100 метров`}
          disabled={movingDisabled || !point} onClick={() => point && put(moveBotPosition(point, step.bearing))}>{step.arrow}</button>)}
      <span>100 м</span>
    </div>
    <details className={styles.coordinates}>
      <summary>Координаты и точность</summary>
      <form onSubmit={(event: FormEvent) => { event.preventDefault(); put(parsed); }}>
        <div className={styles.fields}>
          <label>Широта<input inputMode="decimal" value={latitude} disabled={disabled} onChange={event => setDraft({ ...draft, latitude: event.target.value })} /></label>
          <label>Долгота<input inputMode="decimal" value={longitude} disabled={disabled} onChange={event => setDraft({ ...draft, longitude: event.target.value })} /></label>
          <label>Погрешность, м<input inputMode="decimal" value={accuracy} disabled={disabled} onChange={event => setDraft({ ...draft, accuracy: event.target.value })} /></label>
        </div>
        <button type="submit" data-audio-cue="ui.click" disabled={movingDisabled || !parsed}>Поставить по координатам</button>
      </form>
      <div className={styles.actions} role="group" aria-label="Точность передачи бота">
        {(["PRECISE", "APPROXIMATE"] as const).map(precision => <button type="button" data-audio-cue="ui.click" key={precision}
          aria-pressed={bot.earth.precision === precision} disabled={disabled || bot.earth.mode !== "SHARING" || bot.earth.precision === precision}
          onClick={() => { if (!disabled && bot.earth.mode === "SHARING" && bot.earth.precision !== precision)
            void command({ action: "set_earth_sharing", botId: bot.id, mode: "SHARING", precision, durationMinutes: 60 }); }}>
          {precision === "PRECISE" ? "Точно" : "Примерный район"}</button>)}
      </div>
    </details>
    <div className={styles.shared}>
      <span>Точка на карте: {stamp(bot.earth.sharedUpdatedAt)}</span>
      <button type="button" data-audio-cue="ui.click" disabled={!bot.earth.sharedUpdatedAt || disabled}
        onClick={() => { if (!disabled && bot.earth.sharedUpdatedAt) onFocus(bot.circleId); }}><MapPin size={16} aria-hidden="true" />Показать</button>
    </div>
    <section className={styles.checkIn} aria-label="Отметка тестового друга">
      <span>«Я живой»: {stamp(bot.lastCheckInAt)}</span>
      <button type="button" data-audio-cue="ui.click" disabled={disabled || checkInWait > 0}
        onClick={() => { if (!disabled && checkInWait === 0) void command({ action: "check_in", botId: bot.id }); }}>Отметиться{checkInWait > 0 ? ` · ${checkInWait} с` : ""}</button>
    </section>
  </div>;
}

export function EarthDevBotsContent({ controller, online, commandsAvailable, position, readCenter, onChanged, onFocus, now }: Omit<Props, "ownerPublicId"> & {
  controller: DevBotsController; now: number;
}) {
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("Тестовый друг");
  const bots = controller.snapshot?.bots ?? [], bot = bots.find(item => item.id === selected) ?? bots[0];
  const disabled = !online || !commandsAvailable || controller.busy || controller.loading || controller.uncertain || !controller.snapshot;
  const command: Command = async action => {
    if (disabled) return;
    const result = await controller.command(action);
    if (result) { if (action.action === "create") setSelected(result.botId); onChanged(); }
  };
  return <>
    <p className={styles.hint}>Тестовые друзья этого локального аккаунта.</p>
    {!commandsAvailable && <p role="status" className={styles.hint}>Для управления ботами нужна активная сессия приложения.</p>}
    {(controller.loading || controller.busy) && <p role="status" className={styles.hint}>{controller.busy ? "Применяем…" : "Загружаем…"}</p>}
    {controller.error && <p role="alert" className={styles.error}>{controller.error}</p>}
    {controller.notice && <p role="status" className={styles.hint}>{controller.notice}</p>}
    {controller.uncertain && <button type="button" data-audio-cue="ui.click" disabled={controller.busy || !online || !commandsAvailable}
      onClick={async () => { if (!controller.busy && online && commandsAvailable && await controller.retry()) onChanged(); }}>Проверить прежнюю команду</button>}
    {bots.length > 0 && <label className={styles.select}>Друг<select value={bot.id} disabled={disabled} onChange={event => setSelected(event.target.value)}>
      {bots.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}
    </select></label>}
    {bot && <EarthDevBotControls key={bot.id} bot={bot} disabled={disabled} now={now} position={position} readCenter={readCenter} command={command} onFocus={onFocus} />}
    {bots.length < (controller.snapshot?.maxBots ?? 5) && <details open={!bots.length} className={styles.coordinates}>
      <summary>Добавить тестового друга</summary>
      <form onSubmit={event => { event.preventDefault(); if (!disabled && name.trim()) void command({ action: "create", displayName: name.trim(), homeLevel: 1 }); }}>
        <label>Имя<input maxLength={50} value={name} disabled={disabled} onChange={event => setName(event.target.value)} /></label>
        <button type="submit" data-audio-cue="ui.click" disabled={disabled || !name.trim()}>Создать друга</button>
      </form>
    </details>}
    <button type="button" className={styles.refresh} data-audio-cue="ui.click" disabled={!online || controller.busy || controller.loading}
      onClick={async () => { if (!online || controller.busy || controller.loading) return; await controller.refresh(); onChanged(); }}><RefreshCw size={15} aria-hidden="true" />Обновить</button>
  </>;
}

export function EarthDevBots(props: Props) {
  const [open, setOpen] = useState(false);
  if (open && props.otherPanelOpen) setOpen(false);
  const [now, setNow] = useState(() => Date.now());
  const button = useRef<HTMLButtonElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const controller = useDevBots(props.ownerPublicId, open);
  useEffect(() => {
    if (!open) return;
    heading.current?.focus({ preventScroll: true });
    const timer = setInterval(() => { if (!document.hidden) setNow(Date.now()); }, 1000);
    return () => clearInterval(timer);
  }, [open]);
  const close = () => { setOpen(false); button.current?.focus({ preventScroll: true }); };
  return <div className={styles.root}>
    <button ref={button} type="button" className={styles.trigger} data-audio-cue={open ? "ui.close" : "ui.open"}
      aria-expanded={open} aria-controls="earth-dev-bots" onClick={() => { if (!open) props.onOpen?.(); setNow(Date.now()); setOpen(value => !value); }}><Bot size={16} aria-hidden="true" />DEV Боты</button>
    {open && <section id="earth-dev-bots" className={styles.panel} aria-labelledby="earth-dev-bots-title"
      onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}>
      <header><h2 id="earth-dev-bots-title" ref={heading} tabIndex={-1}>Друзья для теста</h2>
        <button type="button" data-audio-cue="ui.close" onClick={close} aria-label="Закрыть тестовых друзей"><X size={18} aria-hidden="true" /></button></header>
      <EarthDevBotsContent {...props} controller={controller} now={now} onFocus={circleId => { close(); props.onFocus(circleId); }} />
    </section>}
  </div>;
}
