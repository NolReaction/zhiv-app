import { z } from "zod";

export const onboardingCourseSchema = z.enum(["app", "world"]);
export const onboardingStatusSchema = z.enum(["completed", "skipped"]);
const owner = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/);
export const onboardingAccountSchema = z.object({ ownerPublicId: owner,
  app: onboardingStatusSchema.nullable(), world: onboardingStatusSchema.nullable() }).strict();
export const onboardingDecisionSchema = z.object({ ownerPublicId: owner,
  course: onboardingCourseSchema, status: onboardingStatusSchema }).strict();
export type OnboardingCourse = z.infer<typeof onboardingCourseSchema>;
export type OnboardingStatus = z.infer<typeof onboardingStatusSchema>;
export type OnboardingAccount = z.infer<typeof onboardingAccountSchema>;
export type OnboardingDecision = z.infer<typeof onboardingDecisionSchema>;
/** A delayed skip can never undo completion on another device. No reward is granted here. */
export function mergeOnboardingStatus(a: OnboardingStatus | null, b: OnboardingStatus | null): OnboardingStatus | null {
  return a === "completed" || b === "completed" ? "completed" : a ?? b;
}
