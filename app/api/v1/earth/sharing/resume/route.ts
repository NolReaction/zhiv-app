import { earthSharingResumeSchema } from "@/lib/earth-sharing-contract";
import { devEarthContext, devEarthError, devEarthResponse, readDevEarthBody } from "@/lib/dev/earth-sharing-route";
import { resumeDevEarthSharing } from "@/lib/dev/earth-sharing-store";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const context = await devEarthContext(request, true); if (context.response) return context.response;
  const input = await readDevEarthBody(request); if (input.response) return input.response;
  const parsed = earthSharingResumeSchema.safeParse(input.value);
  return parsed.success ? devEarthResponse(resumeDevEarthSharing(context.token, parsed.data)) : devEarthError(400, "INVALID_EARTH_SHARING");
}
