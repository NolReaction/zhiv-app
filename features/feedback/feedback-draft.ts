import { feedbackCategorySchema, feedbackRequestSchema, type FeedbackCategory, type FeedbackRequest } from "./feedback-api";

export type FeedbackDraft = { category: FeedbackCategory; message: string; pending: FeedbackRequest | null };
export const emptyFeedbackDraft = (): FeedbackDraft => ({ category: "bug", message: "", pending: null });
const key = (owner: string) => `zhiv.feedback-draft.v1:${owner}`;

export function readFeedbackDraft(owner: string, storage: Pick<Storage, "getItem">): FeedbackDraft {
  try {
    const value = JSON.parse(storage.getItem(key(owner)) ?? "null");
    if (!value || typeof value.message !== "string" || value.message.length > 6000 || !feedbackCategorySchema.safeParse(value.category).success) return emptyFeedbackDraft();
    const pending = feedbackRequestSchema.safeParse(value.pending);
    // An uncertain request must be retried with its exact original body.
    if (pending.success) return pending.data.expectedOwnerPublicId === owner ? { category: pending.data.category, message: pending.data.message, pending: pending.data } : emptyFeedbackDraft();
    return { category: value.category, message: value.message, pending: null };
  } catch { return emptyFeedbackDraft(); }
}

export function writeFeedbackDraft(owner: string, draft: FeedbackDraft, storage: Pick<Storage, "setItem" | "removeItem">): boolean {
  try {
    if (!draft.message && !draft.pending) storage.removeItem(key(owner));
    else storage.setItem(key(owner), JSON.stringify(draft));
    return true;
  } catch { return false; }
}
