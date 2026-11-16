import { withRequestDeadline } from "@/lib/request-deadline";

export type AdminPageAccess = { status: "allowed"; publicId: string } | { status: "signed-out" | "forbidden" | "unavailable" };

function sessionToken(request: Request, name: string) {
  const values = (request.headers.get("cookie") ?? "").split(";").map(value => value.trim())
    .filter(value => value.startsWith(`${name}=`)).map(value => value.slice(name.length + 1));
  return values.length === 1 && /^[A-Za-z0-9_-]{16,128}$/.test(values[0]) ? values[0] : undefined;
}

/** Server entry points only. Never derive the upstream URL from request headers. */
export async function readAdminPageAccess(request: Request): Promise<AdminPageAccess> {
  if (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test") {
    const [{ trustedDevAdminRequest, devAdminAllowed }, { getDevIdentity, SESSION_COOKIE }] = await Promise.all([
      import("@/lib/dev/admin-access"), import("@/lib/dev/api-store"),
    ]);
    if (!trustedDevAdminRequest(request)) return { status: "forbidden" };
    const token = sessionToken(request, SESSION_COOKIE), identity = getDevIdentity(token);
    if (!identity) return { status: "signed-out" };
    return devAdminAllowed(token) ? { status: "allowed", publicId: identity.user.publicId } : { status: "forbidden" };
  }
  if (process.env.NODE_ENV !== "production") return { status: "unavailable" };
  const token = sessionToken(request, "__Host-zhiv_session");
  if (!token) return { status: "signed-out" };
  let origin: URL;
  try {
    origin = new URL(process.env.ADMIN_API_ORIGIN ?? "");
    if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password
      || origin.pathname !== "/" || origin.search || origin.hash) return { status: "unavailable" };
  } catch { return { status: "unavailable" }; }
  try {
    return await withRequestDeadline<AdminPageAccess>(7000, request.signal, async signal => {
      const response = await fetch(new URL("/api/v1/admin/access", origin), { method: "GET", cache: "no-store", redirect: "error", signal,
        headers: { Accept: "application/json", Cookie: `__Host-zhiv_session=${token}` } });
      if (response.status === 401) return { status: "signed-out" };
      if (response.status === 403) return { status: "forbidden" };
      if (!response.ok) return { status: "unavailable" };
      const value: unknown = await response.json();
      if (!value || typeof value !== "object" || !("publicId" in value) || typeof value.publicId !== "string"
        || !/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/.test(value.publicId)) return { status: "unavailable" };
      return { status: "allowed", publicId: value.publicId };
    });
  } catch { return { status: "unavailable" }; }
}
