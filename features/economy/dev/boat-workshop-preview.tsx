"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { Dialog } from "radix-ui";
import { ArrowLeft } from "lucide-react";
import { AudioProvider } from "@/features/audio/ui/audio-provider";
import { useEconomyAudioFeedback } from "@/features/economy/integration/use-economy-audio-feedback";
import { WorldPantryMenu } from "@/features/economy/ui/inventory/world-pantry-menu";
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
  const [now, setNow] = useState(0), [surface, setSurface] = useState<"workshop" | "pantry" | null>(null);
  useEffect(() => {
    const deactivate = session.activate();
    void session.refresh();
    const clock = window.setInterval(() => { if (!document.hidden) setNow(session.now()); }, 1000);
    return () => { window.clearInterval(clock); deactivate(); };
  }, [session]);
  const economy: EconomyController = { ...view, ...session, now: now || session.now(), readServerNow: session.now };
  useEconomyAudioFeedback(economy);
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
      <ol><li>Восстановите первый корпус бесплатно. Лодка сразу готова к выходу.</li>
        <li>Откройте DEV в шапке мастерской. Выберите модуль и установите уровень или выдайте монеты, чтобы проверить покупку обычной кнопкой.</li>
        <li>Нажмите «Отправиться на рыбалку», проверьте снасти и подтвердите выход. На это уйдёт одна ячейка бензина.</li>
        <li>Зажмите воду или пробел и отпустите, когда метка попадёт в зелёную зону. Когда поплавок нырнёт, нажмите снова. Удерживайте и отпускайте снасть, чтобы вести рыбу к лодке. После поимки вернитесь в мастерскую и заберите улов.</li></ol>
      <p>На реке тестовое управление открывается кнопкой DEV. После закрытия окна можно открыть его снова или начать новый пример.</p>
      <p className={styles.status} role="status">{snapshot ? phaseName : "Готовим демонстрационную лодку…"}</p>
      <div className={styles.actions}><button type="button" onClick={() => setSurface("workshop")} disabled={!snapshot || Boolean(surface)}>Открыть мастерскую</button>
        <button type="button" onClick={onReset} disabled={Boolean(surface)}>Начать пример заново</button></div>
    </section>
    {surface === "workshop" && snapshot && <WorldBoatFishingDialog sharedRecordsAvailable={false} economy={{ ...economy, snapshot }} onClose={() => setSurface(null)} onOpenPantry={() => setSurface("pantry")} timeZone="Europe/Moscow" />}
    {surface === "pantry" && <Dialog.Root open onOpenChange={value => { if (!value) setSurface("workshop"); }}><Dialog.Portal>
      <Dialog.Overlay className={styles.pantryBackdrop} />
      <Dialog.Content className={styles.pantry} aria-describedby={undefined}>
        <header><Dialog.Title>Кладовая</Dialog.Title><Dialog.Close asChild><button type="button"><ArrowLeft size={15} />К улову</button></Dialog.Close></header>
        <WorldPantryMenu economy={economy} onExplore={() => setSurface("workshop")} />
      </Dialog.Content>
    </Dialog.Portal></Dialog.Root>}
  </main>;
}

export function BoatWorkshopPreview() {
  const [revision, setRevision] = useState(0);
  return <AudioProvider><WorkshopSession key={revision} onReset={() => setRevision(value => value + 1)} /></AudioProvider>;
}
