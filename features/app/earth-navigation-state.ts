const STORAGE_KEY = "zhiv:earth:section";

/** Remember only the open section in this tab, never the camera or a location fix. */
export function restoreEarthSection(owner: string, storage?: Pick<Storage, "getItem">): boolean {
  try { return (storage ?? window.sessionStorage).getItem(STORAGE_KEY) === owner; }
  catch { return false; }
}

export function rememberEarthSection(owner: string, open: boolean, storage?: Pick<Storage, "setItem" | "removeItem">): void {
  try {
    const target = storage ?? window.sessionStorage;
    if (open) target.setItem(STORAGE_KEY, owner);
    else target.removeItem(STORAGE_KEY);
  } catch { /* Disabled storage must not prevent navigation. */ }
}
