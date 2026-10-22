import type { OnboardingAccount } from "@/lib/onboarding-contract";
const globalStore = globalThis as typeof globalThis & { __zhivDevOnboarding?: Map<string, OnboardingAccount> };
export const devOnboardingState = () => globalStore.__zhivDevOnboarding ??= new Map();
export const resetDevOnboardingState = () => { delete globalStore.__zhivDevOnboarding; };
