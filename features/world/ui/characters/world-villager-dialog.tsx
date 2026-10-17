"use client";

import { ArrowLeft, ArrowRight, Axe, Pickaxe, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Dialog, DialogPortal, DialogOverlay, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import { WorldLeaftailMarket } from "@/features/economy/ui/market/world-leaftail-market";
import { ResidentSpeech } from "@/features/world/characters/social/forest-speech";
import { LopukhPortrait } from "@/features/world/characters/lopukh/lopukh-portrait";
import { KamneshmygPortrait } from "@/features/world/characters/kamneshmyg/kamneshmyg-portrait";
import { LeaftailPortrait } from "@/features/world/characters/leaftail/leaftail-portrait";
import styles from "./world-villager-dialog.module.css";

export type NewVillagerId = "lopukh" | "kamneshmyg" | "leaftail";
const villagers = {
  lopukh: { name: "Лопоух", role: "Весёлый лесоруб", Portrait: LopukhPortrait,
    greeting: "Я тут за дровами сбегал. Точнее, допрыгал! Если нужен лес для стройки, заглядывай ко мне.",
    description: "Заготовка древесины идёт на лесном участке. Запусти работу, а когда она закончится, забери брёвна в кладовую." },
  kamneshmyg: { name: "Камнешмыг", role: "Шахтёр и знаток камня", Portrait: KamneshmygPortrait,
    greeting: "Слышу, каменоломню открыли? Вот и я. Хороший камень сам в кладовую не придёт, а я помогу с добычей!",
    description: "Выбери добычу в каменоломне — я зайду работать в пещеру. Когда смена закончится, выйду прогуляться. Готовые материалы забери в кладовую." },
  leaftail: { name: "Листохвост", role: "Торговец находками", Portrait: LeaftailPortrait,
    greeting: "Чего только не встречается в дороге! Хорошие находки берегу для тех, кто строит всерьёз.",
    description: "Находки храню в своём домике. Если меня нет на тропе, лавка всё равно открыта: выбирай вещь и проверь цену." },
};

/** The live resident and his useful action share one conversation. */
export function WorldVillagerDialog({ id, open, ownerPublicId, economy, isOnline, quarryBuilt, onClose, onBack, onCloseAutoFocus, onOpenStation }: {
  id: NewVillagerId; open: boolean; ownerPublicId: string; economy: EconomyController; isOnline: boolean; quarryBuilt: boolean;
  onClose: () => void; onBack?: () => void; onCloseAutoFocus: (event: Event) => void; onOpenStation: (stationId: string) => void;
}) {
  const { name, role, Portrait, greeting, description } = villagers[id];
  const currentOwner = economy.snapshot?.ownerPublicId === ownerPublicId;
  const available = id !== "kamneshmyg" || quarryBuilt;
  return <Dialog open={open} onOpenChange={next => { if (!next) onClose(); }}>
    <DialogPortal>
      <DialogOverlay className={styles.scrim} />
      <DialogPrimitive.Content data-slot="dialog-content" data-world-villager={id} className={styles.dialog} onCloseAutoFocus={onCloseAutoFocus}>
        {onBack && <button type="button" className={styles.back} onClick={onBack}><ArrowLeft size={16} aria-hidden="true" />К персонажам</button>}
        <header className={styles.header}>
          <Portrait animated className={styles.emblem} />
          <div><DialogTitle className={styles.name}>{name}</DialogTitle><DialogDescription className={styles.role}>{role}</DialogDescription></div>
          <button type="button" className={styles.close} onClick={onClose} aria-label={`Попрощаться: ${name}`}><X size={20} aria-hidden="true" /></button>
        </header>
        <div className={styles.body} data-resident-scroll>
          <ResidentSpeech owner={ownerPublicId} speaker={id} />
          {!available ? <p className={styles.greeting}>Камнешмыг придёт, когда вы построите каменоломню и подтвердите завершение у Шишколапа.</p> : <>
            <p className={styles.greeting}>«{greeting}»</p>
            {id === "leaftail" ? currentOwner ? <WorldLeaftailMarket key={ownerPublicId} economy={economy} isOnline={isOnline} introduced /> : <p role="status">Проверяем запасы текущего игрока…</p> : <>
              <p className={styles.description}>{description}</p>
              <button type="button" className={styles.action} disabled={!currentOwner} onClick={() => onOpenStation(id === "lopukh" ? "woodlot" : "quarry")}>
                {id === "lopukh" ? <Axe size={18} aria-hidden="true" /> : <Pickaxe size={18} aria-hidden="true" />}
                {id === "lopukh" ? "За древесиной" : "К добыче"}<ArrowRight size={17} aria-hidden="true" />
              </button>
            </>}
          </>}
        </div>
      </DialogPrimitive.Content>
    </DialogPortal>
  </Dialog>;
}
