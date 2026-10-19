const OPEN_KEY = "zhiv.earth.model-editor.open.v1";

/** Share the initial preference before the lazy editor mounts, so GPS and
 * social overlays never briefly resume after a development reload. */
export function readEarthModelEditorOpen(): boolean {
  if (process.env.NODE_ENV !== "development" || typeof window === "undefined") return false;
  try { return window.sessionStorage.getItem(OPEN_KEY) === "1"; }
  catch { return false; }
}

export function persistEarthModelEditorOpen(open: boolean): void {
  if (process.env.NODE_ENV !== "development" || typeof window === "undefined") return;
  try { window.sessionStorage.setItem(OPEN_KEY, open ? "1" : "0"); }
  catch { /* Editing remains available when storage is blocked. */ }
}
