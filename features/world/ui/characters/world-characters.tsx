"use client";

import { ArrowRight, LockKeyhole, PawPrint, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Dialog, DialogPortal, DialogOverlay, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { PleskPortrait } from "@/features/world/characters/plesk/plesk-portrait";
import { BuilderPortrait } from "@/features/world/characters/builder/builder-portrait";
import { LopukhPortrait } from "@/features/world/characters/lopukh/lopukh-portrait";
import { KamneshmygPortrait } from "@/features/world/characters/kamneshmyg/kamneshmyg-portrait";
import { LeaftailPortrait } from "@/features/world/characters/leaftail/leaftail-portrait";
import { WORLD_CHARACTERS, worldResidentAvailable, type WorldCharacterId, type WorldResidentId } from "@/features/world/characters/world-characters-model";
import styles from "./world-characters.module.css";

const portraits = { builder: BuilderPortrait, plesk: PleskPortrait, lopukh: LopukhPortrait, kamneshmyg: KamneshmygPortrait, leaftail: LeaftailPortrait };

/** Each card opens its resident conversation directly; locked residents explain their arrival. */
export function WorldCharacters({ open, onClose, onResident, quarryBuilt = false, onCloseAutoFocus, focusedCharacter }: {
  open: boolean; onClose: () => void; onResident: (id: WorldResidentId) => void; quarryBuilt?: boolean;
  onCloseAutoFocus: (event: Event) => void; focusedCharacter?: WorldCharacterId;
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
            <DialogDescription className={styles.description}>Загляните к знакомым жителям леса.</DialogDescription></div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Закрыть персонажей"><X size={22} aria-hidden="true" /></button>
        </header>
        <ul className={styles.grid} aria-label="Персонажи леса">
          {WORLD_CHARACTERS.map(character => {
            const available = worldResidentAvailable(character.id, quarryBuilt), Portrait = portraits[character.id];
            return <li key={character.id}>
              <button type="button" className={`${styles.card} ${available ? styles.available : styles.locked}`} data-world-character={character.id}
                aria-label={`${character.name}, ${character.role}. ${available ? "Открыть разговор" : "Придёт после постройки каменоломни"}`}
                aria-haspopup={available ? "dialog" : undefined} aria-disabled={!available || undefined}
                onClick={() => { if (available) onResident(character.id); }}>
                <span className={styles.stage}><Portrait animated={available} className={styles.portrait} /></span>
                <strong>{character.name}</strong><small>{character.role}</small>
                <span className={styles.visit}>{available ? <>Заглянуть <ArrowRight size={15} aria-hidden="true" /></> : <><LockKeyhole size={15} aria-hidden="true" />Постройте каменоломню</>}</span>
              </button>
            </li>;
          })}
        </ul>
      </DialogPrimitive.Content>
    </DialogPortal>
  </Dialog>;
}
