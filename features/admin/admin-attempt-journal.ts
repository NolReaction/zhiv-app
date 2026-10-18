import type { z } from "zod";

type Kind = "grant" | "adjust" | "mail" | "manage" | "reward";
export const adminAttemptKey = (kind: Kind, actor: string, target: string) => `zhiv:admin-${kind}:${actor}:${target}`;
export function readAdminAttempt<T>(kind: Kind, actor: string, target: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(adminAttemptKey(kind, actor, target));
    if (!raw) return null;
    const result = schema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch { return null; }
}
export function saveAdminAttempt(kind: Kind, actor: string, target: string, value: object | null): boolean {
  try {
    const key = adminAttemptKey(kind, actor, target);
    if (value) window.sessionStorage.setItem(key, JSON.stringify(value));
    else window.sessionStorage.removeItem(key);
    return true;
  } catch { return false; }
}
