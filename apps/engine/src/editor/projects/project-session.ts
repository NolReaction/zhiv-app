import { cloneSceneDocument, type SceneDocument } from "@/packages/engine/src/scene/document";
import type { ProjectRepository } from "./project-repository";

export type ProjectSaveState = "saved" | "pending" | "saving" | "error";
export type ProjectSessionState = {
  document: SceneDocument | null; saveState: ProjectSaveState; revision: number; savedRevision: number; error: Error | null; busy: boolean;
};
type Scheduler = (callback: () => void) => () => void;
type SessionOptions = {
  onChange?: (state: ProjectSessionState) => void;
  scheduleSave?: Scheduler;
  onSaveMeasured?: (durationMs: number, success: boolean) => void;
};
function scheduleSave(callback: () => void) { const timeout = setTimeout(callback, 250); return () => clearTimeout(timeout); }
function clock() { return typeof performance === "undefined" ? Date.now() : performance.now(); }
function asError(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }

/** Only a committed latest revision is "saved". A project switch waits for all
 * edits, including revisions submitted while an earlier write was running. */
export function createProjectSession(repository: ProjectRepository, options: SessionOptions = {}) {
  let state: ProjectSessionState = { document: null, saveState: "saved", revision: 0, savedRevision: 0, error: null, busy: false };
  let cancellation: (() => void) | undefined, draining: Promise<void> | undefined, closed = false, closing = false;
  let activeTransition: Promise<unknown> | undefined, closingPromise: Promise<void> | undefined;
  let persistedRevision: number | undefined;
  let recovering = false;
  const listeners = new Set<() => void>(), schedule = options.scheduleSave ?? scheduleSave;

  function publish(patch: Partial<ProjectSessionState>) {
    state = { ...state, ...patch };
    options.onChange?.(state);
    for (const listener of listeners) listener();
  }
  function assertOpen() { if (closed) throw new Error("Сессия проекта закрыта."); }
  function assertWritable() { assertOpen(); if (closing) throw new Error("Сессия проекта закрывается."); }
  function cancelScheduled() { cancellation?.(); cancellation = undefined; }
  function requestSave() {
    if (cancellation || draining || closed || closing || recovering) return;
    let completed = false;
    const cancel = schedule(() => { completed = true; cancellation = undefined; void flush().catch(() => {}); });
    if (!completed) cancellation = cancel;
  }

  async function drain() {
    while (state.document && state.savedRevision < state.revision) {
      const document = cloneSceneDocument(state.document), revision = state.revision, started = clock();
      publish({ saveState: "saving", error: null });
      try {
        const saved = await repository.save(document, persistedRevision);
        if (saved?.revision !== undefined) persistedRevision = saved.revision;
        options.onSaveMeasured?.(clock() - started, true);
      } catch (cause) {
        const error = asError(cause);
        options.onSaveMeasured?.(clock() - started, false);
        publish({ saveState: "error", error });
        throw error;
      }
      publish({ savedRevision: revision, saveState: revision === state.revision ? "saved" : "pending", error: null });
    }
  }

  function flush(): Promise<void> {
    assertOpen(); cancelScheduled();
    if (draining) return draining;
    draining = drain().finally(() => {
      draining = undefined;
      // A subscriber can enqueue an edit in a microtask after the last saved
      // notification, before this cleanup executes. Keep that edit scheduled.
      if (state.document && state.savedRevision < state.revision && state.saveState !== "error") { publish({ saveState: "pending" }); requestSave(); }
    });
    return draining;
  }

  async function flushLatest() {
    do { await flush(); } while (state.document && state.savedRevision < state.revision);
  }

  function transition<T>(operation: () => Promise<T>): Promise<T> {
    try { assertWritable(); }
    catch (error) { return Promise.reject(error); }
    if (state.busy) return Promise.reject(new Error("Дождись завершения операции с проектом."));
    publish({ busy: true });
    const result = operation().catch(cause => {
      const error = asError(cause); publish({ error, saveState: state.savedRevision < state.revision ? "error" : state.saveState }); throw error;
    }).finally(() => { activeTransition = undefined; publish({ busy: false }); });
    activeTransition = result;
    return result;
  }

  function install(document: SceneDocument, persisted: boolean) {
    persistedRevision = persisted ? repository.getRevision?.(document.id) : 0;
    publish({ document: cloneSceneDocument(document), revision: persisted ? 0 : 1, savedRevision: 0, saveState: persisted ? "saved" : "pending", error: null });
    if (!persisted) requestSave();
    return state.document!;
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    update(document: SceneDocument) {
      assertWritable();
      if (!state.document || state.document.id !== document.id) throw new Error("Сначала открой этот проект перед редактированием.");
      publish({ document: cloneSceneDocument(document), revision: state.revision + 1, saveState: draining ? "saving" : "pending", error: null });
      requestSave();
    },
    flush,
    retry: flush,
    activate: (document: SceneDocument, activation: { persisted?: boolean } = {}) => transition(async () => {
      const snapshot = cloneSceneDocument(document);
      await flushLatest();
      return install(snapshot, activation.persisted === true);
    }),
    open: (id: string) => transition(async () => {
      await flushLatest();
      // Reopening the current project preserves the document just flushed.
      // Discarding local edits for an external version belongs to reopenSaved.
      if (state.document?.id === id) return cloneSceneDocument(state.document);
      const document = await repository.load(id);
      if (!document) throw new Error("Проект не найден. Обнови список проектов.");
      // An active scene can still receive a completed gesture during loading.
      await flushLatest();
      return install(document, true);
    }),
    /** Explicit UI confirmation owns discarding changes. Failed or stale loads
     * keep the old exportable document and never pretend it was saved. */
    reopenSaved: (id = state.document?.id) => transition(async () => {
      if (!id) throw new Error("Нет активного проекта для повторного открытия.");
      recovering = true; cancelScheduled();
      try {
        await draining?.catch(() => {});
        const activeRevision = state.revision, document = await repository.load(id);
        if (!document) throw new Error("Сохранённый проект удалён. Экспортируй текущую сцену и создай новый проект.");
        if (state.revision !== activeRevision) throw new Error("Сцена изменилась во время загрузки. Повтори открытие сохранённой версии.");
        cancelScheduled();
        return install(document, true);
      } finally { recovering = false; }
    }),
    close(): Promise<void> {
      if (closed) return Promise.resolve();
      if (closingPromise) return closingPromise;
      closing = true; cancelScheduled();
      closingPromise = (async () => {
        await activeTransition?.catch(() => {});
        publish({ busy: true });
        try {
          await flushLatest(); await repository.close(); closed = true;
          listeners.clear();
        } catch (cause) {
          const error = asError(cause); publish({ error, saveState: "error" }); throw error;
        } finally { closing = false; closingPromise = undefined; publish({ busy: false }); }
      })();
      return closingPromise;
    },
  };
}
