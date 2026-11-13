import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "ru.zhiv.mochlik.lab",
  appName: "Мохлик · Тест",
  webDir: "dist",
  // Only bundled assets may call native plugins. No remote server.url or wildcard navigation.
  ios: { contentInset: "never" },
  android: { allowMixedContent: false },
};

export default config;
