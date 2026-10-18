/** Public, approximate weather only: this contract never contains an account or GPS fix. */
export type EarthWeatherCondition =
  | "clear" | "partly-cloudy" | "cloudy" | "fog"
  | "rain" | "snow" | "sleet" | "thunderstorm" | "unknown";

export interface EarthWeatherResponse {
  provider: "met-norway";
  latitude: number;
  longitude: number;
  condition: EarthWeatherCondition;
  temperatureC: number | null;
  cloudCoverPercent: number | null;
  /** Forecast accumulation for the next hour; never a six-hour total or an observation. */
  precipitationNextHourMm: number | null;
  windSpeedMps: number | null;
  forecastAt: string;
  updatedAt: string;
  expiresAt: string;
  /** Only known when the provider's symbol has an explicit _day/_night suffix. */
  isDay: boolean | null;
  stale: boolean;
}

export interface EarthWeatherErrorResponse {
  error: "invalid_coordinates" | "weather_unavailable" | "weather_busy";
  retryAfterSeconds?: number;
}

export const EARTH_WEATHER_ATTRIBUTION = {
  name: "MET Norway",
  sourceUrl: "https://api.met.no/",
  license: "CC BY 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  note: "На основе прогноза MET Norway; упрощённая визуализация",
} as const;
