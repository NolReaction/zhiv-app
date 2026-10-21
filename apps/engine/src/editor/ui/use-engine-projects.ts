"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SceneDocument } from "@/packages/engine/src/scene/document";
import { validProjectName } from "@/packages/engine/src/scene/document";
import { createIndexedDbProjectRepository, type ProjectRepository, type ProjectSummary } from "@/apps/engine/src/editor/projects/project-repository";
import { createProjectSession, type ProjectSessionState } from "@/apps/engine/src/editor/projects/project-session";
import { migrateLegacyLocalStorage } from "@/apps/engine/src/editor/projects/legacy-migration";
import { createProjectDocument, parseProjectDocument, type CreateProjectOptions } from "@/apps/engine/src/editor/scene/project-document";
import { SCENE_STORAGE_KEY } from "@/apps/engine/src/editor/scene/editor-scene";
import type { EngineProfiler } from "@/apps/engine/src/editor/diagnostics/engine-profiler";

type Session = ReturnType<typeof createProjectSession>;
const initialState: ProjectSessionState = { document: null, saveState: "saved", revision: 0, savedRevision: 0, error: null, busy: false };
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const activeProjectKey = "zhiv:engine:active-project";

/** React owns only the view. The captured session keeps the last committed document
 * through asynchronous writes and StrictMode cleanup; no new mount closes an old mount's refs. */
export function useEngineProjects(profiler: EngineProfiler) {
  const repository = useRef<ProjectRepository | null>(null), session = useRef<Session | null>(null), mounted = useRef(false), operation = useRef(false);
  const [state, setState] = useState<ProjectSessionState>(initialState), [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [activation, setActivation] = useState(0);
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    const ownedRepository = createIndexedDbProjectRepository();
    const ownedSession = createProjectSession(ownedRepository, {
      onChange: next => {
        if (cancelled) return;
        setState(next);
        if (next.document && next.saveState === "saved") { try { window.localStorage.setItem(activeProjectKey, next.document.id); } catch { /* Project data remains in IndexedDB. */ } }
      },
      onSaveMeasured: milliseconds => profiler.record("save", milliseconds),
    });
    repository.current = ownedRepository; session.current = ownedSession;
    const initializing = (async () => {
      let initial: SceneDocument | null = null, persisted = false, recoveredLegacy: SceneDocument | null = null;
      try {
        let legacy: Storage | null = null;
        try { legacy = window.localStorage; } catch { /* The project repository still works when localStorage is denied. */ }
        try { const raw = legacy?.getItem(SCENE_STORAGE_KEY); if (raw) recoveredLegacy = parseProjectDocument(raw); } catch { /* Migration reports the readable storage error below. */ }
        try {
          const migrated = await migrateLegacyLocalStorage(ownedRepository, legacy);
          if (migrated.migrated && !cancelled) setNotice("Прежняя сцена перенесена в отдельный проект. Исходный JSON оставлен в браузере.");
        } catch (cause) { if (!cancelled) setError(errorText(cause)); }
        const items = await ownedRepository.list();
        if (cancelled) return;
        setProjects(items);
        let preferred: string | null = null;
        try { preferred = window.localStorage.getItem(activeProjectKey); } catch { /* Optional UI preference. */ }
        const summary = items.find(item => item.id === preferred) ?? items[0];
        if (summary) { initial = await ownedRepository.load(summary.id); persisted = initial !== null; }
      } catch (cause) {
        if (!cancelled) setError(`Хранилище проектов недоступно: ${errorText(cause)}. Сцену можно редактировать и скачать как JSON.`);
      }
      if (cancelled) return;
      initial ??= recoveredLegacy ?? createProjectDocument({ name: "Лесной проект" });
      await ownedSession.activate(initial, { persisted });
      if (!cancelled) { setActivation(value => value + 1); setLoading(false); }
    })().catch(cause => { if (!cancelled) { setError(errorText(cause)); setLoading(false); } });
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const current = ownedSession.getState();
      if (current.savedRevision < current.revision) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      cancelled = true; mounted.current = false;
      window.removeEventListener("beforeunload", beforeUnload);
      if (repository.current === ownedRepository) repository.current = null;
      if (session.current === ownedSession) session.current = null;
      // Never clear a newer StrictMode mount or depend on pagehide for durable storage.
      void initializing.then(() => ownedSession.close()).catch(() => { void ownedRepository.close(); });
    };
  }, [profiler]);

  const refresh = useCallback(async () => {
    const owned = repository.current; if (!owned) return;
    try { const items = await owned.list(); if (mounted.current && repository.current === owned) setProjects(items); }
    catch (cause) { if (mounted.current && repository.current === owned) setError(errorText(cause)); }
  }, []);
  const run = useCallback(async <T,>(label: string, action: (target: Session, store: ProjectRepository) => Promise<T>): Promise<T | null> => {
    const target = session.current, store = repository.current;
    if (!target || !store || operation.current) return null;
    operation.current = true; setBusy(label); setError(null); setNotice(null);
    try {
      const result = await action(target, store);
      if (result && typeof result === "object" && "version" in result && mounted.current && session.current === target) setActivation(value => value + 1);
      return result;
    }
    catch (cause) { if (mounted.current && session.current === target) setError(errorText(cause)); return null; }
    finally {
      operation.current = false;
      if (mounted.current && session.current === target) { setBusy(null); void refresh(); }
    }
  }, [refresh]);
  const open = useCallback((id: string) => run("Открываем проект…", target => target.open(id)), [run]);
  const create = useCallback((options: CreateProjectOptions) => run("Создаём проект…", async target => {
    await target.flush(); return target.activate(createProjectDocument(options));
  }), [run]);
  const activate = useCallback((document: SceneDocument) => run("Импортируем проект…", target => target.activate(document)), [run]);
  const save = useCallback(() => run("Сохраняем проект…", async target => { await target.retry(); return true; }), [run]);
  const duplicate = useCallback((id: string) => run("Копируем проект…", async (target, store) => {
    await target.flush();
    const source = await store.load(id); if (!source) throw new Error("Проект не найден. Обнови список.");
    const copy = await store.duplicate(id, `${source.name.slice(0, 90)} · копия`);
    return target.activate(copy, { persisted: true });
  }), [run]);
  const rename = useCallback((id: string, name: string, renameActive: (name: string) => boolean) => run("Переименовываем проект…", async (target, store) => {
    const trimmed = name.trim(); if (!validProjectName(trimmed)) throw new Error("Название должно содержать от 1 до 100 символов без управляющих символов.");
    if (target.getState().document?.id === id) {
      if (!renameActive(trimmed)) throw new Error("Не удалось переименовать активный проект.");
      await target.flush();
    } else {
      await target.flush(); const document = await store.load(id); if (!document) throw new Error("Проект не найден.");
      await store.save({ ...document, name: trimmed });
    }
    return true;
  }), [run]);
  const reopenSaved = useCallback(() => run("Читаем сохранённую версию…", target => target.reopenSaved()), [run]);
  const remove = useCallback((id: string, expectedRevision?: number) => run("Удаляем проект…", async (target, store) => {
    await target.flush();
    const active = target.getState().document?.id === id, revision = active ? store.getRevision(id) : expectedRevision;
    if (active) {
      const remaining = (await store.list()).find(item => item.id !== id), next = remaining ? await store.load(remaining.id) : null;
      await target.activate(next ?? createProjectDocument({ name: "Новый проект", presetId: "empty-v1" }), { persisted: next !== null });
      await target.flush();
      if (mounted.current && session.current === target) setActivation(value => value + 1);
    }
    await store.delete(id, revision ?? undefined); return true;
  }), [run]);
  const update = useCallback((document: SceneDocument) => {
    const current = session.current;
    if (current?.getState().document?.id === document.id) current.update(document);
  }, []);
  const flush = useCallback(async () => { await session.current?.flush(); }, []);
  return { state, projects, loading, busy, error, notice, activation, session, update, refresh, open, create, activate, save, duplicate, rename, remove, reopenSaved, flush };
}
export type EngineProjects = ReturnType<typeof useEngineProjects>;
