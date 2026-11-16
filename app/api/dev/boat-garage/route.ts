/** The assembly editor persists only a local development checkout. */
function unavailableResponse() {
  return Response.json({ code: "GARAGE_PROJECT_UNAVAILABLE" }, {
    status: 404, headers: { "Cache-Control": "no-store" },
  });
}

export async function GET(request: Request) {
  if (process.env.NODE_ENV !== "development") return unavailableResponse();
  const { garageProjectFiles } = await import("@/lib/dev/boat-garage-project-files.mjs");
  return garageProjectFiles.handle(request);
}

export async function POST(request: Request) {
  if (process.env.NODE_ENV !== "development") return unavailableResponse();
  const { garageProjectFiles } = await import("@/lib/dev/boat-garage-project-files.mjs");
  return garageProjectFiles.handle(request);
}

export async function PUT(request: Request) {
  if (process.env.NODE_ENV !== "development") return unavailableResponse();
  const { garageProjectFiles } = await import("@/lib/dev/boat-garage-project-files.mjs");
  return garageProjectFiles.handle(request);
}
