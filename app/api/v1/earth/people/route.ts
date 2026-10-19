import { devEarthContext, devEarthResponse } from "@/lib/dev/earth-sharing-route";
import { getDevEarthPeople } from "@/lib/dev/earth-sharing-store";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const context = await devEarthContext(request); if (context.response) return context.response;
  return devEarthResponse(getDevEarthPeople(context.token));
}
