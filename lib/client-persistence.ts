/** Explicit platform ports. Critical synchronous game journals never use this settings adapter. */
export type ClientKeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
let settings: ClientKeyValueStorage | undefined;
let receipts: ClientKeyValueStorage | undefined;

export function installClientPersistence(ports: { settings: ClientKeyValueStorage; receipts?: ClientKeyValueStorage }) {
  settings = ports.settings;
  receipts = ports.receipts;
}
export function setClientReceiptStorage(storage: ClientKeyValueStorage | undefined) { receipts = storage; }
export function deviceSettingsStorage(): ClientKeyValueStorage | undefined {
  if (settings) return settings;
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}
export function clientReceiptStorage(): ClientKeyValueStorage | undefined {
  if (receipts) return receipts;
  try { return typeof window === "undefined" ? undefined : window.sessionStorage; } catch { return undefined; }
}
