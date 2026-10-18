import { guardDevApi } from "@/lib/dev/api-guard";
import { devSessionToken } from "@/lib/dev/api-route";
import { notificationOwnerSchema } from "@/features/notifications/notification-contract";
import { getDevMail } from "@/lib/dev/mail-store";
import { devMailResponse, mailError } from "@/lib/dev/mail-route";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const rejected = guardDevApi(request);
  if (rejected) return rejected;
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some(key => !["expectedOwnerPublicId", "cursor", "limit"].includes(key))
    || query.getAll("expectedOwnerPublicId").length !== 1 || query.getAll("cursor").length > 1 || query.getAll("limit").length > 1) return mailError();
  const owner = notificationOwnerSchema.safeParse(query.get("expectedOwnerPublicId"));
  const rawLimit = query.get("limit") ?? "20";
  if (!owner.success || owner.data !== query.get("expectedOwnerPublicId") || !/^\d+$/.test(rawLimit)) return mailError();
  return devMailResponse(getDevMail(await devSessionToken(), owner.data, query.get("cursor") ?? undefined, Number(rawLimit)));
}
