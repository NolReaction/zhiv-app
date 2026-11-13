import { installApiTransport } from "@/lib/api-fetch";
import { NativeBridge } from "./native-bridge";
import { createMobileApiTransport } from "./mobile-api-transport";
import { prepareNativeRequest } from "./native-storage";
import type { MobileSessionSnapshot } from "./mobile-session";

export async function initializeMobileTransport(session: () => MobileSessionSnapshot): Promise<void> {
  installApiTransport(createMobileApiTransport(NativeBridge, {
    origin: import.meta.env.VITE_MOBILE_API_ORIGIN || "https://im-alive.ru",
    prepare: prepareNativeRequest,
    session,
  }));
}
