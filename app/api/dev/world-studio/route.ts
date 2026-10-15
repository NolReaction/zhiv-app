/** The editor writes only the local checkout, never account data or production. */
function unavailableResponse() {
  return Response.json({ available: false, code: "STUDIO_PROJECT_UNAVAILABLE" }, {
    status: 404, headers: { "Cache-Control": "no-store" },
  });
}

export async function GET(request: Request) {
  if (process.env.NODE_ENV !== "development") return unavailableResponse();
  const { worldStudioProjectFiles } = await import("@/lib/dev/world-studio-project-files.mjs");
  return worldStudioProjectFiles.handle(request);
}

export async function POST(request: Request) {
  if (process.env.NODE_ENV !== "development") return unavailableResponse();
  const { worldStudioProjectFiles } = await import("@/lib/dev/world-studio-project-files.mjs");
  return worldStudioProjectFiles.handle(request);
}
