import type { GameJournal, GameJournalStore } from "@/features/game/game-sync-journal";
import { incidentCode, reportIncident } from "@/lib/client-incidents";
import { ApiError } from "@/lib/check-in-api";
import { createUuidV4 } from "@/lib/browser-uuid";
import {
  createGameSession, getGameProgress, submitGameBatch,
  type GameBatchRequest, type GameBatchResponse, type GameProgress,
  type GameSession, type GameSessionRequest,
} from "@/features/game/game-api";

export type GameSyncStatus = "loading" | "ready" | "syncing" | "offline" | "error" | "blocked";
export type GameRunSync = {
  runId: string;
  acceptedTaps: number;
  creditedTaps?: number;
  pendingTaps: number;
  rejectedTaps: number;
  interrupted: boolean;
};
export type GameSyncSnapshot = {
  progress: GameProgress | null;
  status: GameSyncStatus;
  pendingTaps: number;
  rejectedTaps: number;
  run: GameRunSync | null;
  errorCode?: string | null;
  requestId?: string;
  durable?: boolean;
  archivedTaps?: number;
};
type QueuedTaps = { runId: string; count: number; times?: number[]; deferred?: boolean };
export type GameTapInput = { id: string; runId: string; count: number; capturedAt: number };
type GameTransport = {
  progress(signal: AbortSignal): Promise<GameProgress>;
  session(body: GameSessionRequest, signal: AbortSignal): Promise<GameSession>;
  batch(body: GameBatchRequest, signal: AbortSignal): Promise<GameBatchResponse>;
};
const transport: GameTransport = { progress: getGameProgress, session: createGameSession, batch: submitGameBatch };
const MAX_BATCH_TAPS = 60;
const MAX_PENDING_TAPS = 30_000;
// Match the server's shared 30/s, burst-60 policy. Pace observed backlog so a
// delayed LTE response does not turn ordinary tapping into a rejected burst.
const TAPS_PER_SECOND = 30;
const RETRY_DELAY_MS = 3_000;
function waitForPacing(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, delayMs);
    signal.addEventListener("abort", abort, { once: true });
  });
}
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Delivery journal and immutable receipts survive reload. Only the API can confirm totals.
export class GameSyncClient {
  private progress: GameProgress | null = null;
  private queue: QueuedTaps[] = [];
  private deferredQueue: QueuedTaps[] = [];
  private catchUpMode = false;
  private archivedQueues: GameJournal["archivedQueues"] = [];
  private session: GameSession | null = null;
  private run: Omit<GameRunSync, "pendingTaps"> | null = null;
  private runs = new Map<string, Omit<GameRunSync, "pendingTaps">>();
  private inputReceipts = new Set<string>();
  private rejectedTaps = 0;
  private sessionUntil = 0;
  private pacingTokens = MAX_BATCH_TAPS;
  private pacingUpdatedAt = 0;
  private startRequest: GameSessionRequest | null = null;
  private pendingBatch: GameBatchRequest | null = null;
  private writing = false;
  private flushOperation: Promise<void> | null = null;
  private reading = false;
  private failed = false;
  private retryAt = 0;
  private disposed = false;
  private readVersion = 0;
  private writeController: AbortController | null = null;
  private readController: AbortController | null = null;
  private online: boolean;
  private errorCode: string | null = null;
  private requestId: string | undefined;
  private storageFailed = false;
  private journalUnreadable = false;
  private serverOffset = 0;
  private failures = 0;
  private nextDispatchAt = 0;
  private lastReadAt = -Infinity;
  private serverAnchor = 0;
  private anchorNow = 0;
  private lastEventAt = 0;
  private recordingStopped = false;
  private needsPermit = false;
  private permitLive(): boolean { return !!this.session && this.now() < this.sessionUntil && this.wallNow() + this.serverOffset < Date.parse(this.session.expiresAt); }
  private eventNow(): number { return this.serverAnchor + Math.max(0, this.now() - this.anchorNow); }
  private anchor(serverTime: string) { this.serverAnchor = Date.parse(serverTime); this.anchorNow = this.now(); this.serverOffset = this.serverAnchor - this.wallNow(); }

  constructor(
    private readonly ownerPublicId: string,
    online: boolean,
    private readonly onChange: (snapshot: GameSyncSnapshot) => void,
    private readonly onSessionLost: () => void,
    private readonly api: GameTransport = transport,
    private readonly now: () => number = () => performance.now(),
    private readonly uuid: () => string = createUuidV4,
    private readonly wait: (delayMs: number, signal: AbortSignal) => Promise<void> = waitForPacing,
    private readonly journal?: GameJournalStore,
    private readonly wallNow: () => number = Date.now,
  ) {
    this.online = online; this.pacingUpdatedAt = this.now(); this.serverAnchor = this.wallNow(); this.anchorNow = this.now();
    try {
      const saved = journal?.read();
      if (saved) {
        this.progress = saved.progress; this.queue = saved.queue; this.session = saved.session;
        this.pendingBatch = saved.pendingBatch; this.startRequest = saved.startRequest; this.run = saved.run;
        this.runs = new Map((saved.runs ?? []).map(run => [run.runId, run]));
        if (this.run) { this.runs.set(this.run.runId, this.run); }
        this.inputReceipts = new Set(saved.inputReceipts ?? []);
        this.errorCode = saved.errorCode ?? null; this.requestId = saved.requestId;
        this.archivedQueues = saved.archivedQueues ?? [];
        this.deferredQueue = saved.deferredQueue ?? []; this.catchUpMode = saved.catchUpMode ?? false;
        this.rejectedTaps = saved.rejectedTaps; this.serverOffset = saved.serverOffset;
        this.serverAnchor = this.wallNow() + saved.serverOffset;
        this.lastEventAt = saved.lastEventAt ?? 0; this.recordingStopped = saved.recordingStopped ?? false; this.needsPermit = this.deferredQueue.length > 0;
        this.retryAt = this.now() + Math.max(0, Math.min(saved.retryRemaining ?? 60000, saved.retryAfter - this.wallNow()));
        this.sessionUntil = this.session ? this.now() + Date.parse(this.session.expiresAt) - this.wallNow() - this.serverOffset : 0;
        // Reload must not reset the server's dispatch budget.
        this.nextDispatchAt = this.now() + 2000;
      }
    } catch { this.storageFailed = true; this.journalUnreadable = true; this.errorCode = "STORAGE_FAILED"; }
  }

  private persist(): boolean {
    if (!this.journal) return true;
    if (this.journalUnreadable) return false; // Preserve the original for recovery; never overwrite it with an empty queue.
    try {
      this.journal.write({ version: 1, ownerPublicId: this.ownerPublicId, savedAt: this.wallNow(), progress: this.progress,
        queue: this.queue, session: this.session, pendingBatch: this.pendingBatch, startRequest: this.startRequest, run: this.run,
        runs: [...this.runs.values()], inputReceipts: [...this.inputReceipts], errorCode: this.errorCode, requestId: this.requestId,
        archivedQueues: this.archivedQueues, deferredQueue: this.deferredQueue, catchUpMode: this.catchUpMode,
        rejectedTaps: this.rejectedTaps, serverOffset: this.eventNow() - this.wallNow(),
        recordingStopped: this.recordingStopped, lastEventAt: this.lastEventAt,
        retryAfter: Math.ceil(this.wallNow() + Math.max(0, this.retryAt - this.now())),
        retryRemaining: Math.min(3600000, Math.ceil(Math.max(0, this.retryAt - this.now()))) });
      this.storageFailed = false;
      return true;
    } catch {
      this.storageFailed = true; this.errorCode = "STORAGE_FAILED";
      reportIncident(this.ownerPublicId, "game.storage", "STORAGE_FAILED", this.snapshot().pendingTaps);
      return false;
    }
  }

  snapshot(runId?: string): GameSyncSnapshot {
    const run = runId ? this.runs.get(runId) : this.run;
    const pendingTaps = [...this.queue, ...this.deferredQueue].reduce((sum, item) => sum + item.count, 0) + (this.pendingBatch?.tapCount ?? 0);
    return {
      progress: this.progress,
      errorCode: this.errorCode, requestId: this.requestId, durable: !this.storageFailed,
      pendingTaps,
      archivedTaps: this.archivedQueues.reduce((total, item) => total + (item.pendingBatch?.tapCount ?? 0)
        + item.queue.reduce((sum, batch) => sum + batch.count, 0), 0),
      rejectedTaps: this.rejectedTaps,
      run: run ? { ...run, pendingTaps:
        [...this.queue, ...this.deferredQueue].reduce((sum, item) => sum + (item.runId === run.runId ? item.count : 0), 0)
        + (this.pendingBatch?.runId === run.runId ? this.pendingBatch.tapCount : 0),
      } : null,
      status: this.errorCode === "GAME_ACTIVE_ELSEWHERE" ? "blocked" : this.storageFailed ? "error" : !this.online ? "offline" : this.failed ? "error"
        : pendingTaps > 0 || this.writing ? "syncing"
          : this.progress ? "ready" : "loading",
    };
  }

  private emit(): void { if (!this.disposed) { this.persist(); this.onChange(this.snapshot()); } }

  setOnline(online: boolean): void {
    if (this.disposed || this.online === online) return;
    this.online = online;
    if (!online) {
      reportIncident(this.ownerPublicId, "game.batch", "OFFLINE", this.snapshot().pendingTaps);
      this.writeController?.abort();
      this.readController?.abort();
    } // Online/focus must not bypass Retry-After.
    this.emit();
  }

  adoptProgress(incoming: GameProgress): void {
    if (this.disposed) return;
    if (incoming.ownerPublicId !== this.ownerPublicId) { this.ownerChanged(); return; }
    this.readVersion += 1;
    const previous = this.progress;
    if (!previous) this.progress = incoming;
    else if (Date.parse(incoming.serverTime) < Date.parse(previous.serverTime)) {
      if (incoming.visibilityVersion > previous.visibilityVersion) {
        this.progress = { ...previous, leaderboardOptIn: incoming.leaderboardOptIn, visibilityVersion: incoming.visibilityVersion };
      }
    }
    else {
      // Concurrent reads, batches and visibility writes may arrive out of order.
      // Merge only monotonic values already verified by the server, never local taps.
      const latest = Date.parse(incoming.serverTime) >= Date.parse(previous.serverTime) ? incoming : previous;
      const visibility = incoming.visibilityVersion >= previous.visibilityVersion ? incoming : previous;
      const currentMonth = incoming.month >= previous.month ? incoming : previous;
      this.progress = {
        ...latest,
        lifetimeTaps: Math.max(previous.lifetimeTaps, incoming.lifetimeTaps),
        bestSeries: Math.max(previous.bestSeries, incoming.bestSeries),
        month: currentMonth.month,
        monthlyTaps: incoming.month === previous.month
          ? Math.max(previous.monthlyTaps, incoming.monthlyTaps) : currentMonth.monthlyTaps,
        leaderboardOptIn: visibility.leaderboardOptIn,
        visibilityVersion: visibility.visibilityVersion,
      };
    }
    if (this.progress) this.progress = { ...this.progress, items: [...new Set([...(previous?.items ?? []), ...(incoming.items ?? [])])] };
    this.emit();
  }

  private ownerChanged(): void {
    this.dispose();
    this.onSessionLost();
  }

  recordTap(steps: number, runId: string, capturedAt?: number): number {
    if (this.disposed || this.storageFailed || !Number.isSafeInteger(steps) || steps < 1 || !RUN_ID.test(runId)) return 0;
    if (this.run?.runId !== runId) {
      this.run = this.runs.get(runId) ?? { runId, acceptedTaps: 0, creditedTaps: 0, rejectedTaps: 0, interrupted: false };
      this.runs.set(runId, this.run);
      // Keep recent tabs' results without allowing completed runs to grow forever.
      if (this.runs.size > 128) {
        const pendingRuns = new Set([...this.queue, ...this.deferredQueue].map(item => item.runId));
        if (this.pendingBatch) pendingRuns.add(this.pendingBatch.runId);
        for (const key of this.runs.keys()) {
          if (this.runs.size <= 128) break;
          if (key !== runId && !pendingRuns.has(key)) this.runs.delete(key);
        }
      }
    }
    const pending = this.snapshot().pendingTaps;
    const count = Math.min(steps, Math.max(0, MAX_PENDING_TAPS - pending));
    let remaining = count;
    while (remaining > 0) {
      // Keep ordinary live events timestamped. Events without a valid permit
      // are durable intents, separate from the already authorized outbox.
      const initialRoom = !this.session && this.online && !this.recordingStopped
        && this.errorCode !== "GAME_ACTIVE_ELSEWHERE" && !this.catchUpMode && !this.deferredQueue.length
        ? Math.max(0, MAX_BATCH_TAPS - this.queue.reduce((sum, item) => sum + item.count, 0)) : 0;
      const eventAt = capturedAt === undefined ? this.eventNow() : capturedAt + this.serverOffset;
      const staleInput = capturedAt !== undefined && (this.wallNow() - capturedAt > 5000
        || !!this.session?.startedAt && eventAt < Date.parse(this.session.startedAt));
      const live = this.session && !this.recordingStopped && (!this.session.startedAt || this.permitLive());
      const deferred = staleInput || this.catchUpMode || this.deferredQueue.length > 0 || !live && initialRoom === 0;
      const target = deferred ? this.deferredQueue : this.queue;
      const last = target.at(-1);
      const item: QueuedTaps = last?.runId === runId && last.count < MAX_BATCH_TAPS
        ? last : { runId, count: 0, times: [], ...(deferred ? { deferred: true } : {}) };
      if (item !== last) target.push(item);
      const chunk = Math.min(remaining, MAX_BATCH_TAPS - item.count, !live && !deferred ? initialRoom : MAX_BATCH_TAPS);
      item.count += chunk; item.times ??= [];
      this.lastEventAt = Math.floor(Math.max(this.lastEventAt, Math.min(this.eventNow(), eventAt)));
      item.times.push(...Array.from({ length: chunk }, () => this.lastEventAt));
      remaining -= chunk;
    }
    this.needsPermit = this.deferredQueue.length > 0;
    if (steps > count) { this.errorCode = "QUEUE_FULL"; reportIncident(this.ownerPublicId, "game.storage", "QUEUE_FULL", pending); }
    this.emit();
    if (!this.session || this.needsPermit || this.queue[0]?.count === MAX_BATCH_TAPS) void this.flush();
    return this.storageFailed ? 0 : count;
  }

  /** Import an immutable cross-tab intent and its deduplication receipt in one journal write. */
  importInput(input: GameTapInput): boolean {
    if (this.disposed) return false;
    if (this.inputReceipts.has(input.id)) return this.persist();
    if (this.storageFailed || !RUN_ID.test(input.id) || !RUN_ID.test(input.runId)
      || !Number.isSafeInteger(input.count) || input.count < 1 || input.count > MAX_BATCH_TAPS
      || !Number.isSafeInteger(input.capturedAt) || input.capturedAt < 0
      || this.snapshot().pendingTaps + input.count > MAX_PENDING_TAPS) return false;
    this.inputReceipts.add(input.id);
    return this.recordTap(input.count, input.runId, input.capturedAt) === input.count;
  }

  /** Call only after the immutable input key has been removed successfully. */
  forgetInput(id: string): void {
    if (this.inputReceipts.delete(id)) this.emit();
  }

  private rejectTaps(runId: string, count: number): void {
    this.rejectedTaps += count;
    const run = this.runs.get(runId);
    if (run) run.rejectedTaps += count;
  }

  async refresh(): Promise<void> {
    if (this.disposed || !this.online || this.reading || this.now() < this.retryAt || this.now() - this.lastReadAt < 15_000) return;
    this.reading = true;
    this.lastReadAt = this.now();
    const version = ++this.readVersion;
    const controller = new AbortController();
    this.readController = controller;
    try {
      const progress = await this.api.progress(controller.signal);
      if (this.disposed || controller.signal.aborted || version !== this.readVersion) return;
      this.anchor(progress.serverTime);
      if (this.session) this.sessionUntil = this.now() + Date.parse(this.session.expiresAt) - this.eventNow();
      this.adoptProgress(progress);
      if (!this.pendingBatch && !this.startRequest) this.failed = false;
    } catch (error) {
      if (this.disposed || controller.signal.aborted || version !== this.readVersion) return;
      if (error instanceof ApiError && error.status === 401) { this.ownerChanged(); return; }
      this.failure(error, "game.progress");
    } finally {
      this.reading = false;
      if (this.readController === controller) this.readController = null;
      this.emit();
    }
  }

  flush(): Promise<void> {
    if (this.disposed || !this.online || this.now() < this.retryAt) return Promise.resolve();
    if (this.flushOperation) return this.flushOperation;
    const operation = this.flushPending();
    this.flushOperation = operation;
    void operation.then(() => { if (this.flushOperation === operation) this.flushOperation = null; },
      () => { if (this.flushOperation === operation) this.flushOperation = null; });
    return operation;
  }

  private async flushPending(): Promise<void> {
    if (this.disposed || !this.online || this.writing || this.now() < this.retryAt) return;
    if (!this.pendingBatch && this.queue.length === 0 && !this.needsPermit) return;
    this.writing = true;
    const controller = new AbortController();
    this.writeController = controller;
    this.emit();
    let renewedAfterExpiry = false;
    try {
      // Drain sequentially, including taps observed while a previous request was
      // in flight. Each immutable batch is <= 60 taps and has one run/sequence.
      while (!this.disposed && this.online && !controller.signal.aborted
        && (this.pendingBatch || this.queue.length > 0 || this.needsPermit)) {
        try {
          if (!this.pendingBatch && this.queue.length === 0 && this.deferredQueue.length > 0) {
            if (this.recordingStopped || this.session?.startedAt && !this.permitLive()) this.session = null;
          }
          if (!this.pendingBatch && this.session && !this.session.startedAt && this.now() >= this.sessionUntil) {
            this.session = null;
          }
          if (!this.session && !this.pendingBatch) {
            this.startRequest ??= { requestId: this.uuid(), ownerPublicId: this.ownerPublicId };
            if (!this.persist()) return;
            const result = await this.api.session(this.startRequest, controller.signal);
            if (this.disposed || controller.signal.aborted) return;
            if (result.progress.ownerPublicId !== this.ownerPublicId) { this.ownerChanged(); return; }
            this.session = result;
            const previousOffset = this.serverOffset;
            this.anchor(result.progress.serverTime);
            // Only the initial online burst, collected before the handshake, is normalized.
            // A stored modern permit is never replaced for delayed/ambiguous batches.
            for (const item of this.queue) item.times = item.times?.map(at => Math.floor(Math.max(Date.parse(result.startedAt ?? result.progress.serverTime), Math.min(Date.parse(result.progress.serverTime), at + this.serverOffset - previousOffset))));
            this.errorCode = null; this.recordingStopped = !!result.closedAt || Date.parse(result.expiresAt) <= Date.parse(result.progress.serverTime); this.needsPermit = this.deferredQueue.length > 0;
            this.sessionUntil = this.now() + Math.max(0, Date.parse(result.expiresAt) - Date.parse(result.progress.serverTime));
            this.startRequest = null; this.failed = false; this.failures = 0;
            this.adoptProgress(result.progress);
          }
          if (!this.pendingBatch && this.queue.length === 0 && this.deferredQueue.length > 0) {
            if (this.recordingStopped) { this.session = null; continue; }
            this.queue = this.deferredQueue; this.deferredQueue = []; this.catchUpMode = true; this.needsPermit = false;
          }
          if (!this.pendingBatch) {
            if (!this.session || !this.session.startedAt && this.now() >= this.sessionUntil) {
              this.session = null;
              throw new ApiError("Игровая сессия истекла", 409, { code: "GAME_SESSION_EXPIRED", message: "Игровая сессия истекла" });
            }
            const next = this.queue[0];
            if (!next) break;
            if (this.now() < this.nextDispatchAt) { await this.wait(this.nextDispatchAt - this.now(), controller.signal); continue; }
            // Reserve once at dispatch. Unknown-result retries reuse the same
            // immutable batch without charging these client tokens a second time.
            const instant = this.now();
            this.pacingTokens = Math.min(MAX_BATCH_TAPS,
              this.pacingTokens + Math.max(0, instant - this.pacingUpdatedAt) * TAPS_PER_SECOND / 1_000);
            this.pacingUpdatedAt = Math.max(instant, this.pacingUpdatedAt);
            if (this.pacingTokens < next.count) {
              await this.wait(Math.ceil((next.count - this.pacingTokens) * 1_000 / TAPS_PER_SECOND), controller.signal);
              continue;
            }
            this.pacingTokens -= next.count;
            this.queue.shift();
            this.pendingBatch = {
              sessionId: this.session.sessionId,
              sequence: this.session.nextSequence,
              tapCount: next.count,
              runId: next.runId,
              ...(this.session.startedAt && next.times && !next.deferred ? { tapTimes: next.times } : {}),
            };
          }
          const batch = this.pendingBatch;
          if (!this.persist()) return; // Write ahead of dispatch, including session + sequence.
          const result = await this.api.batch(batch, controller.signal);
          if (this.disposed || controller.signal.aborted) return;
          if (result.sessionId !== batch.sessionId || result.sequence !== batch.sequence
            || result.acceptedTaps + result.rejectedTaps !== batch.tapCount
            || !Number.isSafeInteger(result.runTaps) || result.runTaps < 0) {
            throw new ApiError("Сервер вернул некорректное подтверждение тапов", 502, { code: "RECEIPT_INVALID", message: "Некорректное подтверждение" });
          }
          // Clear the receipt exactly once, only after validating its owner and
          // acknowledgment. A replay must never be added as fresh local progress.
          if (result.progress.ownerPublicId !== this.ownerPublicId) { this.ownerChanged(); return; }
          // Start refill from acknowledgment, not dispatch: the request itself
          // may have reached the server late. Counting that network delay as
          // refill would send two full bursts almost simultaneously on recovery.
          this.pacingUpdatedAt = this.now();
          this.nextDispatchAt = this.now() + 2000;
          if (result.rejectedTaps > 0) this.pacingTokens = 0;
          const run = this.runs.get(batch.runId);
          if (run) {
            run.creditedTaps = (run.creditedTaps ?? run.acceptedTaps) + result.acceptedTaps;
            if (result.runTaps < run.acceptedTaps + result.acceptedTaps) run.interrupted = true;
            // Keep the server's bounded series count, including interruptions.
            // Lifetime totals include all tabs, but their separate runs cannot
            // be combined into a fabricated leaderboard record.
            run.acceptedTaps = result.runTaps;
          }
          this.rejectTaps(batch.runId, result.rejectedTaps);
          this.pendingBatch = null;
          if (this.session) this.session.nextSequence = batch.sequence + 1;
          if (this.failed) reportIncident(this.ownerPublicId, "game.batch", "SYNC_RECOVERED", this.snapshot().pendingTaps);
          this.failed = false; this.failures = 0;
          this.errorCode = result.rejectionCode ?? null;
          if (result.rejectionCode === "GAME_PERMIT_CLOSED") this.recordingStopped = true;
          this.needsPermit = this.deferredQueue.length > 0;
          if (this.catchUpMode && this.queue.length === 0 && this.deferredQueue.length === 0) {
            this.catchUpMode = false;
            this.serverAnchor = Math.max(this.eventNow(), Date.parse(result.progress.serverTime));
            this.anchorNow = this.now(); this.serverOffset = this.serverAnchor - this.wallNow();
          }
          if (result.rejectionCode) reportIncident(this.ownerPublicId, "game.batch", result.rejectionCode, this.snapshot().pendingTaps);
          this.retryAt = 0;
          this.adoptProgress(result.progress);
        } catch (error) {
          if (this.disposed) return;
          if (error instanceof ApiError && (error.status === 401 || error.body?.code === "GAME_OWNER_CHANGED")) {
            this.ownerChanged();
            return;
          }
          const expired = error instanceof ApiError && error.body?.code === "GAME_SESSION_EXPIRED" && !this.pendingBatch?.tapTimes;
          if (expired) {
            // Expired sessions return a receipt for a committed latest sequence
            // before rejecting new writes. Only an explicit non-commit expiry
            // may move these taps to a newly authorized session.
            if (this.pendingBatch) {
              this.queue.unshift({ runId: this.pendingBatch.runId, count: this.pendingBatch.tapCount });
              this.pacingTokens = Math.min(MAX_BATCH_TAPS, this.pacingTokens + this.pendingBatch.tapCount);
            }
            this.pendingBatch = null;
            this.session = null;
            this.startRequest = null;
            if (!renewedAfterExpiry && this.online && !controller.signal.aborted) {
              renewedAfterExpiry = true;
              continue;
            }
          } else if (error instanceof ApiError && ((error.status === 410 && (error.body?.code === "GAME_QUEUE_EXPIRED" || error.body?.code === "GAME_SESSION_GONE"))
            || error.status === 409 && error.body?.code === "GAME_SESSION_CONFLICT")) {
            this.archiveUnconfirmed(error);
            return;
          } else {
            // Unknown, gone or conflicting receipts stay intact for investigation.
            // Never re-envelope a modern permit's taps into another device/session.
          }
          if (!this.online && controller.signal.aborted) return;
          this.failure(error, this.startRequest ? "game.session" : "game.batch");
          return;
        }
      }
    } finally {
      this.writing = false;
      if (this.writeController === controller) this.writeController = null;
      this.emit();
    }
  }

  private failure(error: unknown, operation: string) {
    this.failed = true; this.failures += 1;
    this.errorCode = incidentCode(error); this.requestId = error instanceof ApiError ? error.requestId : undefined;
    const backoff = this.errorCode === "GAME_ACTIVE_ELSEWHERE" ? 30_000 : Math.min(60_000, RETRY_DELAY_MS * 2 ** Math.min(this.failures - 1, 5));
    this.retryAt = this.now() + Math.max(backoff, error instanceof ApiError ? error.retryAfterMs ?? 0 : 0);
    reportIncident(this.ownerPublicId, operation, this.errorCode, this.snapshot().pendingTaps, error);
  }

  private archiveUnconfirmed(error: ApiError): void {
    const previous = { queue: this.queue, session: this.session, pendingBatch: this.pendingBatch, startRequest: this.startRequest,
      run: this.run, runs: new Map(this.runs), archivedQueues: this.archivedQueues, recordingStopped: this.recordingStopped, needsPermit: this.needsPermit };
    const pendingTaps = this.snapshot().pendingTaps;
    this.archivedQueues = [...this.archivedQueues, { archivedAt: this.wallNow(),
      code: error.body!.code as GameJournal["archivedQueues"][number]["code"], requestId: error.requestId,
      queue: this.queue, pendingBatch: this.pendingBatch, session: this.session, startRequest: this.startRequest }];
    this.queue = []; this.pendingBatch = null; this.session = null; this.startRequest = null;
    this.run = this.run ? { ...this.run, interrupted: true } : null;
    if (this.run) this.runs.set(this.run.runId, this.run);
    this.recordingStopped = false; this.needsPermit = this.deferredQueue.length > 0;
    // Archive and active outbox change in one storage write. Never clear evidence
    // or authorize a fresh run if that write fails. An unknown ACK is not a rejection.
    if (!this.persist()) { Object.assign(this, previous); this.failed = true; return; }
    reportIncident(this.ownerPublicId, "game.batch", error.body!.code, pendingTaps, error);
    this.failed = false; this.failures = 0; this.retryAt = 0; this.errorCode = null; this.requestId = error.requestId;
  }

  dispose(): void {
    this.persist();
    this.disposed = true;
    this.writeController?.abort();
    this.readController?.abort();
  }
}
