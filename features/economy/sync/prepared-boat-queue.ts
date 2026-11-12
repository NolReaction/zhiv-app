import { ApiError } from "@/lib/check-in-api";
import { createUuidV4 } from "@/lib/browser-uuid";
import { BOAT_CAST_CYCLE_MS } from "@/features/economy/domain/boat-cast-aim";
import type { BoatReelCommand } from "@/features/economy/domain/boat-model";
import type { EconomyCommand, EconomyResult, EconomyView } from "@/features/economy/domain/model";
import { parsePreparedBoatEntries, preparedBoatJournalKey, preparedBoatOutcome, projectPreparedBoat, type PreparedBoatEntry } from "./prepared-boat-journal";
import type { JournalStorage } from "./production-journal";

type Dependencies = {
  snapshot: () => EconomyView | null; confirmed: () => boolean; now: () => number;
  storage: () => JournalStorage | undefined; canSend: () => boolean; localAllowed: () => boolean; preferPrepared: () => boolean;
  legacyLanding: () => BoatReelCommand | undefined;
  send: (command: EconomyCommand, signal: AbortSignal) => Promise<EconomyResult>;
  get: (signal: AbortSignal) => Promise<EconomyView>;
  adopt: (snapshot: EconomyView) => boolean;
  changed: (patch?: { error?: string | null; storageError?: string | null; notice?: string; syncError?: string | null }) => void;
  sessionLost: () => void;
};

/** Up to two server-issued tracks. Persist each start and terminal trace before it can affect the river. */
export function createPreparedBoatQueue(owner: string | null, deps: Dependencies) {
  let entries: PreparedBoatEntry[] = [], blockedUntil = 0, failures = 0;
  let request: AbortController | null = null, sending: Promise<void> | null = null;
  let failedStorage = false;
  const key = owner ? preparedBoatJournalKey(owner) : "";
  const save = (next: PreparedBoatEntry[]) => {
    const storage = deps.storage();
    if (!storage || !owner) return false;
    try {
      if (next.length) storage.setItem(key, JSON.stringify({ version: 1, owner, entries: next }));
      else storage.removeItem(key);
      entries = next;
      if (failedStorage) { failedStorage = false; deps.changed({ storageError: null }); }
      return true;
    } catch {
      failedStorage = true;
      deps.changed({ storageError: "Не удалось сохранить заброс на устройстве. Освободите место в браузере." });
      return false;
    }
  };
  const project = () => {
    const voyage = deps.snapshot()?.boat?.voyage, legacy = deps.legacyLanding();
    const legacyChallenge = voyage?.challenge;
    const legacyCaught = !!legacyChallenge && !!legacy && preparedBoatOutcome(legacyChallenge, legacy) === "caught";
    return projectPreparedBoat(voyage, entries, deps.now(), legacy?.challengeId, legacyCaught);
  };
  const available = (projected: ReturnType<typeof project>) => !!projected.next && !!deps.storage() && !failedStorage
    && deps.localAllowed() && (entries.length > 0 || deps.preferPrepared());
  function begin(voyageId: string, heldMs: number) {
    const projected = project(), { next, template } = projected;
    if (!next || !template || deps.snapshot()?.boat?.voyage?.id !== voyageId || !available(projected)
      || !Number.isSafeInteger(heldMs) || heldMs < 0 || heldMs > BOAT_CAST_CYCLE_MS) return false;
    if (!save([...entries, { voyageId, castNumber: template.castNumber, castHeldMs: heldMs, challenge: next }])) return false;
    deps.changed();
    return true;
  }
  function finish(voyageId: string, reel: BoatReelCommand) {
    const entry = entries.at(-1);
    if (!entry || !deps.localAllowed() || entry.reel || entry.voyageId !== voyageId || entry.challenge.id !== reel.challengeId
      || preparedBoatOutcome(entry.challenge, reel) === null) return false;
    const trace: BoatReelCommand = { ...reel, inputs: reel.inputs.map(input => ({ ...input })), deferred: true,
      prepared: { castNumber: entry.castNumber, startedAt: entry.challenge.startedAt, castHeldMs: entry.castHeldMs } };
    if (!save([...entries.slice(0, -1), { ...entry, reel: trace }])) return false;
    deps.changed();
    void drain();
    return true;
  }
  function expireDraft() {
    const draft = entries.at(-1);
    if (!draft || draft.reel || deps.now() < Date.parse(draft.challenge.expiresAt)) return;
    finish(draft.voyageId, { challengeId: draft.challenge.id, endTick: 0, inputs: [], missedBite: true, deferred: true });
  }
  function delay(error: unknown) {
    const throttled = error instanceof ApiError && error.status === 429;
    const delayMs = throttled ? Math.max(1000, error.retryAfterMs ?? 60_000) : Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5));
    blockedUntil = performance.now() + delayMs;
    deps.changed({ syncError: "Результат рыбалки сохранён на устройстве. Отправим его, когда восстановится связь." });
    if (error instanceof ApiError && error.status === 401) deps.sessionLost();
  }
  async function deliver(signal: AbortSignal) {
    if (failedStorage && !save(entries)) return;
    while (!signal.aborted && deps.canSend() && owner && entries[0]?.reel && performance.now() >= blockedUntil) {
      const head = entries[0];
      let command = head.command;
      try {
        if (!command) {
          if (!deps.confirmed()) {
            const fresh = await deps.get(signal);
            if (signal.aborted || !deps.adopt(fresh)) return;
          }
          const snapshot = deps.snapshot(), voyage = snapshot?.boat?.voyage;
          if (!snapshot) return;
          if (voyage?.id !== head.voyageId || voyage.castsUsed + 1 !== head.castNumber || voyage.challenge || voyage.returnStartedAt
            || !voyage.preparedCasts?.some(ticket => ticket.castNumber === head.castNumber && ticket.id === head.challenge.id)) {
            if (save([])) deps.changed({ error: "Рейс успел измениться на другом устройстве. Обновили улов по данным сервера." });
            return;
          }
          command = { requestId: createUuidV4(), ownerPublicId: owner, expectedRevision: snapshot.revision,
            targetId: head.voyageId, action: "submit_boat_cast", quantity: 1, totalPrice: 0, reel: head.reel };
          if (!save([{ ...head, command }, ...entries.slice(1)])) return;
        }
        const result = await deps.send(command, signal);
        if (signal.aborted || !deps.adopt(result.state)) return;
        if (!save(entries.slice(1))) return;
        blockedUntil = 0; failures = 0;
        deps.changed({ notice: result.message, syncError: null });
      } catch (error) {
        if (signal.aborted) return;
        const definitive = error instanceof ApiError && error.status >= 400 && error.status < 500
          && ![401, 408, 425, 429].includes(error.status) && error.body?.code !== "GAME_SESSION_INACTIVE";
        if (!definitive) { delay(error); return; }
        // Only an explicit rejection releases the idempotency key. Never rebase on an unknown ACK.
        let fresh: EconomyView;
        try { fresh = await deps.get(signal); }
        catch (readError) { if (!signal.aborted) delay(readError); return; }
        if (signal.aborted || !deps.adopt(fresh)) return;
        if (error.body?.code === "ECONOMY_REVISION_CONFLICT" && command && fresh.revision > command.expectedRevision
          && fresh.boat?.voyage?.id === head.voyageId && !fresh.boat.voyage.challenge && fresh.boat.voyage.castsUsed + 1 === head.castNumber
          && fresh.boat.voyage.preparedCasts?.some(slot => slot.id === head.challenge.id && slot.castNumber === head.castNumber)) {
          if (!save([{ ...head, command: undefined }, ...entries.slice(1)])) return;
          continue;
        }
        if (save([])) deps.changed({ error: error.message, syncError: null });
        return;
      }
    }
  }
  function drain() {
    if (sending) return sending;
    if (!entries[0]?.reel || !deps.canSend() || performance.now() < blockedUntil) return Promise.resolve();
    const current = new AbortController();
    request = current;
    const task = Promise.resolve().then(() => deliver(current.signal));
    sending = task;
    deps.changed();
    void task.finally(() => { if (current === request) { request = null; sending = null; deps.changed(); } });
    return task;
  }
  return {
    begin, finish, drain, expireDraft,
    discardSupersededDraft(snapshot: EconomyView) {
      // If no command has been sent, a newer server cast or a closed voyage
      // definitively supersedes this reservation. An unknown ACK must still replay.
      const head = entries[0], voyage = snapshot.boat?.voyage;
      if (head && !head.command && (voyage?.id !== head.voyageId || voyage.returnStartedAt || voyage.castsUsed >= head.castNumber)) {
        if (save([])) deps.changed({ notice: "Рейс изменился на другом устройстве. Загружен актуальный улов." });
      }
    },
    hasEntries: () => entries.length > 0,
    hasTerminal: () => !!entries[0]?.reel,
    isDraft: (id: string) => entries.some(entry => !entry.reel && entry.challenge.id === id),
    isSending: () => request !== null,
    restore() {
      try { entries = owner ? parsePreparedBoatEntries(deps.storage()?.getItem(key) ?? null, owner) : []; }
      catch { failedStorage = true; }
    },
    pause() { request?.abort(); request = null; sending = null; },
    view() {
      const projection = project();
      return { localBoatVoyage: projection.localBoatVoyage, localBoatCatches: projection.localBoatCatches,
        preparedBoatChallengeId: projection.preparedBoatChallengeId, preparedBoatCastAvailable: available(projection), preparedBoatPending: !!entries.length, preparedBoatSending: request !== null };
    },
  };
}
