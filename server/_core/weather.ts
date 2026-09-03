// Sydney, Australia coordinates.
const LATITUDE = -33.8688;
const LONGITUDE = 151.2093;

export type DayForecast = {
  date: string; // YYYY-MM-DD
  rainChancePercent: number;
  tempMaxC: number;
  tempMinC: number;
  condition: string;
};

let cache: { fetchedAt: number; data: DayForecast[] } | null = null;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function describeWeatherCode(code: number): string {
  if (code === 0) return "Clear";
  if (code <= 3) return "Partly cloudy";
  if (code <= 48) return "Foggy";
  if (code <= 57) return "Drizzle";
  if (code <= 67) return "Rain";
  if (code <= 77) return "Snow";
  if (code <= 82) return "Rain showers";
  if (code <= 86) return "Snow showers";
  if (code <= 99) return "Thunderstorm";
  return "Unknown";
}

export async function getWeatherForecast(): Promise<DayForecast[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LATITUDE}&longitude=${LONGITUDE}&daily=precipitation_probability_max,temperature_2m_max,temperature_2m_min,weather_code&timezone=auto&forecast_days=10`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Weather API error: ${res.status}`);
  }
  const json = await res.json();

  const days: DayForecast[] = json.daily.time.map((date: string, i: number) => ({
    date,
    rainChancePercent: json.daily.precipitation_probability_max?.[i] ?? 0,
    tempMaxC: json.daily.temperature_2m_max?.[i] ?? null,
    tempMinC: json.daily.temperature_2m_min?.[i] ?? null,
    condition: describeWeatherCode(json.daily.weather_code?.[i] ?? -1),
  }));

  cache = { fetchedAt: Date.now(), data: days };
  return days;
}
