import { mergeOnboardingStatus, onboardingDecisionSchema, type OnboardingAccount } from "@/lib/onboarding-contract";
import { getDevIdentity } from "./api-store";
import { DevEconomyError } from "./economy-store";
import { getDevOnboardingClaimedAt } from "./progression-rewards-store";
import { devOnboardingState } from "./onboarding-state";

export function getDevOnboarding(token: string | undefined, expectedOwner: string): OnboardingAccount {
  const identity = getDevIdentity(token);
  if (!identity) throw new DevEconomyError("UNAUTHORIZED", "Войдите в аккаунт", 401);
  const owner = identity.user.publicId;
  if (owner !== expectedOwner) throw new DevEconomyError("ONBOARDING_OWNER_CHANGED", "Аккаунт изменился", 409);
  const state = devOnboardingState().get(owner) ?? { ownerPublicId: owner, app: null, world: null };
  return getDevOnboardingClaimedAt(owner) ? { ownerPublicId: owner, app: "completed", world: "completed" } : { ...state };
}
export function saveDevOnboarding(token: string | undefined, input: unknown) {
  const parsed = onboardingDecisionSchema.safeParse(input);
  if (!parsed.success) throw new DevEconomyError("INVALID_ONBOARDING", "Некорректный запрос обучения", 400);
  const decision = parsed.data;
  const state = getDevOnboarding(token, decision.ownerPublicId);
  state[decision.course] = mergeOnboardingStatus(state[decision.course], decision.status);
  devOnboardingState().set(decision.ownerPublicId, state);
  return { ...state };
}
