"use client";
import { Globe2, HeartPulse, UserRound, Users } from "lucide-react";
import styles from "@/features/app/app-shell.module.css";
export type AppView = "check-in" | "people" | "earth" | "profile";
export const appViews: AppView[] = ["check-in", "people", "earth", "profile"];
const entries = [{ id: "check-in", name: "Я живой", icon: HeartPulse },
  { id: "people", name: "Люди", icon: Users }, { id: "earth", name: "Карта", icon: Globe2 },
  { id: "profile", name: "Профиль", icon: UserRound }] as const;
export function AppNavigation({ active, onSelect, invitations }: { active: AppView; onSelect: (view: AppView) => void; invitations: number }) {
  return <nav className={styles.bottomNav} data-active-view={active} aria-label="Основные разделы">
    <span className={styles.navLens} aria-hidden="true" />
    {entries.map(({ id, name, icon: Icon }) => <button key={id} type="button" className={active === id ? styles.navActive : undefined}
      aria-current={active === id ? "page" : undefined} data-app-onboarding={`nav-${id}`} onClick={() => onSelect(id)}>
      <span className={styles.navIcon}><Icon size={20} aria-hidden="true" />{id === "people" && invitations > 0 ? <i>{Math.min(invitations, 9)}</i> : null}</span><span>{name}</span>
    </button>)}
  </nav>;
}
