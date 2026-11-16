import type { ClientJournalStorage } from "@/lib/client-journal-storage";
import { gameplayResetPending, gameplayStorageKey } from "@/lib/gameplay-generation";
import type { BoatChallenge } from "@/features/economy/domain/boat-model";
import { initialBoatReel } from "@/features/economy/domain/boat-reel";
import { boatReelCheckpointPointer, boatReelCheckpointPrefix, decodeBoatReelCheckpoint } from "./boat-reel-checkpoint";

type LegacyStorage = Pick<Storage, "getItem" | "removeItem">;
const writers = new WeakMap<ClientJournalStorage, Promise<unknown>>();

/** A new keyed attempt waits for accepted writes from the previous mount. This
 * also covers Strict Mode cleanup without letting late callbacks re-open input. */
export function createNativeBoatReelCheckpoint(storage: ClientJournalStorage, owner: string, key: string, challenge: BoatChallenge, legacy: LegacyStorage | null) {
  let closed = false, fault: unknown;
  const check = () => {
    if (fault) throw fault;
    if (gameplayResetPending()) throw new Error("Игра была сброшена. Откройте приложение заново.");
  };
  const enqueue = <T,>(operation: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new Error("Попытка уже закрыта"));
    const next = (writers.get(storage) ?? Promise.resolve()).catch(() => {}).then(async () => {
      check();
      try { return await operation(); } catch (error) { fault = error; throw error; }
    });
    writers.set(storage, next.catch(() => {}));
    return next;
  };
  const ready = enqueue(async () => {
    let raw = storage.getItem(key), imported: string | null = null;
    // Old sessionStorage was not generation-scoped. Never import it after reset.
    if (raw === null && gameplayStorageKey("generation-probe") === "generation-probe") {
      try { imported = legacy?.getItem(key) ?? null; } catch { /* No browser draft. */ }
      if (imported !== null) {
        if (!decodeBoatReelCheckpoint(imported, challenge)) throw new Error("Не удалось прочитать сохранённую попытку");
        await storage.setItem(key, imported); check();
        if (storage.getItem(key) !== imported) throw new Error("Не подтверждено сохранение попытки");
        raw = imported;
      }
    }
    const restored = raw === null ? { reel: initialBoatReel(challenge), inputs: [] }
      : decodeBoatReelCheckpoint(raw, challenge);
    if (!restored) throw new Error("Не удалось прочитать сохранённую попытку");
    const pointer = boatReelCheckpointPointer(owner), previous = storage.getItem(pointer);
    await storage.setItem(pointer, key); check();
    if (storage.getItem(pointer) !== key) throw new Error("Не подтверждено сохранение попытки");
    if (previous && previous !== key && previous.startsWith(boatReelCheckpointPrefix(owner))) {
      await storage.removeItem(previous); check();
    }
    if (imported !== null) {
      try {
        if (legacy?.getItem(key) === imported) legacy.removeItem(key);
        if (legacy?.getItem(pointer) === key) legacy.removeItem(pointer);
      } catch { /* Verified native copy exists; a leftover import is harmless. */ }
    }
    return restored;
  });
  return {
    ready,
    write(raw: string | null) {
      return enqueue(async () => {
        // A missed bite and a just-hooked tick-zero trace are real checkpoints.
        if (raw !== null) {
          if (!decodeBoatReelCheckpoint(raw, challenge)) throw new Error("Некорректная запись попытки");
          await storage.setItem(key, raw); check();
          if (storage.getItem(key) !== raw) throw new Error("Не подтверждено сохранение попытки");
        } else storage.getItem(key); // Check the captured native owner even without a mutation.
      });
    },
    close() { closed = true; },
  };
}
export type NativeBoatReelCheckpoint = ReturnType<typeof createNativeBoatReelCheckpoint>;
