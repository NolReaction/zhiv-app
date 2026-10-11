export const WORLD_PORTAL_HISTORY_KEY = "zhivWorldPortal";

type PortalHistoryEntry = {
  entry: string | null;
  backPending: boolean;
  openedUrl: string | null;
  returnMarker: unknown;
};

/** Only our own return to the same document belongs to the portal. A route
 * change or a foreign history entry must still reach the application's router. */
export function isWorldPortalReturn(portal: PortalHistoryEntry, currentUrl: string, restoredMarker: unknown): boolean {
  return Boolean((portal.entry || portal.backPending) && portal.openedUrl === currentUrl
    && (portal.backPending || restoredMarker !== portal.entry) && restoredMarker === portal.returnMarker);
}
