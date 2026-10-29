import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bearing, buildRoute, distanceAtTime, haversine, lerpAngle, routeToCSV, sampleAt } from '../ride/js/geo.js';

// ~1.1 km due north, climbing 55 m, ridden at 5 m/s with a 60 s stop in the middle.
function northLine() {
  const pts = [];
  for (let i = 0; i <= 100; i++) {
    pts.push({ lat: 40 + i * 0.0001, lng: -105, ele: 1600 + i * 0.55, t: i * 2.2 + (i > 50 ? 60 : 0) });
  }
  return pts;
}

test('haversine and bearing', () => {
  const a = { lat: 0, lng: 0 };
  assert.ok(Math.abs(haversine(a, { lat: 0, lng: 1 }) - 111195) < 10);
  assert.ok(Math.abs(bearing(a, { lat: 1, lng: 0 }) - 0) < 1e-9);
  assert.ok(Math.abs(bearing(a, { lat: 0, lng: 1 }) - 90) < 1e-9);
  assert.ok(Math.abs(bearing(a, { lat: 0, lng: -1 }) - 270) < 1e-9);
});

test('lerpAngle takes the short way round', () => {
  assert.equal(lerpAngle(350, 10, 0.5), 0);
  assert.equal(lerpAngle(10, 350, 0.5), 0);
});

test('buildRoute resamples evenly and derives grade/heading', () => {
  const r = buildRoute(northLine(), { step: 5 });
  assert.ok(Math.abs(r.total - 1112) < 5);
  assert.equal(r.dist[1] - r.dist[0], 5);
  assert.equal(r.dist[r.n - 1], r.total);
  const mid = sampleAt(r, r.total / 2);
  assert.ok(Math.abs(mid.grade - 0.0495) < 0.003, `grade ${mid.grade}`);
  assert.ok(mid.heading < 1 || mid.heading > 359);
  assert.ok(Math.abs(r.climb - 55) < 3);
});

test('stops are squeezed out of the replay timing', () => {
  const r = buildRoute(northLine(), { step: 5 });
  // 1112 m at 5 m/s is ~222 s; the 60 s stop must not survive in full.
  const total = r.time[r.n - 1];
  assert.ok(total > 215 && total < 245, `time ${total}`);
  assert.ok(Math.abs(distanceAtTime(r, total / 2) - r.total / 2) < 80);
  assert.equal(distanceAtTime(r, -1), 0);
  assert.equal(distanceAtTime(r, 1e9), r.total);
});

test('routes without time or elevation still work', () => {
  const r = buildRoute(northLine().map(({ lat, lng }) => ({ lat, lng })));
  assert.equal(r.hasTime, false);
  assert.equal(r.hasEle, false);
  assert.equal(sampleAt(r, 500).grade, 0);
  assert.ok(Math.abs(r.time[r.n - 1] - r.total / (25 / 3.6)) < 1);
});

test('rejects unusable tracks', () => {
  assert.throws(() => buildRoute([{ lat: 1, lng: 1 }]));
  assert.throws(() => buildRoute([{ lat: NaN, lng: 1 }, { lat: 1, lng: 1 }]));
});

test('CSV export has a header and one row per sample', () => {
  const r = buildRoute(northLine());
  const lines = routeToCSV(r).split('\n');
  assert.equal(lines[0], 'lat,lng,ele,distance,grade,heading');
  assert.equal(lines.length, r.n + 1);
});

import { attachElevation } from '../ride/js/geo.js';

test('attachElevation interpolates a distance profile onto points', () => {
  const pts = northLine().map(({ lat, lng }) => ({ lat, lng }));
  const total = haversine(pts[0], pts.at(-1));
  const out = attachElevation(pts, [
    { d: 0, ele: 100 },
    { d: total / 2, ele: 150 },
    { d: total, ele: 120 },
  ]);
  assert.equal(out[0].ele, 100);
  assert.ok(Math.abs(out[50].ele - 150) < 0.5);
  assert.ok(Math.abs(out[100].ele - 120) < 0.5);
  assert.ok(Math.abs(out[25].ele - 125) < 0.5);
});
