import type { Metadata, Viewport } from "next";
import { ServiceWorkerRegistration } from "@/components/service-worker-registration";
import { AppNotifications } from "@/components/app-notifications";
import { PwaInstallProvider } from "@/features/pwa/install-provider";
import { AuxiliaryAppRuntime } from "@/features/app/auxiliary-app-runtime";
import { BRAND_APPLE_ICON_SRC, BRAND_FAVICON_SRC, BRAND_ICON_32_SRC, BRAND_ICON_192_SRC, BRAND_LOGO_SRC } from "@/lib/brand-assets";
import "./globals.css";

export const metadata: Metadata = {
  title: "Я живой",
  description: "Будьте на связи с близкими и обживайте уютный лесной мир Мохлика.",
  applicationName: "Я живой",
  other: {
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
  maximumScale: 5,
  userScalable: true,
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
      </head>
      <body>
        <PwaInstallProvider>{children}</PwaInstallProvider>
        <AppNotifications />
        <ServiceWorkerRegistration />
        <AuxiliaryAppRuntime />
      </body>
    </html>
  );
}
