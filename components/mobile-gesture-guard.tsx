"use client";

import { useEffect } from "react";
import { installBrowserZoomGuard } from "@/lib/browser-zoom-guard";

export function MobileGestureGuard() {
  useEffect(() => installBrowserZoomGuard(document), []);
  return null;
}
