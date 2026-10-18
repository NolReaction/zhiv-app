import { z } from "zod";
import { guardDevApi } from "@/lib/dev/api-guard";
import { devSessionToken, parseUuid } from "@/lib/dev/api-route";
import { notificationOwnerSchema } from "@/features/notifications/notification-contract";
import { readDevMail } from "@/lib/dev/mail-store";
import { devMailResponse, mailError, readDevMailBody } from "@/lib/dev/mail-route";

export const dynamic = "force-dynamic";
const bodySchema = z.object({ expectedOwnerPublicId: notificationOwnerSchema }).strict();
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejected = guardDevApi(request, true, 1024);
  if (rejected) return rejected;
  const rawId = (await context.params).id, id = parseUuid(rawId);
  if (!id || id !== rawId || [...new URL(request.url).searchParams].length) return mailError();
  const body = await readDevMailBody(request);
  if (body.response) return body.response;
  const parsed = bodySchema.safeParse(body.value);
  if (!parsed.success || parsed.data.expectedOwnerPublicId !== (body.value as { expectedOwnerPublicId: string }).expectedOwnerPublicId) return mailError();
  return devMailResponse(readDevMail(await devSessionToken(), parsed.data.expectedOwnerPublicId, id));
}
