"use client";

import { usePathname } from "next/navigation";
import { MobileGestureGuard } from "@/components/mobile-gesture-guard";
import { AppLifecycle } from "@/features/updates/app-lifecycle-view";

/** Public content does not start the client game lifecycle. The root owns its
 * runtime inside the installation gate, so it cannot block a new visitor. */
export function AuxiliaryAppRuntime() {
  const pathname = usePathname();
  if (!pathname || pathname === "/" || pathname === "/site" || pathname.startsWith("/site/")) return null;
  return <><MobileGestureGuard /><AppLifecycle /></>;
}
