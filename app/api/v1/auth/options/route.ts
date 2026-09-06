import { guardDevApi } from "@/lib/dev-api-guard";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const rejected = guardDevApi(request);
  if (rejected) return rejected;
  // Real provider authentication belongs to Ktor. Never emulate verified identities here.
  return Response.json({ telegram: false, email: false }, { headers: { "Cache-Control": "no-store" } });
}
