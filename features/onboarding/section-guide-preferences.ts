type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;
const memory = new Map<string, boolean>();

export const sectionGuideLauncherPreferenceKey = (owner: string) => `zhiv.section-guide.launcher.v1:${encodeURIComponent(owner)}`;

/** Controls manual help launchers without changing saved lesson progress. */
export function readSectionGuideLauncherPreference(owner: string, storage?: PreferenceStorage): boolean {
  const key = sectionGuideLauncherPreferenceKey(owner);
  const fallback = memory.get(key);
  if (fallback !== undefined) return fallback;
  try { return storage?.getItem(key) !== "false"; } catch { return true; }
}

export function saveSectionGuideLauncherPreference(owner: string, visible: boolean, storage?: PreferenceStorage): void {
  const key = sectionGuideLauncherPreferenceKey(owner);
  try {
    if (!storage) throw new Error("Storage unavailable");
    storage.setItem(key, String(visible));
    memory.delete(key);
  } catch { memory.set(key, visible); }
}
