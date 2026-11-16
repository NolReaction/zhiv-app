import type { EarthSharingSettings } from "@/lib/earth-sharing-contract";

export type NativeEarthPublication = {
  epoch: string | null; active: boolean; lastPublishedAt: string | null; error: string | null; sessionLost?: boolean;
};
export type NativeEarthPublisher = {
  adopt(settings: EarthSharingSettings, options: { requestPermission: boolean }): Promise<void>;
  stop(): void;
  canContinueInBackground(): boolean;
  subscribe(listener: (state: NativeEarthPublication) => void): () => void;
};
let factory: ((ownerPublicId: string) => NativeEarthPublisher) | null = null;

/** Installed by the bundled mobile entry only; web/PWA keeps its existing publisher. */
export function installNativeEarthPublisherFactory(value: typeof factory) { factory = value; }
export function createNativeEarthPublisher(owner: string | null): NativeEarthPublisher | null { return owner && factory ? factory(owner) : null; }

export type BackgroundLocationChoice = { available: boolean; enabled: boolean; busy: boolean; error: string | null };
const unavailable: BackgroundLocationChoice = { available: false, enabled: false, busy: false, error: null };
let choice = unavailable;
const listeners = new Set<() => void>();
let setEnabled: ((enabled: boolean) => Promise<void>) | null = null;
export const backgroundLocationChoice = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  getSnapshot: () => choice, getServerSnapshot: () => unavailable,
  async setEnabled(enabled: boolean) { await setEnabled?.(enabled); },
};
export function installBackgroundLocationChoice(setter: (enabled: boolean) => Promise<void>) { setEnabled = setter; }
export function updateBackgroundLocationChoice(value: BackgroundLocationChoice) { choice = value; for (const listener of listeners) listener(); }
