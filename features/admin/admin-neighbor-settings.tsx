"use client";

import { useState } from "react";
import { economyCatalog } from "@/features/economy/domain/model";
import { neighborSettingsSchema, neighborStockItems, neighborWardrobeItems, type NeighborSettings } from "@/features/economy/domain/neighbor-model";
import { MochlikPortrait } from "@/features/mochlik/mochlik-portrait";
import { validAdminReason } from "./admin-input";
import styles from "./admin-neighbor-panel.module.css";

const numericFields: { key: keyof NeighborSettings; label: string; min: number; max?: number; step?: number }[] = [
  { key: "offerSlots", label: "Предложений в день", min: 0 },
  { key: "offerQuantity", label: "Предметов в предложении", min: 1 },
  { key: "sellPriceBps", label: "Цена лавки, базисные пункты", min: 0 },
  { key: "buyPriceBps", label: "Предел выкупа, базисные пункты", min: 0 },
  { key: "firstDelaySeconds", label: "Первая покупка: ожидание, секунд", min: 0 },
  { key: "staleAfterSeconds", label: "Залежавшийся лот: ожидание, секунд", min: 0 },
  { key: "activeFromHourUtc", label: "Начало работы, час UTC", min: 0, max: 23 },
  { key: "activeUntilHourUtc", label: "Конец работы, час UTC", min: 1, max: 24 },
  { key: "maxLotsPerDay", label: "Лотов у игрока в сутки", min: 0 },
  { key: "dailyBudgetCoins", label: "Бюджет на игрока, монет в сутки", min: 0 },
  { key: "maxLotCoins", label: "Предельная цена лота, монет", min: 0 },
  { key: "globalDailyBudgetCoins", label: "Общий бюджет, монет в сутки", min: 0 },
];
const equipmentLabels = { palette: "Окрас", head: "Головной убор", neck: "Шарф", rod: "Удочка на витрине" };
const itemName = (id: string) => economyCatalog.items.find(item => item.id === id)?.name ?? id;
const buildingName = (id: string) => economyCatalog.buildings.find(building => building.id === id)?.name ?? id;
const garmentName = (id: string | null) => neighborWardrobeItems.find(item => item.id === id)?.name ?? id ?? "Не выбрано";

export function AdminNeighborSettingsSummary({ settings }: { settings: NeighborSettings }) {
  return <dl className={styles.summary}>
    <div><dt>Персонаж мира</dt><dd>{settings.name} · berest</dd></div>
    <div><dt>Описание</dt><dd>{settings.description}</dd></div>
    <div><dt>Работа</dt><dd>{settings.enabled ? "Включён" : "Отключён"}; автоматический выкуп {settings.autoBuyEnabled ? "включён" : "на паузе"}</dd></div>
    <div><dt>Внешность</dt><dd>{Object.entries(equipmentLabels).map(([slot, label]) => `${label}: ${garmentName(settings.equipment[slot as keyof typeof equipmentLabels])}`).join(" · ")}</dd></div>
    <div><dt>Постройки</dt><dd>{Object.entries(settings.buildings).map(([id, level]) => `${buildingName(id)}: ${level}`).join(" · ")}</dd></div>
    <div><dt>Личная лавка</dt><dd>{settings.offerSlots} предложения по {settings.offerQuantity} шт. · {settings.allowedItemIds.map(itemName).join(", ")}</dd></div>
    <div><dt>Цены от базовой</dt><dd>Лавка {settings.sellPriceBps / 100}%; предел выкупа {settings.buyPriceBps / 100}%</dd></div>
    <div><dt>Расписание UTC</dt><dd>{settings.activeFromHourUtc}:00–{settings.activeUntilHourUtc}:00 · первая покупка через {settings.firstDelaySeconds} с · обычная через {settings.staleAfterSeconds} с</dd></div>
    <div><dt>Лимиты UTC-суток</dt><dd>На игрока: {settings.maxLotsPerDay} лота / {settings.dailyBudgetCoins} монет; за лот до {settings.maxLotCoins}; общий бюджет {settings.globalDailyBudgetCoins}</dd></div>
  </dl>;
}

export function AdminNeighborSettingsForm({ settings, disabled, onReview }: {
  settings: NeighborSettings; disabled: boolean; onReview: (settings: NeighborSettings, reason: string) => void;
}) {
  const [draft, setDraft] = useState(settings);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const change = <K extends keyof NeighborSettings>(key: K, value: NeighborSettings[K]) => setDraft(previous => ({ ...previous, [key]: value }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  function review() {
    const parsed = neighborSettingsSchema.safeParse(draft);
    if (!parsed.success) { setError(`Проверьте настройки: ${parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`); return; }
    if (!validAdminReason(reason)) { setError("Укажите причину от 8 до 240 символов."); return; }
    setError(""); onReview(parsed.data, reason.trim());
  }
  return <form onSubmit={event => { event.preventDefault(); review(); }} className={styles.stack}>
    <fieldset disabled={disabled} className={styles.fieldset}>
      <legend>Работа и оформление</legend>
      <div className={styles.checks}>
        <label><input type="checkbox" checked={draft.enabled} onChange={event => change("enabled", event.target.checked)} />Сосед и лавка включены</label>
        <label><input type="checkbox" checked={draft.autoBuyEnabled} onChange={event => change("autoBuyEnabled", event.target.checked)} />Автоматический выкуп включён</label>
      </div>
      <div className={styles.actions}><button type="button" className={styles.button}
        onClick={() => change("buildings", Object.fromEntries(economyCatalog.buildings.map(building => [building.id, Math.max(...building.levels.map(level => level.level))])))}>
        Максимальное поселение
      </button><p className={styles.hint}>Выставить все постройки на максимальный уровень. Применится после проверки и сохранения настроек.</p></div>
      <div className={styles.appearance}><MochlikPortrait appearance={draft.equipment} label={`Предпросмотр: ${draft.name}`} /><p className={styles.hint}>Предпросмотр внешности. Особые вещи Береста отмечены в списке; они принадлежат персонажу мира.</p></div>
      <div className={styles.grid}>
        <label className={styles.field}>Имя персонажа<input value={draft.name} maxLength={40} onChange={event => change("name", event.target.value)} /></label>
        <label className={styles.field}>Описание<textarea value={draft.description} maxLength={240} onChange={event => change("description", event.target.value)} /></label>
        {(Object.keys(equipmentLabels) as (keyof typeof equipmentLabels)[]).map(slot => <label className={styles.field} key={slot}>{equipmentLabels[slot]}
          <select value={draft.equipment[slot] ?? ""} onChange={event => change("equipment", { ...draft.equipment, [slot]: event.target.value || null })}>
            {slot !== "palette" && <option value="">Не выбрано</option>}
            {neighborWardrobeItems.filter(item => item.slot === slot).map(item => <option key={item.id} value={item.id}>{item.name}{item.id.startsWith("berest_") ? " · Особая вещь Береста" : ""}</option>)}
          </select>
        </label>)}
        {economyCatalog.buildings.map(building => <label key={building.id} className={styles.field}>{building.name}
          <select value={draft.buildings[building.id] ?? 0} onChange={event => change("buildings", { ...draft.buildings, [building.id]: Number(event.target.value) })}>
            {building.id !== "home" && <option value={0}>Не построено</option>}
            {building.levels.map(level => <option key={level.level} value={level.level}>Уровень {level.level}</option>)}
          </select>
        </label>)}
      </div>
    </fieldset>
    <fieldset disabled={disabled} className={styles.fieldset}>
      <legend>Лавка, цены и выкуп</legend>
      <p className={styles.hint}>10 000 базисных пунктов = 100%. Тарифы задаются напрямую: 0% делает поставку бесплатной. Округление и комиссию учитывает сервер. Выкуп также не превышает стоимость приобретения такого товара у других жителей, чтобы наживка и готовые поставки не давали монеты по кругу. Действующий ассортимент игрока сохраняется до следующего дня; запрещённый товар перестаёт продаваться.</p>
      {draft.sellPriceBps < draft.buyPriceBps && <p className={styles.hint}>Предел выкупа выше цены лавки: покупка сегодня и обратная продажа в другой день могут давать прибыль. Эти тарифы сохраняются по вашему решению.</p>}
      <div className={styles.grid}>{numericFields.map(field => <label key={field.key} className={styles.field}>{field.label}
        <input type="number" min={field.min} max={field.max} step={field.step ?? 1} value={Number.isNaN(draft[field.key]) ? "" : String(draft[field.key])}
          onChange={event => change(field.key, event.target.value === "" ? Number.NaN : Number(event.target.value))} />
      </label>)}</div>
      <p className={styles.hint}>0–24 означает весь день. Если начало позже конца, интервал проходит через полночь. Выручка продавца рассчитывается с обычной комиссией рынка. Выкуп ограничен одновременно ценой лота и оставшимися бюджетами, даже если предел цены выше бюджета.</p>
      <details><summary>Разрешённые товары ({draft.allowedItemIds.length})</summary><div className={styles.catalog}>
        {neighborStockItems.map(item => <label key={item.id}>
          <input type="checkbox" checked={draft.allowedItemIds.includes(item.id)} onChange={event => change("allowedItemIds", event.target.checked
            ? [...draft.allowedItemIds, item.id] : draft.allowedItemIds.filter(id => id !== item.id))} />{item.name}
        </label>)}
      </div></details>
    </fieldset>
    <label className={styles.field}>Причина изменения<textarea disabled={disabled} value={reason} minLength={8} maxLength={240} placeholder="Для внутреннего журнала, от 8 символов" onChange={event => setReason(event.target.value)} /></label>
    {error && <p className={styles.error} role="alert">{error}</p>}
    <div className={styles.actions}><button type="submit" className={styles.primaryButton} disabled={disabled || !dirty || !validAdminReason(reason)}>Проверить изменения</button>
      <button type="button" className={styles.button} disabled={disabled || !dirty} onClick={() => { setDraft(settings); setError(""); }}>Вернуть действующие</button></div>
  </form>;
}
