import { ApiError } from "@/lib/check-in-api";
import { gameplayGenerationHeaders, reportGameplayReset } from "@/lib/gameplay-generation";
import { onboardingAccountSchema, type OnboardingDecision } from "@/lib/onboarding-contract";
import { withRequestDeadline, retryAfterMs } from "@/lib/request-deadline";

export function requestOnboardingAccount(owner: string, decision?: OnboardingDecision, signal?: AbortSignal) {
  return withRequestDeadline(8_000, signal, async deadline => {
    const generation = gameplayGenerationHeaders();
    const response = await fetch(`/api/v1/onboarding${decision ? "" : `?ownerPublicId=${encodeURIComponent(owner)}`}`, {
      method: decision ? "POST" : "GET", credentials: "same-origin", cache: "no-store", signal: deadline,
      headers: { ...generation, Accept: "application/json", ...(decision ? { "Content-Type": "application/json" } : {}) },
      ...(decision ? { body: JSON.stringify(decision) } : {}),
    });
    const value = await response.json().catch(() => null);
    if (!response.ok) {
      reportGameplayReset(value?.code, generation);
      throw new ApiError("Не удалось синхронизировать обучение", response.status, value,
        response.headers.get("X-Request-ID"), retryAfterMs(response.headers.get("Retry-After")));
    }
    const parsed = onboardingAccountSchema.parse(value);
    if (parsed.ownerPublicId !== owner) throw new ApiError("Аккаунт изменился", 409);
    return parsed;
  });
}
