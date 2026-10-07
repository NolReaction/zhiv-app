import type { Metadata, Viewport } from "next";
import { ServiceWorkerRegistration } from "@/components/service-worker-registration";
import { AppNotifications } from "@/components/app-notifications";
import { MobileGestureGuard } from "@/components/mobile-gesture-guard";
import { AppLifecycle } from "@/features/updates/app-lifecycle-view";
import { BRAND_APPLE_ICON_SRC, BRAND_FAVICON_SRC, BRAND_ICON_32_SRC, BRAND_ICON_192_SRC, BRAND_LOGO_SRC } from "@/lib/brand-assets";
import runtimeArt from "@/features/world/runtime-art.json";
import "./globals.css";

export const metadata: Metadata = {
  title: "Я живой",
  description: "Одна кнопка, чтобы близкие знали: вы живы и на связи.",
  applicationName: "Я живой",
  other: {
    "codex-preview": "development",
    "mobile-web-app-capable": "yes",
  },
  icons: {
    icon: [
      { url: BRAND_ICON_32_SRC, sizes: "32x32", type: "image/png" },
      { url: BRAND_ICON_192_SRC, sizes: "192x192", type: "image/png" },
    ],
    shortcut: BRAND_FAVICON_SRC,
    apple: { url: BRAND_APPLE_ICON_SRC, sizes: "180x180", type: "image/png" },
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Я живой",
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  minimumScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#11140f",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <head>
        <link rel="preload" as="image" href={BRAND_LOGO_SRC} fetchPriority="high" />
        <link rel="preload" as="image" href={runtimeArt.homePreview} fetchPriority="high" />
      </head>
      <body>
        <MobileGestureGuard />
        {children}
        <AppNotifications />
        <ServiceWorkerRegistration />
        <AppLifecycle />
      </body>
    </html>
  );
}
