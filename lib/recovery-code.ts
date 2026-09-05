
import { createCapabilityToken, isCapabilityToken } from "@/lib/capability-token";
export const RECOVERY_CODE_PREFIX = "ZHIV-R1-";
export function createRecoveryCode(): string { return RECOVERY_CODE_PREFIX + createCapabilityToken(); }
export function normalizeRecoveryCode(value: string): string | null {
  const code=value.trim();
  return code.startsWith(RECOVERY_CODE_PREFIX) && isCapabilityToken(code.slice(RECOVERY_CODE_PREFIX.length)) ? code : null;
}
