import { createEarthWeatherHandler } from "@/lib/server/earth-weather";

// Public forecast proxy, independent from the development-only account/game API.
// HTTP caching is set by the adapter; the handler itself must see query coordinates.
const weather = createEarthWeatherHandler();

export async function GET(request: Request) {
  return weather(request);
}
