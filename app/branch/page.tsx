import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { BranchAccessGate } from "@/features/progression/access/branch-access-gate";
import { readAdminPageAccess } from "@/lib/server/admin-page-access";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Внутренняя мастерская · Я живой",
  description: "Закрытые инструменты развития и проверки игрового мира.",
  robots: { index: false, follow: false, noarchive: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  viewportFit: "cover",
  themeColor: "#171d16",
};

export default async function ProgressionPage() {
  const requestHeaders = await headers();
  const access = await readAdminPageAccess(new Request("http://localhost/branch", { headers: requestHeaders }));
  return <BranchAccessGate key={access.status === "allowed" ? access.publicId : access.status} initial={access} />;
}
