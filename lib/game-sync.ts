import { ApiError } from "@/lib/check-in-api";
import { createUuidV4 } from "@/lib/browser-uuid";
import {
  createGameSession, getGameProgress, submitGameBatch,
  type GameBatchRequest, type GameBatchResponse, type GameProgress,
  type GameSession, type GameSessionRequest,
} from "@/lib/game-api";

export type GameSyncStatus = "loading" | "ready" | "syncing" | "offline" | "error";
export type GameSyncSnapshot = { progress: GameProgress | null; status: GameSyncStatus; pendingTaps: number };
type QueuedTaps = { runId: string; count: number; queuedAt: number };
type GameTransport = {
  progress(signal: AbortSignal): Promise<GameProgress>;
  session(body: GameSessionRequest, signal: AbortSignal): Promise<GameSession>;
  batch(body: GameBatchRequest, signal: AbortSignal): Promise<GameBatchResponse>;
};
const transport: GameTransport = { progress: getGameProgress, session: createGameSession, batch: submitGameBatch };
const MAX_PENDING_TAPS = 60;
const MAX_QUEUE_AGE_MS = 5_000;
const RETRY_DELAY_MS = 3_000;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// This queue contains only taps observed while this page is online. Legacy local
// counters never enter it; progress always comes from authenticated server replies.
export class GameSyncClient {
  private progress: GameProgress | null = null;
  private queue: QueuedTaps[] = [];
  private session: GameSession | null = null;
  private sessionUntil = 0;
  private startRequest: GameSessionRequest | null = null;
  private pendingBatch: GameBatchRequest | null = null;
  private writing = false;
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
  ) { this.online = online; }

  snapshot(): GameSyncSnapshot {
    const pendingTaps = this.queue.reduce((sum, item) => sum + item.count, 0) + (this.pendingBatch?.tapCount ?? 0);
    return {
      progress: this.progress,
      pendingTaps,
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
      this.queue = [];
      // Preserve the immutable in-flight batch: the server may have received it.
      this.writeController?.abort();
      this.readController?.abort();
    }
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

  recordTap(steps: number, runId: string): void {
    if (this.disposed || !this.online || !Number.isSafeInteger(steps) || steps < 1 || !RUN_ID.test(runId)) return;
    if (this.failed && this.pendingBatch) { void this.flush(); return; }
    if (this.failed && this.now() < this.retryAt) return;
    this.failed = false;
    const now = this.now();
    if (this.session && now >= this.sessionUntil && !this.pendingBatch) {
      this.session = null;
      this.queue = [];
    }
    this.pruneQueue();
    const room = MAX_PENDING_TAPS - this.queue.reduce((sum, item) => sum + item.count, 0);
    const count = Math.min(steps, room);
    if (count < 1) return;
    const last = this.queue.at(-1);
    if (last?.runId === runId) last.count += count;
    else this.queue.push({ runId, count, queuedAt: now });
    this.emit();
    if (!this.session && !this.writing) void this.flush();
  }

  private pruneQueue(): void {
    const cutoff = this.now() - MAX_QUEUE_AGE_MS;
    this.queue = this.queue.filter(item => item.queuedAt >= cutoff);
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

  async flush(): Promise<void> {
    if (this.disposed || !this.online || this.writing || this.now() < this.retryAt) return;
    const hadQueue = this.queue.length > 0;
    this.pruneQueue();
    if (!this.pendingBatch && this.queue.length === 0) {
      this.startRequest = null;
      if (hadQueue) this.emit();
      return;
    }
    this.writing = true;
    const controller = new AbortController();
    this.writeController = controller;
    this.emit();
    try {
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
      this.pruneQueue();
      if (!this.pendingBatch) {
        if (!this.session || this.now() >= this.sessionUntil) {
          this.session = null;
          this.queue = [];
          return;
        }
        const next = this.queue.shift();
        if (!next) { this.failed = false; return; }
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
        || result.acceptedTaps + result.rejectedTaps !== batch.tapCount) {
        throw new ApiError("Сервер вернул некорректное подтверждение тапов", 502);
      }
      this.adoptProgress(result.progress);
      if (this.disposed) return;
      this.pendingBatch = null;
      if (this.session) this.session.nextSequence = batch.sequence + 1;
      this.failed = false;
      this.retryAt = 0;
    } catch (error) {
      if (this.disposed) return;
      if (error instanceof ApiError && (error.status === 401 || error.body?.code === "GAME_OWNER_CHANGED")) {
        this.ownerChanged();
        return;
      }
      this.queue = [];
      const terminal = error instanceof ApiError && [400, 403, 404, 409, 410, 413, 422].includes(error.status);
      if (terminal) {
        this.pendingBatch = null;
        this.session = null;
        this.startRequest = null;
      }
      // A terminal response is known not to have added taps. A timeout/5xx has
      // unknown outcome; keep precisely the same batch for its eventual retry.
      this.failed = !terminal;
      this.retryAt = this.now() + RETRY_DELAY_MS;
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
