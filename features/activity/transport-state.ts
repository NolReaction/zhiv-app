/** Per document, never in localStorage: tabs have independent leases. */
let presenceId: string | null = null;
export function setGamePresence(id: string | null) { presenceId = id; }
export function gamePresenceHeaders(): Record<string, string> {
  return presenceId ? { "X-Game-Presence": presenceId } : {};
}
export function reportInactivePresence(code: unknown, sent: Record<string, string>) {
  if (presenceId && sent["X-Game-Presence"] === presenceId && code === "GAME_SESSION_INACTIVE" && typeof window !== "undefined") {
    setGamePresence(null);
    window.dispatchEvent(new Event("zhiv:presence-expired"));
  }
}
