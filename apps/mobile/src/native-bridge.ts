import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export interface NativeSessionState {
  authenticated: boolean;
  configured: boolean;
  userId?: string;
  expiresAt?: string;
}

export interface NativeRequest {
  id: string;
  expectedUserId?: string;
  path: string;
  method: string;
  headers?: Record<string, string>;
  /** Base64 encoded bytes, including multipart boundaries when applicable. */
  body?: string;
}

export interface NativeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface MochlikNativePlugin {
  getState(): Promise<NativeSessionState>;
  login(): Promise<NativeSessionState>;
  cancelLogin(): Promise<void>;
  logout(): Promise<void>;
  request(options: NativeRequest): Promise<NativeResponse>;
  cancelRequest(options: { id: string }): Promise<void>;
  openWebsite(options: { path: string }): Promise<void>;
  getSafeArea(): Promise<NativeSafeArea>;
  addListener(event: "sessionChange", listener: (state: NativeSessionState) => void): Promise<PluginListenerHandle>;
  addListener(event: "memoryWarning", listener: (event: { level?: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: "safeAreaChange", listener: (insets: NativeSafeArea) => void): Promise<PluginListenerHandle>;
}

export interface NativeSafeArea { top: number; right: number; bottom: number; left: number }

export const MOBILE_REQUEST_MAX_BYTES = 6 * 1024 * 1024;
export const MOBILE_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;

// The bridge never exposes the access token or accepts a runtime backend origin.
export const NativeBridge = registerPlugin<MochlikNativePlugin>("MochlikNative");
