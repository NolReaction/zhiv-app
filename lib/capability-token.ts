export const CAPABILITY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function createCapabilityToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function isCapabilityToken(value: string): boolean {
  return CAPABILITY_TOKEN_PATTERN.test(value);
}

export function capabilityUrl(kind: "invite" | "recover", token: string): string {
  const url = new URL(window.location.origin);
  url.hash = `/${kind}/${token}`;
  return url.toString();
}
