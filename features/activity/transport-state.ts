import { gameplayGenerationHeaders, gameplayResetPending, reportGameplayReset } from "@/lib/gameplay-generation";

/** Per document, never in localStorage: tabs have independent leases. */
let presenceId: string | null = null;
const listeners = new Set<() => void>();
export function setGamePresence(id: string | null) {
  if (id && gameplayResetPending()) return;
  if (presenceId === id) return;
  presenceId = id;
  for (const listener of listeners) listener();
}
export function subscribeGamePresence(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function gamePresenceHeaders(): Record<string, string> {
  return { ...gameplayGenerationHeaders(), ...(presenceId ? { "X-Game-Presence": presenceId } : {}) };
}
export function reportInactivePresence(code: unknown, sent: Record<string, string>) {
  reportGameplayReset(code, sent);
  if (gameplayResetPending()) { setGamePresence(null); return; }
  if (presenceId && sent["X-Game-Presence"] === presenceId && code === "GAME_SESSION_INACTIVE" && typeof window !== "undefined") {
    setGamePresence(null);
    window.dispatchEvent(new Event("zhiv:presence-expired"));
  }
}
