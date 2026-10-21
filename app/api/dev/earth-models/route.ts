/** Only a local development checkout can persist landmark placement edits. */
function unavailableResponse() {
  return Response.json({ code: "EARTH_MODELS_UNAVAILABLE" }, {
    status: 404, headers: { "Cache-Control": "no-store" },
  });
}

export async function GET(request: Request) {
  if (process.env.NODE_ENV !== "development") return unavailableResponse();
  const { earthModelProjectFiles } = await import("@/lib/dev/earth-model-project-files.mjs");
  return earthModelProjectFiles.handle(request);
}

export async function POST(request: Request) {
  if (process.env.NODE_ENV !== "development") return unavailableResponse();
  const { earthModelProjectFiles } = await import("@/lib/dev/earth-model-project-files.mjs");
  return earthModelProjectFiles.handle(request);
}
