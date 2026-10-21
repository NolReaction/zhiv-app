"use client";

import { Leaf, UserRound } from "lucide-react";
import type { Person } from "@/lib/check-in-contract";
import { personDisplayName } from "@/lib/person-nickname";
import styles from "./person-game-actions.module.css";

export type PersonVisitAction = (person: Person, trigger: HTMLButtonElement) => void;

/** Both entry points use the app's existing profile and guest-world controllers. */
export function PersonGameActions({ person, online, onOpenProfile, onVisitFriend, className }: {
  person: Person; online: boolean; onOpenProfile?: (person: Person) => void;
  onVisitFriend?: PersonVisitAction; className?: string;
}) {
  const name = personDisplayName(person);
  const unavailable = !online ? "Нужен интернет" : person.theirSharingMode === "OFF" ? "Мир скрыт" : null;
  return <div className={`${styles.actions}${className ? ` ${className}` : ""}`}>
    {onOpenProfile && <button type="button" aria-label={`Игровой профиль: ${name}`} aria-haspopup="dialog"
      onClick={() => onOpenProfile(person)}><UserRound size={16} aria-hidden="true" />Игровой профиль</button>}
    {onVisitFriend && <button type="button" disabled={Boolean(unavailable)}
      aria-label={unavailable ? `${name}: ${unavailable.toLocaleLowerCase("ru-RU")}` : `В гости к ${name}`}
      onClick={event => { if (!unavailable) onVisitFriend(person, event.currentTarget); }}>
      <Leaf size={16} aria-hidden="true" />{unavailable ?? "В гости"}
    </button>}
  </div>;
}
