/** Installed by the native entry before importing the shared application. */
export type ClientPlatform = {
  kind: "ios" | "android";
  appVersion: string;
  login(): Promise<void>;
  logout(): Promise<void>;
  openAccount(): Promise<void>;
  openDiagnostics(): void;
};

let platform: ClientPlatform | null = null;

/** The website keeps its normal browser implementation unless explicitly configured. */
export function configureClientPlatform(next: ClientPlatform): void {
  platform = next;
}

export function getClientPlatform(): ClientPlatform | null {
  return platform;
}
