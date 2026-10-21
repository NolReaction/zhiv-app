"use client";

import type { KeyboardEvent } from "react";
import styles from "./people-view.module.css";

const SECTIONS = [
  { id: "overview", title: "Обзор" },
  { id: "collections", title: "Находки" },
  { id: "settings", title: "Связь" },
] as const;

export type PersonProfileSection = typeof SECTIONS[number]["id"];

/** One compact row; arrow keys select a tab and move focus within this dialog. */
export function PersonProfileTabs({ active, onChange }: {
  active: PersonProfileSection; onChange: (section: PersonProfileSection) => void;
}) {
  const navigate = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = SECTIONS.findIndex(section => section.id === active);
    const next = event.key === "Home" ? 0 : event.key === "End" ? SECTIONS.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + SECTIONS.length) % SECTIONS.length;
    onChange(SECTIONS[next].id);
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#person-profile-tab-${SECTIONS[next].id}`)?.focus();
  };
  return <div className={styles.profileTabs} role="tablist" aria-label="Разделы профиля друга">
    {SECTIONS.map(section => <button key={section.id} id={`person-profile-tab-${section.id}`} type="button"
      role="tab" aria-selected={active === section.id} aria-controls="person-profile-panel"
      tabIndex={active === section.id ? 0 : -1} onClick={() => onChange(section.id)} onKeyDown={navigate}>
      {section.title}
    </button>)}
  </div>;
}
