/** The browser remains the default. Native capabilities are installed before React mounts. */
type DeviceCapabilities = {
  haptic(kind: "selection" | "bite"): Promise<void>;
  share(data: ShareData): Promise<"shared" | "cancelled" | "unavailable" | "failed">;
};
let capabilities: DeviceCapabilities | null = null;
let active: boolean | null = null;
let connected: boolean | null = null;
const listeners = new Set<() => void>();
const memoryListeners = new Set<() => void>();

export function configureDeviceCapabilities(value: DeviceCapabilities | null) { capabilities = value; }
export function getDeviceCapabilities() { return capabilities; }
export function deviceIsActive(page?: Pick<Document, "hidden">) {
  return active !== false && !(page ?? (typeof document === "undefined" ? undefined : document))?.hidden;
}
export function deviceIsOnline() { return connected ?? (typeof navigator === "undefined" || navigator.onLine); }
export function updateDeviceEnvironment(value: { active?: boolean; connected?: boolean }) {
  const changed = value.active !== undefined && value.active !== active || value.connected !== undefined && value.connected !== connected;
  if (value.active !== undefined) active = value.active;
  if (value.connected !== undefined) connected = value.connected;
  if (changed) for (const listener of listeners) listener();
}
export function subscribeDeviceEnvironment(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function subscribeMemoryPressure(listener: () => void) { memoryListeners.add(listener); return () => { memoryListeners.delete(listener); }; }
export function reportMemoryPressure() { for (const listener of memoryListeners) listener(); }
export function resetDeviceEnvironment() {
  active = null; connected = null; capabilities = null;
  for (const listener of listeners) listener();
}
export function deviceHaptic(kind: "selection" | "bite") {
  if (!deviceIsActive()) return;
  if (capabilities) { void capabilities.haptic(kind).catch(() => undefined); return; }
  try { if (typeof navigator !== "undefined") navigator.vibrate?.(kind === "bite" ? [65, 45, 90] : 12); } catch { /* Optional physical feedback. */ }
}
