type CachedState = { version: string; identity: unknown; value: unknown };
type DevWindow = Window & { __zhivWorldDevHmrCacheV1?: Map<string, CachedState> };

/** Keep editing sessions when Next refreshes modules after a generated-world write. */
export function retainWorldDevClientState<T>(
  key: string,
  version: string,
  create: () => T,
  options: { identity?: unknown; dispose?: (previous: T) => void } = {},
): { value: T; reused: boolean } {
  if (process.env.NODE_ENV !== "development" || typeof window === "undefined") return { value: create(), reused: false };
  const owner = window as DevWindow;
  const registry = owner.__zhivWorldDevHmrCacheV1 ??= new Map();
  const previous = registry.get(key), identity = options.identity ?? null;
  if (previous?.version === version && previous.identity === identity) return { value: previous.value as T, reused: true };
  if (previous) { registry.delete(key); options.dispose?.(previous.value as T); }
  const value = create();
  registry.set(key, { version, identity, value });
  return { value, reused: false };
}
