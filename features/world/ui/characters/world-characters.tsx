"use client";

import { ArrowRight, Heart, LockKeyhole, PawPrint, Sparkles, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Dialog, DialogPortal, DialogOverlay, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { PleskPortrait } from "@/features/world/characters/plesk/plesk-portrait";
import { BuilderPortrait } from "@/features/world/characters/builder/builder-portrait";
import { LopukhPortrait } from "@/features/world/characters/lopukh/lopukh-portrait";
import { KamneshmygPortrait } from "@/features/world/characters/kamneshmyg/kamneshmyg-portrait";
import { LeaftailPortrait } from "@/features/world/characters/leaftail/leaftail-portrait";
import { WORLD_CHARACTERS, worldResidentAvailable, type WorldCharacterId, type WorldResidentId } from "@/features/world/characters/world-characters-model";
import type { EconomyView } from "@/features/economy/domain/model";
import { tradeRelationProgress } from "@/features/economy/domain/trade-relations";
import { orderReputationBenefit } from "@/features/economy/ui/orders/order-reputation-presentation";
import styles from "./world-characters.module.css";

const portraits = { builder: BuilderPortrait, plesk: PleskPortrait, lopukh: LopukhPortrait, kamneshmyg: KamneshmygPortrait, leaftail: LeaftailPortrait };
const benefitLabels = { builder: "Стройка", lopukh: "Лесной участок", kamneshmyg: "Добыча", plesk: "Снасти и наживка", leaftail: "Снасти, наживка, одежда" };

function FriendshipBenefit({ residentId, bonusBps, description }: { residentId: WorldResidentId; bonusBps: number; description: string }) {
  const words = benefitLabels[residentId].split(" ");
  const lastWord = words.pop();
  const percent = Math.min(10, Math.max(0, bonusBps / 100));
  const isDiscount = residentId === "plesk" || residentId === "leaftail";
  const value = `${isDiscount ? percent > 0 ? "-" : "" : "+"}${percent.toLocaleString("ru-RU")}%`;
  return <span className={styles.friendshipBenefit} title={description}>
    <Sparkles size={13} aria-hidden="true" />{words.length > 0 && `${words.join(" ")} `}
    <span className={styles.benefitTail}>{lastWord} <span className={styles.benefitValue}>{value}</span></span>
  </span>;
}

/** A shared silhouette leaves the next resident's appearance a surprise. */
function UnknownResident() {
  return <svg className={styles.silhouette} viewBox="0 0 160 160" aria-hidden="true" focusable="false">
    <ellipse cx="80" cy="144" rx="43" ry="7" className={styles.shadow} />
    <path d="M42 123c0-25 14-40 38-40s38 15 38 40v12H42z" />
    <path d="M47 47c-11-25 16-35 25-12h16c9-23 36-13 25 12a39 39 0 1 1-66 0" />
    <text x="80" y="90" textAnchor="middle">?</text>
  </svg>;
}

/** Only introduced residents expose their portrait, name and conversation. */
export function WorldCharacters({ open, onClose, onResident, quarryBuilt = false, lopukhAvailable = false, lopukhUnlocked = false, leaftailAvailable = false, leaftailUnlocked = false, onCloseAutoFocus, focusedCharacter, economy }: {
  open: boolean; onClose: () => void; onResident: (id: WorldResidentId) => void; quarryBuilt?: boolean; lopukhAvailable?: boolean; lopukhUnlocked?: boolean;
  leaftailAvailable?: boolean; leaftailUnlocked?: boolean;
  onCloseAutoFocus: (event: Event) => void; focusedCharacter?: WorldCharacterId; economy?: EconomyView | null;
}) {
  return <Dialog open={open} onOpenChange={next => { if (!next) onClose(); }}>
    <DialogPortal>
      <DialogOverlay className={styles.scrim} />
      <DialogPrimitive.Content data-slot="dialog-content" className={styles.dialog}
        onCloseAutoFocus={onCloseAutoFocus} onOpenAutoFocus={event => {
          const gallery = event.target as HTMLElement;
          const card = (focusedCharacter && gallery.querySelector<HTMLButtonElement>(`button[data-world-character="${focusedCharacter}"]`))
            || gallery.querySelector<HTMLButtonElement>("button[data-world-character]");
          if (card) { event.preventDefault(); card.focus({ preventScroll: true }); }
        }}>
        <header className={styles.header}>
          <div><DialogTitle className={styles.title}><PawPrint size={22} aria-hidden="true" />Персонажи</DialogTitle>
            <DialogDescription className={styles.description}>Знакомства и дружба в лесу</DialogDescription></div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Закрыть персонажей"><X size={22} aria-hidden="true" /></button>
        </header>
        <ul className={styles.grid} aria-label="Персонажи леса">
          {WORLD_CHARACTERS.map(character => {
            const available = worldResidentAvailable(character.id, quarryBuilt, leaftailAvailable, lopukhAvailable), Portrait = portraits[character.id];
            const relationship = available && economy ? tradeRelationProgress(economy, character.id, economy.catalog) : null;
            const remaining = relationship ? Math.max(0, relationship.requiredXp - relationship.progressXp) : 0;
            const friendshipHint = relationship?.nextRank ? `Ещё ${remaining.toLocaleString("ru-RU")} до «${relationship.nextRank.name}»` : "Высший ранг дружбы";
            const benefit = relationship ? orderReputationBenefit(character.id, relationship.bonusBps) : "";
            const friendshipLabel = relationship ? ` Дружба: ${relationship.rank.name}, ${relationship.xp.toLocaleString("ru-RU")} очков. ${friendshipHint}. ${benefit}.` : "";
            const arrivalHint = character.id === "lopukh" ? lopukhUnlocked ? "Дождитесь прибытия" : "Откройте лесной участок"
              : character.id === "kamneshmyg" ? "Постройте каменоломню"
              : leaftailUnlocked ? "Дождитесь прибытия" : "Дом 3-го уровня";
            return <li key={character.id}>
              <button type="button" className={`${styles.card} ${available ? styles.available : styles.locked}`} data-world-character={character.id}
                data-friendship-rank={relationship ? relationship.rankIndex + 1 : undefined}
                aria-label={available ? `${character.name}, ${character.role}.${friendshipLabel} Открыть разговор` : `Незнакомый житель. ${arrivalHint}`}
                aria-haspopup={available ? "dialog" : undefined} aria-disabled={!available || undefined}
                onClick={() => { if (available) onResident(character.id); }}>
                <span className={styles.stage}>{available ? <Portrait animated className={styles.portrait} /> : <UnknownResident />}</span>
                <span className={styles.identity}><strong>{available ? character.name : "Незнакомый житель"}</strong><small>{available ? character.role : "Вы ещё не встречались"}</small></span>
                {relationship && <span className={styles.relationship} data-resident-reputation={character.id} data-rank={relationship.rankIndex + 1}>
                  <span className={styles.friendshipHeading}><Heart size={14} aria-hidden="true" /><span>{relationship.rank.name}</span></span>
                  <span className={styles.friendshipTrack} aria-hidden="true"><span style={{ width: `${relationship.nextRank ? Math.min(100, Math.max(0, relationship.progressXp / Math.max(1, relationship.requiredXp) * 100)) : 100}%` }} /></span>
                  <span className={styles.friendshipHint}>{friendshipHint}</span>
                  <FriendshipBenefit residentId={character.id} bonusBps={relationship.bonusBps} description={benefit} />
                </span>}
                <span className={styles.visit}>{available ? <>Заглянуть <ArrowRight size={15} aria-hidden="true" /></> : <><LockKeyhole size={15} aria-hidden="true" />{arrivalHint}</>}</span>
              </button>
            </li>;
          })}
        </ul>
      </DialogPrimitive.Content>
    </DialogPortal>
  </Dialog>;
}
