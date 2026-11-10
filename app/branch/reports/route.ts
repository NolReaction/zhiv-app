import { readAdminPageAccess } from "@/lib/server/admin-page-access";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow, noarchive" };

export async function GET(request: Request) {
  const access = await readAdminPageAccess(request);
  if (access.status !== "allowed") return Response.json({ code: "BRANCH_ACCESS_REQUIRED", message: "Требуется доступ администратора" },
    { status: access.status === "signed-out" ? 401 : access.status === "forbidden" ? 403 : 503, headers });
  const { default: report } = await import("@/features/progression/data/progression-scenarios.json");
  return Response.json(report, { headers });
}
