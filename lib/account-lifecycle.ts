import { z } from "zod";
import { authRequest } from "./auth-api";

export type AccountAction = "email" | "merge" | "delete";
export type AccountProofRole = "current" | "other" | "new-email";
export type ProfileSource = "current" | "other";
export type ProviderChoices = Partial<Record<"email" | "vk" | "telegram", ProfileSource>>;
const profile = z.object({ publicId: z.string(), displayName: z.string(), status: z.string().nullable() });
const lifecycleSchema = z.object({
  currentEmail: z.boolean(), currentMerge: z.boolean(), currentDelete: z.boolean(),
  other: profile.nullable(), newEmail: z.string().nullable(),
});
const previewSchema = z.object({
  preview: z.string(), current: profile, other: profile,
  displayName: z.string(), status: z.string().nullable(), effects: z.array(z.string()), conflicts: z.array(z.string()),
  providerConflicts: z.array(z.object({ provider: z.enum(["email", "vk", "telegram"]), current: z.string(), other: z.string() })),
  expiresInSeconds: z.number().positive(),
});
export type LifecycleState = z.infer<typeof lifecycleSchema>;
export type MergePreview = z.infer<typeof previewSchema>;
export const emptyLifecycle: LifecycleState = { currentEmail: false, currentMerge: false, currentDelete: false, other: null, newEmail: null };
export const getAccountLifecycle = () => authRequest("account/lifecycle", lifecycleSchema);
export const startAccountProof = (provider: "email" | "vk", action: AccountAction, role: AccountProofRole, email?: string) =>
  authRequest(`${provider}/start`, z.object({ flow: z.string(), url: z.string().nullable() }), { intent: "account", action, role, ...(email ? { email } : {}) });
export const verifyAccountProof = (flow: string, code: string) =>
  authRequest("email/verify", z.object({ status: z.literal("account-proof") }), { flow, code });
export const changeAccountEmail = (idempotencyKey: string) => authRequest("account/email", z.object({ status: z.literal("ok") }), { confirm: true, idempotencyKey });
export const previewAccountMerge = (displayNameSource: ProfileSource, statusSource: ProfileSource, providerChoices: ProviderChoices) =>
  authRequest("account/merge/preview", previewSchema, { displayNameSource, statusSource, providerChoices });
export const confirmAccountMerge = (preview: string) =>
  authRequest("account/merge/confirm", z.object({ status: z.literal("ok") }), { preview, confirm: true });
export const deleteAccountProfile = (idempotencyKey: string) =>
  authRequest("account/profile", z.object({ status: z.literal("ok") }), { confirm: true, idempotencyKey }, "DELETE");

export function currentAccountProved(state: LifecycleState, action: AccountAction): boolean {
  return action === "email" ? state.currentEmail : action === "merge" ? state.currentMerge : state.currentDelete;
}

export function resumeAccountAction(state: LifecycleState): AccountAction | null {
  if (state.currentMerge || state.other) return "merge";
  if (state.currentEmail || state.newEmail) return "email";
  if (state.currentDelete) return "delete";
  return null;
}
