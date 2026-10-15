import { Check, Clock3, Hammer } from "lucide-react";
import type { EconomyView } from "@/features/economy/domain/model";

/** Opens the same construction review as other station headers; never starts work. */
export function WorldPantryUpgrade({ state, now, onUpgrade, className }: {
  state: EconomyView | null; now: number; onUpgrade: () => void; className?: string;
}) {
  if (!state) return null;
  const level = state.buildings.warehouse ?? 1;
  const target = state.catalog.buildings.find(building => building.id === "warehouse")?.levels.find(entry => entry.level === level + 1);
  const job = state.jobs.find(entry => entry.kind === "construction" && entry.targetId === "warehouse");
  if (!target && !job) return null;
  const ready = Boolean(job && now >= Date.parse(job.finishesAt));
  const Icon = job ? ready ? Check : Clock3 : Hammer;
  return <button type="button" className={className} data-guide-pantry-upgrade data-guide-station-upgrade="warehouse" aria-haspopup="dialog"
    aria-label={job ? ready ? "Завершить расширение кладовой" : "Ход расширения кладовой" : `Улучшить кладовую: ${level} → ${target!.level} уровень`} onClick={onUpgrade}>
    <Icon size={17} aria-hidden="true" /><span>{job ? ready ? "Готово" : "Стройка" : "Улучшить"}</span>
  </button>;
}
