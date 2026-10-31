import test from 'node:test';
import assert from 'node:assert/strict';
import { fogDensity, skyState, sunPosition } from '../ride/js/terrain/sun.js';
import { parseWeather } from '../ride/js/terrain/weather.js';

const deg = (r) => (r * 180) / Math.PI;

test('sun is high in the south at solar noon on the June solstice in Seattle', () => {
  const s = sunPosition(new Date('2026-06-21T20:10:00Z'), 47.61, -122.33); // ~13:10 PDT
  assert.ok(Math.abs(deg(s.elevation) - 65.8) < 1, `elevation ${deg(s.elevation)}`);
  assert.ok(Math.abs(deg(s.azimuth) - 180) < 4, `azimuth ${deg(s.azimuth)}`);
});

test('sun sets in the south-west in late October and is down at night', () => {
  const sunset = sunPosition(new Date('2026-11-01T00:56:00Z'), 47.61, -122.33); // 17:56 PDT; official sunset is -0.83° (refraction, sun's radius)
  assert.ok(Math.abs(deg(sunset.elevation) + 0.83) < 1.2, `elevation ${deg(sunset.elevation)}`);
  assert.ok(deg(sunset.azimuth) > 243 && deg(sunset.azimuth) < 255, `azimuth ${deg(sunset.azimuth)}`);
  const midnight = sunPosition(new Date('2026-11-01T07:00:00Z'), 47.61, -122.33);
  assert.ok(deg(midnight.elevation) < -40);
});

test('sky state goes from night to day with the sun', () => {
  assert.equal(skyState(-0.5, 0).day, 0);
  assert.equal(skyState(0.6, 0).day, 1);
  assert.ok(skyState(0.02, 0).golden > 0.5);
  assert.ok(skyState(0.6, 1).sun < skyState(0.6, 0).sun);
});

test('haze thickens as visibility drops', () => {
  assert.ok(fogDensity(40000) < 2e-5);
  assert.ok(fogDensity(1000) > fogDensity(10000));
  const at = (d, v) => 1 - Math.exp(-((fogDensity(v) * d) ** 2));
  assert.ok(at(100000, 40000) < 0.8, 'distant peaks show on a clear day');
  assert.ok(at(1000, 1000) > 0.6, 'fog hides things beyond the visibility');
});

test('Open-Meteo codes map to rain, snow and fog', () => {
  assert.ok(parseWeather({ weather_code: 61, rain: 1.2, cloud_cover: 100 }).rain > 0);
  assert.equal(parseWeather({ weather_code: 61, rain: 1.2 }).snow, 0);
  assert.ok(parseWeather({ weather_code: 73, snowfall: 0.5 }).snow > 0);
  assert.equal(parseWeather({ weather_code: 45, visibility: 300 }).fog, true);
  const clear = parseWeather({ weather_code: 0, cloud_cover: 6, visibility: 28500 });
  assert.deepEqual([clear.rain, clear.snow, clear.cloud], [0, 0, 0.06]);
});

test('moon phase: new at the April 2024 eclipse, full two weeks later', async () => {
  const { moonPosition } = await import('../ride/js/terrain/sun.js');
  const eclipse = new Date('2024-04-08T18:18:00Z');
  const m = moonPosition(eclipse, 32.78, -96.8); // Dallas, totality
  const s = sunPosition(eclipse, 32.78, -96.8);
  assert.ok(m.fraction < 0.01, `fraction ${m.fraction}`);
  const sep = Math.acos(Math.sin(m.elevation) * Math.sin(s.elevation) + Math.cos(m.elevation) * Math.cos(s.elevation) * Math.cos(m.azimuth - s.azimuth));
  assert.ok(deg(sep) < 2, `moon ${deg(sep)}° from the sun during totality`);
  assert.ok(moonPosition(new Date('2024-04-23T23:49:00Z'), 47.6, -122.3).fraction > 0.99);
});
