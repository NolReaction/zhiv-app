/** Durable gameplay journals differ from cosmetic preferences: callers await every
 * mutation before accepting an input. Reads expose only fully committed values. */
export interface ClientJournalStorage {
  getItem(key: string): string | null;
  getKeys(): readonly string[];
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

let journalFactory: ((ownerPublicId: string) => ClientJournalStorage) | undefined;

export function installClientJournalStorage(factory: ((ownerPublicId: string) => ClientJournalStorage) | undefined) {
  journalFactory = factory;
}

/** Undefined in a browser, where existing synchronous journals keep their contract. */
export function clientJournalStorage(ownerPublicId: string): ClientJournalStorage | undefined {
  return journalFactory?.(ownerPublicId);
}

export function isStoragePromise<T>(value: T | Promise<T>): value is Promise<T> {
  return value !== null && typeof value === "object" && "then" in value && typeof value.then === "function";
}

/** Keep browser callbacks synchronous while awaiting a native commit when present. */
export function mapStorageResult<T, R>(value: T | Promise<T>, complete: (value: T) => R): R | Promise<R> {
  return isStoragePromise(value) ? value.then(complete) : complete(value);
}

const journalLocks = new WeakSet<ClientJournalStorage>();
/** Native has one WebView, but Strict Mode and overlapping controllers still need
 * exclusive ownership. The database CAS is an additional cross-process fence. */
export async function acquireClientJournalLock(storage: ClientJournalStorage, signal: AbortSignal): Promise<(() => void) | null> {
  await Promise.resolve();
  if (signal.aborted || journalLocks.has(storage)) return null;
  journalLocks.add(storage);
  const release = () => { journalLocks.delete(storage); signal.removeEventListener("abort", release); };
  signal.addEventListener("abort", release, { once: true });
  return release;
}
