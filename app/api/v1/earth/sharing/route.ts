import { earthSharingWriteSchema } from "@/lib/earth-sharing-contract";
import { devEarthContext, devEarthError, devEarthResponse, readDevEarthBody } from "@/lib/dev/earth-sharing-route";
import { getDevEarthSharing, putDevEarthSharing } from "@/lib/dev/earth-sharing-store";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const context = await devEarthContext(request); if (context.response) return context.response;
  return devEarthResponse(getDevEarthSharing(context.token));
}
export async function PUT(request: Request) {
  const context = await devEarthContext(request, true); if (context.response) return context.response;
  const input = await readDevEarthBody(request); if (input.response) return input.response;
  const parsed = earthSharingWriteSchema.safeParse(input.value);
  return parsed.success ? devEarthResponse(putDevEarthSharing(context.token, parsed.data)) : devEarthError(400, "INVALID_EARTH_SHARING");
}
