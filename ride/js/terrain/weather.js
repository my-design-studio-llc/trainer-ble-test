// Current weather at the rider's position from Open-Meteo (free, no key, CORS enabled).

import { FAIR_WEATHER } from './sun.js';

export const WEATHER_ATTRIBUTION = 'Weather: Open-Meteo.com';
const REFRESH_MS = 15 * 60 * 1000;

/** Maps an Open-Meteo "current" block to what the sky and precipitation need. */
export function parseWeather(c) {
  const code = c.weather_code ?? 0;
  const snowing = c.snowfall > 0 || (code >= 71 && code <= 77) || code === 85 || code === 86;
  const raining = !snowing && (c.rain > 0 || c.showers > 0 || (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95);
  const rate = snowing ? (c.snowfall || 0.3) * 1.5 : c.precipitation || c.rain || 0.5; // mm/h (snow: cm/h)
  return {
    code,
    cloud: Math.min(1, Math.max(0, (c.cloud_cover ?? 0) / 100)),
    visibility: c.visibility ?? FAIR_WEATHER.visibility,
    fog: code === 45 || code === 48,
    rain: raining ? Math.min(1, 0.25 + rate / 6) : 0,
    snow: snowing ? Math.min(1, 0.25 + rate / 2) : 0,
    windSpeed: c.wind_speed_10m ?? 0,
    windDir: c.wind_direction_10m ?? 0,
    temperature: c.temperature_2m,
  };
}

export async function fetchWeather(lat, lng) {
  const fields = 'temperature_2m,weather_code,cloud_cover,visibility,precipitation,rain,showers,snowfall,wind_speed_10m,wind_direction_10m';
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}&current=${fields}`);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  return parseWeather((await res.json()).current);
}

/** Keeps the weather for wherever the rider is, refreshed every 15 minutes. */
export class LiveWeather {
  constructor() {
    this.current = FAIR_WEATHER;
    this.at = 0;
    this.busy = false;
  }

  poll(lat, lng) {
    if (this.busy || Date.now() - this.at < REFRESH_MS) return;
    this.busy = true;
    fetchWeather(lat, lng)
      .then((w) => (this.current = w), (err) => console.warn('weather unavailable', err))
      .finally(() => {
        this.at = Date.now();
        this.busy = false;
      });
  }
}
