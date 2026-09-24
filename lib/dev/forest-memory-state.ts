import type { ForestMemoryPayload } from "@/features/world/forest-memory-model";

export type DevForestMemoryState = {
  revision: number;
  snapshot: ForestMemoryPayload | null;
  updatedAt: number | null;
  lease: { sessionToken: string; clientId: string; token: string; expiresAt: number } | null;
  receipts: Map<string, { sessionToken: string; signature: string; acceptedRevision: number }>;
};

const globalStore = globalThis as typeof globalThis & { __zhivDevForestMemory?: Map<string, DevForestMemoryState> };

export function devForestMemoryStates() {
  return globalStore.__zhivDevForestMemory ??= new Map();
}

export function resetDevForestMemoryStoreForTests() {
  delete globalStore.__zhivDevForestMemory;
}
