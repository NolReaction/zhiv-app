"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { boatPhase } from "@/features/economy/domain/boat-fishing";
import { createEconomySession } from "@/features/economy/sync/session";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import { WorldBoatFishingDialog } from "@/features/economy/ui/boat/world-boat-fishing-dialog";
import { createBoatWorkshopDemo } from "./boat-workshop-demo";
import styles from "./boat-workshop-preview.module.css";

function WorkshopSession({ onReset }: { onReset: () => void }) {
  const [demo] = useState(() => {
    const started = performance.now(), daylight = Date.UTC(2026, 6, 14, 9);
    return createBoatWorkshopDemo({ now: () => daylight + Math.round(performance.now() - started) });
  });
  const session = useMemo(() => createEconomySession(demo.ownerPublicId, {
    get: async () => demo.read(), send: async command => demo.send(command), dev: async command => demo.dev(command),
    market: async () => { throw new Error("Рынок недоступен в демонстрации лодки."); },
    trade: async () => { throw new Error("Рынок недоступен в демонстрации лодки."); },
  }, () => {}), [demo]);
  const view = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [now, setNow] = useState(0), [open, setOpen] = useState(false);
  useEffect(() => {
    const deactivate = session.activate();
    void session.refresh();
    const clock = window.setInterval(() => { if (!document.hidden) setNow(session.now()); }, 1000);
    return () => { window.clearInterval(clock); deactivate(); };
  }, [session]);
  const economy: EconomyController = { ...view, ...session, now: now || session.now(), readServerNow: session.now };
  const snapshot = economy.snapshot;
  const phase = snapshot ? boatPhase(snapshot.boat, economy.now) : "broken";
  const phaseName = { broken: "Нужен ремонт", repairing: "Идёт работа", docked: "Лодка у причала", outbound: "Дорога к месту ловли",
    fishing: "Речная рыбалка", returning: "Обратная дорога", ready: "Лодка вернулась" }[phase];

  return <main className={styles.page} data-boat-workshop-preview>
    <header className={styles.header}><span className={styles.badge}>ДЕМО</span><h1>Лодочная мастерская</h1>
      <p>Пробный ремонт, улучшения и выход на реку. Этот пример не обращается к серверу и не меняет игровой профиль. Прогресс примера сбрасывается при перезагрузке страницы.</p>
      <nav aria-label="Переходы"><Link href="/prototype/boat-water">Проверка воды</Link><Link href="/prototype/boat-garage">Редактор лодки</Link><Link href="/">В игру</Link></nav>
    </header>
    <section className={styles.instructions} aria-labelledby="boat-demo-steps">
      <h2 id="boat-demo-steps">Как проверить полный выход</h2>
      <ol><li>Восстановите корпус обычной кнопкой. Монеты и материалы уже выданы этому примеру.</li>
        <li>Внутри окна раскройте «Лодка · тестовое управление» и нажмите «Завершить таймер установки», затем получите готовую работу.</li>
        <li>Проверьте запас бензина и отправьтесь на рыбалку. Кнопка расходует одну ячейку и открывает речной плёс.</li>
        <li>Забросьте удочку, дождитесь начала вываживания и проверьте удержание, отпускание и паузу. После поимки вернитесь в мастерскую и заберите улов.</li></ol>
      <p>На реке тестовое управление открывается кнопкой DEV. После закрытия окна можно открыть его снова или начать новый пример.</p>
      <p className={styles.status} role="status">{snapshot ? phaseName : "Готовим демонстрационную лодку…"}</p>
      <div className={styles.actions}><button type="button" onClick={() => setOpen(true)} disabled={!snapshot || open}>Открыть мастерскую</button>
        <button type="button" onClick={onReset} disabled={open}>Начать пример заново</button></div>
    </section>
    {open && snapshot && <WorldBoatFishingDialog sharedRecordsAvailable={false} economy={{ ...economy, snapshot }} onClose={() => setOpen(false)} timeZone="Europe/Moscow" />}
  </main>;
}

export function BoatWorkshopPreview() {
  const [revision, setRevision] = useState(0);
  return <WorkshopSession key={revision} onReset={() => setRevision(value => value + 1)} />;
}
