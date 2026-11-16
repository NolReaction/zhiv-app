"use client";

import { createContext, useCallback, useContext, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";

// Retain small form values when inactive sections are unmounted. No catalog,
// derived report or DOM is retained, and values never leave this page session.
const Session = createContext<Map<string, unknown> | null>(null);
export function BranchSession({ children }: { children: ReactNode }) {
  const [values] = useState(() => new Map<string, unknown>());
  return <Session.Provider value={values}>{children}</Session.Provider>;
}
export function useBranchState<T,>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const values = useContext(Session);
  const [value, setValue] = useState<T>(() => values?.has(key) ? values.get(key) as T : initial);
  const update = useCallback<Dispatch<SetStateAction<T>>>(next => {
    setValue(previous => {
      const result = typeof next === "function" ? (next as (value: T) => T)(previous) : next;
      values?.set(key, result);
      return result;
    });
  }, [key, values]);
  return [value, update];
}
