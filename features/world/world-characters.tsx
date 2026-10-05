"use client";

import { ChevronDown, PawPrint } from "lucide-react";
import { PleskPortrait } from "./plesk-portrait";
import { WORLD_CHARACTERS, worldCharacterResident, type WorldCharacter } from "./world-characters-model";
import styles from "./world-characters.module.css";

const silhouettes = {
  spines: "M17 74 10 64 14 57 8 46 16 44 13 31 26 34 27 22 38 27 46 17 53 27 65 24 67 35C79 38 88 47 88 62C88 72 81 77 75 79L79 86H62L57 81H39L34 86H18L23 80Z",
  ears: "M32 42C24 31 20 13 25 6C31 1 38 19 40 33C47 15 58 11 68 17L75 28C68 29 60 22 57 28L51 40C66 43 74 52 73 64C70 71 65 73 63 78L71 85H51L46 80L38 84H21L26 77C18 73 18 66 23 61C21 54 24 46 32 42Z",
  round: "M19 73C12 63 14 49 20 38C25 27 38 21 50 22C63 22 74 29 78 40L87 46L81 52C84 64 80 73 71 79L76 85H59L54 81H38L31 85H16L22 79Z",
  tail: "M37 75C11 68 4 43 10 16C19 9 37 17 40 33C43 42 42 50 40 58L48 47L48 27L60 34L71 27L72 41C86 45 89 58 79 66L74 77L84 85H65L58 79L47 85H30Z",
} as const;

function CharacterSilhouette({ character }: { character: Extract<WorldCharacter, { available: false }> }) {
  return <span className={styles.hiddenPortrait} aria-hidden="true">
    <svg className={styles.silhouette} viewBox="0 0 96 96"><path d={silhouettes[character.silhouette]} /></svg>
    <span className={styles.question}>?</span>
  </span>;
}

/** A controlled disclosure: keyboard focus stays on its trigger when expanded,
 * and Tab reaches the one available resident. Unknown slots have no action. */
export function WorldCharacters({ expanded, onToggle, onResident }: {
  expanded: boolean; onToggle: () => void; onResident: (id: "plesk") => void;
}) {
  return <div className={styles.library}>
    <button type="button" className={styles.trigger} data-world-characters-trigger
      aria-expanded={expanded} aria-controls={expanded ? "world-characters-list" : undefined} onClick={onToggle}>
      <PawPrint size={18} aria-hidden="true" />
      <span className={styles.triggerLabel}><span>Персонажи</span><small>Жители леса</small></span>
      <ChevronDown size={15} className={styles.chevron} data-expanded={expanded || undefined} aria-hidden="true" />
    </button>
    {expanded && <div id="world-characters-list" className={styles.contents}>
      <p className={styles.hint}>Другие жители пока недоступны.</p>
      <ul className={styles.grid} aria-label="Персонажи леса">
        {WORLD_CHARACTERS.map(character => <li key={character.id}>
          {character.available ? <button type="button" className={styles.card} data-world-character={character.id}
            aria-label={`${character.name} — ${character.role}. Открыть разговор`} aria-haspopup="dialog"
            onClick={() => { const resident = worldCharacterResident(character.id); if (resident) onResident(resident); }}>
            <PleskPortrait className={styles.portrait} />
            <strong>{character.name}</strong><small>Рыбачка</small>
          </button> : <button type="button" className={`${styles.card} ${styles.locked}`} disabled
            aria-label="Неизвестный персонаж, пока недоступен">
            <CharacterSilhouette character={character} /><small>Недоступен</small>
          </button>}
        </li>)}
      </ul>
    </div>}
  </div>;
}
