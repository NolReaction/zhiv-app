import { PlayerItemIcon } from "@/features/economy/ui/fishing/fish-discovery";
import { buildingLabels } from "./graph";
import styles from "./economy-workbench.module.css";

export const economyNumber = (value: number) => value.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
export function economyDuration(seconds: number | null) {
  if (seconds === null) return "Не определено";
  if (seconds <= 0) return "0 мин";
  const rounded = Math.ceil(seconds), days = Math.floor(rounded / 86400), hours = Math.floor(rounded % 86400 / 3600);
  const minutes = Math.floor(rounded % 3600 / 60), rest = rounded % 60;
  return [days ? `${days} дн.` : "", hours ? `${hours} ч` : "", minutes ? `${minutes} мин` : "", rest ? `${rest} с` : ""].filter(Boolean).join(" ");
}
export const stationName = (id: string) => id === "hero" ? "Мохлик" : buildingLabels[id] ?? id;
export const economySearch = (value: string) => value.toLocaleLowerCase("ru-RU").replaceAll("ё", "е").trim();

export function EconomyItemButton({ id, name, quantity, onSelect }: { id: string; name: string; quantity?: number; onSelect: (id: string) => void }) {
  return <button type="button" className={styles.itemChip} onClick={() => onSelect(id)}>
    <PlayerItemIcon itemId={id} size={21} /><span>{name}</span>{quantity !== undefined && <b>×{economyNumber(quantity)}</b>}
  </button>;
}

/** Quotes every cell, neutralizes spreadsheet formulas, and keeps exact numeric data. */
export function economyCsv(rows: readonly (readonly (string | number | null)[])[]) {
  return "\uFEFF" + rows.map(row => row.map(value => {
    let text = value === null ? "" : String(value);
    if (typeof value === "string" && /^[\s]*[=+@-]/u.test(text)) text = "'" + text;
    return `"${text.replaceAll('"', '""')}"`;
  }).join(";")).join("\r\n");
}

export function downloadEconomyFile(content: string, type: "csv" | "json", name: string) {
  const url = URL.createObjectURL(new Blob([content], { type: type === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url; link.download = `${name}.${type}`; document.body.append(link);
  try { link.click(); } finally { link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
