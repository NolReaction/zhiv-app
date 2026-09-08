import { INACTIVITY_SECONDS, LONG_ABSENCE_SECONDS } from "./habitat";

export type Presence = { seenAt: number; inactiveFor: number; resting: boolean; deepSleep: boolean };

/** Local, account-scoped visual state. Storage failures must never affect check-ins. */
export function decodePresence(raw: string | null, now: number) {
  try {
    const saved: Presence = JSON.parse(raw ?? "null");
    if (!saved || !Number.isFinite(saved.seenAt) || saved.seenAt <= 0 || saved.seenAt > now
      || !Number.isFinite(saved.inactiveFor) || saved.inactiveFor < 0
      || typeof saved.resting !== "boolean" || typeof saved.deepSleep !== "boolean") return null;
    const absentFor = Math.min((now - saved.seenAt) / 1000, 7 * 24 * 3600);
    return { absentFor, inactiveFor: Math.min(saved.inactiveFor, 7 * 24 * 3600),
      resting: saved.resting || saved.inactiveFor + absentFor >= INACTIVITY_SECONDS,
      deepSleep: saved.deepSleep || absentFor >= LONG_ABSENCE_SECONDS };
  } catch { return null; }
}

export function readPresence(key: string | undefined, now: number) {
  try { return key ? decodePresence(window.localStorage.getItem(key), now) : null; } catch { return null; }
}

export function writePresence(key: string | undefined, presence: Presence) {
  try { if (key) window.localStorage.setItem(key, JSON.stringify(presence)); } catch { /* Optional visual memory. */ }
}
