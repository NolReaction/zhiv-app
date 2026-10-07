import { devForestMemoryContext, devForestMemoryResponse, readDevForestMemoryBody } from "@/lib/dev/forest-memory-route";
import { commandDevForestMemory } from "@/lib/dev/forest-memory-store";

export async function POST(request: Request) {
  const context = await devForestMemoryContext(request, true);
  if (context.response) return context.response;
  const body = await readDevForestMemoryBody(request);
  if (body.response) return body.response;
  return devForestMemoryResponse(() => commandDevForestMemory(context.token, body.body));
}
