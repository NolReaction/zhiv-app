import { devForestMemoryContext, devForestMemoryResponse, forestMemoryError } from "@/lib/dev/forest-memory-route";
import { readDevForestMemory } from "@/lib/dev/forest-memory-store";

export async function GET(request: Request) {
  const context = await devForestMemoryContext(request);
  if (context.response) return context.response;
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some(key => key !== "expectedOwnerPublicId" && key !== "clientId")
    || query.getAll("expectedOwnerPublicId").length !== 1 || query.getAll("clientId").length !== 1)
    return forestMemoryError();
  return devForestMemoryResponse(() => readDevForestMemory(context.token, {
    expectedOwnerPublicId: query.get("expectedOwnerPublicId"), clientId: query.get("clientId"),
  }));
}
