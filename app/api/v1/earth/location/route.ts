import { earthPositionStopSchema, earthPositionWriteSchema } from "@/lib/earth-sharing-contract";
import { devEarthContext, devEarthError, devEarthResponse, readDevEarthBody } from "@/lib/dev/earth-sharing-route";
import { putDevEarthPosition, stopDevEarthPosition } from "@/lib/dev/earth-sharing-store";

export const dynamic = "force-dynamic";
export async function PUT(request: Request) {
  const context = await devEarthContext(request, true); if (context.response) return context.response;
  const input = await readDevEarthBody(request); if (input.response) return input.response;
  const parsed = earthPositionWriteSchema.safeParse(input.value);
  return parsed.success ? devEarthResponse(putDevEarthPosition(context.token, parsed.data)) : devEarthError(400, "INVALID_EARTH_POSITION");
}
export async function DELETE(request: Request) {
  const context = await devEarthContext(request, true); if (context.response) return context.response;
  const input = await readDevEarthBody(request); if (input.response) return input.response;
  const parsed = earthPositionStopSchema.safeParse(input.value);
  return parsed.success ? devEarthResponse(stopDevEarthPosition(context.token, parsed.data)) : devEarthError(400, "INVALID_EARTH_POSITION");
}
