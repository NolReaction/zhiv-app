"use client";

import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { browserInstallEnvironment, INITIAL_INSTALL_SNAPSHOT, PwaInstallController } from "./install-controller";

const InstallContext = createContext<PwaInstallController | null>(null);

export function PwaInstallProvider({ children }: { children: ReactNode }) {
  const [controller] = useState(() => new PwaInstallController(browserInstallEnvironment()));
  useEffect(() => { controller.start(); return controller.stop; }, [controller]);
  return <InstallContext.Provider value={controller}>{children}</InstallContext.Provider>;
}

export function usePwaInstall() {
  const controller = useContext(InstallContext);
  if (!controller) throw new Error("PWA installation UI requires PwaInstallProvider");
  const snapshot = useSyncExternalStore(controller.subscribe, controller.snapshot, () => INITIAL_INSTALL_SNAPSHOT);
  return { ...snapshot, install: controller.install, stopWaiting: controller.stopWaiting, allowBrowser: controller.allowBrowser };
}
