"use client";

import { useState } from "react";
import { FishRarityBadge, FISH_RARITY_LEVELS, FISH_RARITY_NAMES } from "@/features/economy/ui/fishing/fish-rarity";
import { fishingState } from "@/features/economy/domain/fishing";
import { economyCatalog, type EconomyView } from "@/features/economy/domain/model";
import { fishingDiagnostics, type FishingDiagnosticSelection } from "./fishing-diagnostics";
import styles from "./world-dev-fishing.module.css";

const number = (value: number) => value.toLocaleString("ru-RU", { maximumFractionDigits: 6 });
const percent = (value: number) => `${number(value * 100)}%`;
const factor = (value: number) => `×${number(value / 100)}`;

export function WorldDevFishing({ state }: { state?: EconomyView | null }) {
  const catalog = state?.catalog ?? economyCatalog, spec = catalog.fishing, current = fishingState(state ?? {});
  const [selection, setSelection] = useState<FishingDiagnosticSelection>(() => ({ rodId: current.equippedRodId,
    hookId: current.equippedHookId, baitId: current.equippedBaitId, routeId: spec?.routeIds[0] ?? "shore" }));
  const report = fishingDiagnostics(selection, catalog);
  if (!spec) return <p>В этом каталоге нет рыбалки.</p>;
  const routes = catalog.explorations.filter(route => spec.routeIds.includes(route.id));
  const name = (id: string) => catalog.items.find(item => item.id === id)?.name ?? id;
  return <div className={styles.root}>
    <p className={styles.note}>Все снасти доступны для сравнения. Выбор здесь не меняет экипировку и запасы.</p>
    <div className={styles.selectors}>
      <label>Удочка<select value={selection.rodId} onChange={event => setSelection({ ...selection, rodId: event.target.value })}>
        {spec.rods.map(rod => <option key={rod.id} value={rod.id}>{rod.name} · {FISH_RARITY_NAMES[rod.rarity]}</option>)}
      </select></label>
      <label>Крючок<select value={selection.hookId} onChange={event => setSelection({ ...selection, hookId: event.target.value })}>
        {spec.hooks.map(hook => <option key={hook.id} value={hook.id}>{hook.name} · {FISH_RARITY_NAMES[hook.rarity]}</option>)}
      </select></label>
      <label>Наживка<select value={selection.baitId ?? ""} onChange={event => setSelection({ ...selection, baitId: event.target.value || null })}>
        <option value="">Без наживки</option>{spec.baits.map(bait => <option key={bait.itemId} value={bait.itemId}>{name(bait.itemId)}</option>)}
      </select></label>
      <label>Маршрут<select value={selection.routeId} onChange={event => setSelection({ ...selection, routeId: event.target.value })}>
        {routes.map(route => <option key={route.id} value={route.id}>{route.name} · {number(route.seconds / 60)} мин</option>)}
      </select></label>
    </div>
    {report ? <FishingDiagnosticReport report={report} /> : <p role="status">Выберите набор из текущего каталога.</p>}
  </div>;
}

export function FishingDiagnosticReport({ report }: { report: NonNullable<ReturnType<typeof fishingDiagnostics>> }) {
  return <>
    <dl className={styles.summary} aria-label="Параметры похода">
      <div><dt>Рыб за поход</dt><dd>{number(report.totalFish)}</dd></div>
      <div><dt>Розыгрышей класса</dt><dd>{number(report.draws)}</dd></div>
      <div><dt>Классов доступно</dt><dd>{report.classes.filter(group => group.weight > 0).length} из {report.classes.length}</dd></div>
      <div><dt>Расход наживки</dt><dd>{report.bait ? "1 за поход" : "Нет"}</dd></div>
    </dl>
    <p className={styles.note}>Удочка задаёт шансы класса, крючок и наживка усиливают их. Затем предпочтения удочки и крючка распределяют виды внутри выпавшего класса.</p>
    <div className={styles.groups}>{FISH_RARITY_LEVELS.map(rarity => {
      const rows = report.rows.filter(row => row.rarity === rarity), group = report.classes.find(group => group.rarity === rarity);
      if (!rows.length || !group) return null;
      return <details key={rarity} className={styles.group}>
        <summary><FishRarityBadge rarity={rarity} /><span>{rows.length} {rows.length === 1 ? "вид" : "вида"}</span><strong>{percent(group.probability)}</strong></summary>
        <p className={styles.factors}>База удочки {percent(group.rodBasisPoints / 10_000)} · крючок {factor(group.hookFactor)} · наживка {factor(group.baitFactor)}</p>
        <div className={styles.fish} data-dev-fish-class={group.itemId}>
          <p className={styles.weight}>Вес класса: {group.rodBasisPoints} bps × {number(group.hookFactor / 100)} × {number(group.baitFactor / 100)} → {group.weight}</p>
          <p className={styles.weight}>Точная доля класса: {group.weight} / {group.totalWeight}</p>
          <dl className={styles.result}><div><dt>В среднем рыб класса за поход</dt><dd>{number(group.expectedCount)}</dd></div>
            <div><dt>Хотя бы одна рыба класса</dt><dd>{group.atLeastOne > 0 && group.atLeastOne < 1 ? "≈ " : ""}{percent(group.atLeastOne)}</dd></div></dl>
        </div>
        {rows.map(row => <article key={row.itemId} className={styles.fish} data-dev-fish={row.itemId}>
          <header><strong>{row.name}</strong><b>{percent(row.probability)}</b></header>
          {!row.reason && <p className={styles.weight}>Шанс вида: {percent(group.probability)} × {row.speciesWeight} / {row.speciesTotal} билетов внутри класса</p>}
          {row.reason && <p className={styles.lock}>{row.reason === "legendary_tackle" ? "Нужна легендарная удочка. Крючок и наживка сами не открывают этот класс." : "Эта удочка не ловит этот класс. Нужна подходящая удочка."}</p>}
          <dl className={styles.result}><div><dt>В среднем за поход</dt><dd>{number(row.expectedCount)}</dd></div>
            <div><dt>Хотя бы одна за поход</dt><dd>{row.atLeastOne > 0 && row.atLeastOne < 1 ? "≈ " : ""}{percent(row.atLeastOne)}</dd></div></dl>
        </article>)}
      </details>;
    })}</div>
    <details className={styles.formula}><summary>Формула и смысл чисел</summary>
      <p>Вес класса: floor(базовые bps удочки × множитель крючка × множитель наживки). 100 bps = 1%. Множители уже разделены на 100. Нулевая база остаётся нулевой; легендарный класс открывает только легендарная удочка.</p>
      <p>p класса = вес / сумма весов; p вида = p класса × билеты вида / сумму билетов внутри класса. Билеты вида = предпочтение удочки × предпочтение крючка; без предпочтений все виды равны. Средний улов: {report.draws} × p. Шанс хотя бы одной: 1 − (1 − p)<sup>{report.draws}</sup>. Добавление вида не меняет шанс класса.</p>
      <p>Вероятность за поход рассчитана по модели отдельных случайных попыток. Реальный результат заранее сохраняется сервером по закрытому seed; отмена не даёт нового броска. Дробный средний улов показывает ожидание на множестве походов.</p>
    </details>
  </>;
}
