import type { Metadata, Viewport } from "next";
import { AdminDashboard } from "@/features/admin/admin-dashboard";

export const metadata: Metadata = {
  title: "Управление · Я живой",
  description: "Закрытая панель управления приложением «Я живой».",
  robots: { index: false, follow: false, noarchive: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  minimumScale: 1,
  maximumScale: 5,
  userScalable: true,
  viewportFit: "cover",
  themeColor: "#131713",
};

export default function AdminPage() {
  return <AdminDashboard />;
}
