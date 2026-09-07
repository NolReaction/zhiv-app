import { ApiError } from "@/lib/check-in-api";
import { createUuidV4 } from "@/lib/browser-uuid";
import {
  createGameSession, getGameProgress, submitGameBatch,
  type GameBatchRequest, type GameBatchResponse, type GameProgress,
  type GameSession, type GameSessionRequest,
} from "@/lib/game-api";

export type GameSyncStatus = "loading" | "ready" | "syncing" | "offline" | "error";
export type GameRunSync = {
  runId: string;
  acceptedTaps: number;
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
};
type QueuedTaps = { runId: string; count: number };
type GameTransport = {
  progress(signal: AbortSignal): Promise<GameProgress>;
  session(body: GameSessionRequest, signal: AbortSignal): Promise<GameSession>;
  batch(body: GameBatchRequest, signal: AbortSignal): Promise<GameBatchResponse>;
};
const transport: GameTransport = { progress: getGameProgress, session: createGameSession, batch: submitGameBatch };
const MAX_BATCH_TAPS = 60;
const MAX_PENDING_TAPS = 3_600;
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

// This queue contains only taps observed while this page is online. Legacy local
// counters never enter it; progress always comes from authenticated server replies.
export class GameSyncClient {
  private progress: GameProgress | null = null;
  private queue: QueuedTaps[] = [];
  private session: GameSession | null = null;
  private run: Omit<GameRunSync, "pendingTaps"> | null = null;
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

  constructor(
    private readonly ownerPublicId: string,
    online: boolean,
    private readonly onChange: (snapshot: GameSyncSnapshot) => void,
    private readonly onSessionLost: () => void,
    private readonly api: GameTransport = transport,
    private readonly now: () => number = () => performance.now(),
    private readonly uuid: () => string = createUuidV4,
    private readonly wait: (delayMs: number, signal: AbortSignal) => Promise<void> = waitForPacing,
  ) { this.online = online; this.pacingUpdatedAt = this.now(); }

  snapshot(): GameSyncSnapshot {
    const pendingTaps = this.queue.reduce((sum, item) => sum + item.count, 0) + (this.pendingBatch?.tapCount ?? 0);
    return {
      progress: this.progress,
      pendingTaps,
      rejectedTaps: this.rejectedTaps,
      run: this.run ? { ...this.run, pendingTaps:
        this.queue.reduce((sum, item) => sum + (item.runId === this.run?.runId ? item.count : 0), 0)
        + (this.pendingBatch?.runId === this.run.runId ? this.pendingBatch.tapCount : 0),
      } : null,
      status: !this.online ? "offline" : this.failed ? "error"
        : pendingTaps > 0 || this.writing ? "syncing"
          : this.progress ? "ready" : "loading",
    };
  }

  private emit(): void { if (!this.disposed) this.onChange(this.snapshot()); }

  setOnline(online: boolean): void {
    if (this.disposed || this.online === online) return;
    this.online = online;
    if (!online) {
      // Preserve observed online taps and the immutable in-flight batch. No new
      // offline taps enter the queue, and the server still decides every count.
      this.writeController?.abort();
      this.readController?.abort();
    } else this.retryAt = 0;
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
    this.emit();
  }

  private ownerChanged(): void {
    this.dispose();
    this.onSessionLost();
  }

  recordTap(steps: number, runId: string): number {
    if (this.disposed || !this.online || !Number.isSafeInteger(steps) || steps < 1 || !RUN_ID.test(runId)) return 0;
    if (this.run?.runId !== runId) {
      this.run = { runId, acceptedTaps: 0, rejectedTaps: 0, interrupted: false };
    }
    const pending = this.queue.reduce((sum, item) => sum + item.count, 0) + (this.pendingBatch?.tapCount ?? 0);
    const count = Math.min(steps, MAX_PENDING_TAPS - pending);
    let remaining = count;
    while (remaining > 0) {
      const last = this.queue.at(-1);
      const item = last?.runId === runId && last.count < MAX_BATCH_TAPS
        ? last : { runId, count: 0 };
      if (item !== last) this.queue.push(item);
      const chunk = Math.min(remaining, MAX_BATCH_TAPS - item.count);
      item.count += chunk;
      remaining -= chunk;
    }
    this.rejectTaps(runId, steps - count);
    this.emit();
    if (!this.session || this.queue[0]?.count === MAX_BATCH_TAPS) void this.flush();
    return count;
  }

  private rejectTaps(runId: string, count: number): void {
    this.rejectedTaps += count;
    if (this.run?.runId === runId) this.run.rejectedTaps += count;
  }

  async refresh(): Promise<void> {
    if (this.disposed || !this.online || this.reading) return;
    this.reading = true;
    const version = ++this.readVersion;
    const controller = new AbortController();
    this.readController = controller;
    try {
      const progress = await this.api.progress(controller.signal);
      if (this.disposed || controller.signal.aborted || version !== this.readVersion) return;
      this.adoptProgress(progress);
      if (!this.pendingBatch && !this.startRequest) this.failed = false;
    } catch (error) {
      if (this.disposed || controller.signal.aborted || version !== this.readVersion) return;
      if (error instanceof ApiError && error.status === 401) { this.ownerChanged(); return; }
      this.failed = true;
    } finally {
      this.reading = false;
      if (this.readController === controller) this.readController = null;
      this.emit();
    }
  }

  flush(): Promise<void> {
    if (this.flushOperation) return this.flushOperation;
    const operation = this.flushPending();
    this.flushOperation = operation;
    void operation.then(() => { if (this.flushOperation === operation) this.flushOperation = null; },
      () => { if (this.flushOperation === operation) this.flushOperation = null; });
    return operation;
  }

  private async flushPending(): Promise<void> {
    if (this.disposed || !this.online || this.writing || this.now() < this.retryAt) return;
    if (!this.pendingBatch && this.queue.length === 0) return;
    this.writing = true;
    const controller = new AbortController();
    this.writeController = controller;
    this.emit();
    let renewedAfterExpiry = false;
    try {
      // Drain sequentially, including taps observed while a previous request was
      // in flight. Each immutable batch is <= 60 taps and has one run/sequence.
      while (!this.disposed && this.online && !controller.signal.aborted
        && (this.pendingBatch || this.queue.length > 0)) {
        try {
          if (!this.pendingBatch && this.session && this.now() >= this.sessionUntil) {
            this.session = null;
          }
          if (!this.session && !this.pendingBatch) {
            this.startRequest ??= { requestId: this.uuid(), ownerPublicId: this.ownerPublicId };
            const result = await this.api.session(this.startRequest, controller.signal);
            if (this.disposed || controller.signal.aborted) return;
            if (result.progress.ownerPublicId !== this.ownerPublicId) { this.ownerChanged(); return; }
            this.session = result;
            this.sessionUntil = this.now() + Math.max(0, Date.parse(result.expiresAt) - Date.parse(result.progress.serverTime));
            this.startRequest = null;
            this.adoptProgress(result.progress);
          }
          if (!this.pendingBatch) {
            if (!this.session || this.now() >= this.sessionUntil) {
              this.session = null;
              throw new ApiError("Игровая сессия истекла", 409, { code: "GAME_SESSION_EXPIRED", message: "Игровая сессия истекла" });
            }
            const next = this.queue[0];
            if (!next) break;
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
            };
          }
          const batch = this.pendingBatch;
          const result = await this.api.batch(batch, controller.signal);
          if (this.disposed || controller.signal.aborted) return;
          if (result.sessionId !== batch.sessionId || result.sequence !== batch.sequence
            || result.acceptedTaps + result.rejectedTaps !== batch.tapCount
            || !Number.isSafeInteger(result.runTaps) || result.runTaps < 0) {
            throw new ApiError("Сервер вернул некорректное подтверждение тапов", 502);
          }
          // Clear the receipt exactly once, only after validating its owner and
          // acknowledgment. A replay must never be added as fresh local progress.
          if (result.progress.ownerPublicId !== this.ownerPublicId) { this.ownerChanged(); return; }
          // Start refill from acknowledgment, not dispatch: the request itself
          // may have reached the server late. Counting that network delay as
          // refill would send two full bursts almost simultaneously on recovery.
          this.pacingUpdatedAt = this.now();
          if (result.rejectedTaps > 0) this.pacingTokens = 0;
          if (this.run?.runId === batch.runId) {
            if (result.runTaps < this.run.acceptedTaps + result.acceptedTaps) this.run.interrupted = true;
            this.run.acceptedTaps = result.runTaps;
          }
          this.rejectTaps(batch.runId, result.rejectedTaps);
          this.pendingBatch = null;
          if (this.session) this.session.nextSequence = batch.sequence + 1;
          this.failed = false;
          this.retryAt = 0;
          this.adoptProgress(result.progress);
        } catch (error) {
          if (this.disposed) return;
          if (error instanceof ApiError && (error.status === 401 || error.body?.code === "GAME_OWNER_CHANGED")) {
            this.ownerChanged();
            return;
          }
          const expired = error instanceof ApiError && error.body?.code === "GAME_SESSION_EXPIRED";
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
          } else {
            const terminal = error instanceof ApiError && [400, 403, 404, 409, 410, 413, 422].includes(error.status);
            if (terminal) {
              if (this.pendingBatch) this.rejectTaps(this.pendingBatch.runId, this.pendingBatch.tapCount);
              this.pendingBatch = null;
              this.session = null;
              this.startRequest = null;
            }
            // Timeout/5xx/429 have an unknown outcome. Keep the exact batch and
            // all later observed taps, then retry this sequence before the next.
          }
          this.failed = true;
          this.retryAt = this.now() + RETRY_DELAY_MS;
          return;
        }
      }
    } finally {
      this.writing = false;
      if (this.writeController === controller) this.writeController = null;
      this.emit();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.queue = [];
    this.pendingBatch = null;
    this.startRequest = null;
    this.writeController?.abort();
    this.readController?.abort();
  }
}
