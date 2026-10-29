import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { haversine } from '../ride/js/geo.js';
import { LocalFrame, decodeTerrarium, lngLatToTile, tileToLngLat, tileWidthMeters } from '../ride/js/terrain/tiles.js';
import { inferTrailProfile } from '../ride/js/terrain/profile.js';
import { canopyScore, mulberry32, scatterTrees } from '../ride/js/terrain/vegetation.js';

const runs = (flags) => {
  const out = [];
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] && !flags[i - 1]) {
      let j = i;
      while (flags[j]) j++;
      out.push([i, j]);
    }
  }
  return out;
};

test('tile math round-trips and matches known tiles', () => {
  const t = lngLatToTile(-122.1816, 47.6032, 15);
  assert.equal(Math.floor(t.x), 5262);
  assert.equal(Math.floor(t.y), 11444);
  const ll = tileToLngLat(t.x, t.y, 15);
  assert.ok(Math.abs(ll.lat - 47.6032) < 1e-9 && Math.abs(ll.lng + 122.1816) < 1e-9);
  assert.ok(Math.abs(tileWidthMeters(47.6, 15) - 825) < 5);
});

test('Terrarium decoding', () => {
  // 32768 + 12.5 m -> R=128, G=12, B=128
  assert.deepEqual([...decodeTerrarium(Uint8Array.from([128, 12, 128, 255, 127, 255, 0, 255]))], [12.5, -1]);
});

test('LocalFrame distances agree with haversine and round-trip', () => {
  const f = new LocalFrame(47.6, -122.18);
  const a = { lat: 47.6, lng: -122.18 };
  const b = { lat: 47.65, lng: -122.2 };
  const p = f.project(b.lat, b.lng);
  assert.ok(Math.abs(Math.hypot(p.x, p.z) - haversine(a, b)) < 3);
  assert.ok(p.z < 0 && p.x < 0); // north is -z, west is -x
  const back = f.unproject(p.x, p.z);
  assert.ok(Math.abs(back.lat - b.lat) < 1e-9 && Math.abs(back.lng - b.lng) < 1e-9);
});

test('real Eastrail DEM profile: the Wilburton Trestle is found, underpass hump removed', () => {
  const { ground, step } = JSON.parse(fs.readFileSync(new URL('./fixtures/eastrail-wilburton-ground.json', import.meta.url)));
  const { ele, bridge, underpass } = inferTrailProfile(ground, step);
  const mile = (i) => (i * step) / 1609.344;

  // Wilburton Trestle: ~300 m long, ~31 m high, around mile 1.4-1.6 from the south end.
  const longest = runs(bridge).sort((a, b) => b[1] - b[0] - (a[1] - a[0]))[0];
  const length = (longest[1] - longest[0]) * step;
  let height = 0;
  for (let k = longest[0]; k < longest[1]; k++) height = Math.max(height, ele[k] - ground[k]);
  assert.ok(length > 250 && length < 350, `trestle length ${length}`);
  assert.ok(height > 25 && height < 35, `trestle height ${height}`);
  assert.ok(mile(longest[0]) > 1.3 && mile(longest[1]) < 1.7);

  // Every inferred structure is near the trestle or the underpass at mile ~1.
  for (const [a, b] of [...runs(bridge), ...runs(underpass)]) assert.ok(mile(a) > 0.85 && mile(b) < 1.7, `feature at ${mile(a)}`);
  assert.ok(runs(underpass).length >= 1);

  // A rail grade: the raw DEM has 40 % "grades", the inferred trail stays gentle.
  let max = 0;
  for (let i = 5; i < ele.length - 5; i++) max = Math.max(max, Math.abs(ele[i + 5] - ele[i - 5]) / (10 * step));
  assert.ok(max < 0.05, `max grade ${max}`);
});

test('hilly roads are left alone', () => {
  // 20 m peak-to-peak rolling hills every 800 m (max grade ~8 %)
  const ground = Array.from({ length: 2000 }, (_, i) => 100 + 10 * Math.sin((i * 5 * 2 * Math.PI) / 800));
  const { ele, bridge, underpass } = inferTrailProfile(ground, 5);
  assert.equal(bridge.reduce((a, b) => a + b, 0), 0);
  assert.equal(underpass.reduce((a, b) => a + b, 0), 0);
  for (let i = 0; i < ground.length; i++) assert.ok(Math.abs(ele[i] - ground[i]) < 2);
});

test('a recorded altitude that shows the dip keeps it', () => {
  const ground = Array.from({ length: 200 }, (_, i) => (i > 90 && i < 110 ? 80 : 100));
  assert.ok(inferTrailProfile(ground, 5).bridge.some(Boolean));
  const kept = inferTrailProfile(ground, 5, { source: ground.map((g) => g + 3) });
  assert.ok(!kept.bridge.some(Boolean));
  assert.ok(Math.min(...kept.ele) < 90);
});

test('canopy detection', () => {
  assert.ok(canopyScore(35, 60, 30) > 0.5); // dark conifer canopy
  assert.ok(canopyScore(70, 95, 55) > 0.2); // broadleaf
  assert.equal(canopyScore(120, 120, 120), 0); // road / roof
  assert.equal(canopyScore(150, 190, 110), 0); // bright lawn
  assert.equal(canopyScore(5, 8, 5), 0); // shadow
});

test('scatterTrees is deterministic and only uses canopy pixels', () => {
  const w = 64;
  const px = new Uint8Array(w * w * 4);
  for (let i = 0; i < w * w; i++) px.set(i % w < 32 ? [35, 60, 30, 255] : [120, 120, 120, 255], i * 4);
  const a = scatterTrees(px, w, w, { spacing: 4, rand: mulberry32(1) });
  const b = scatterTrees(px, w, w, { spacing: 4, rand: mulberry32(1) });
  assert.deepEqual(a, b);
  assert.ok(a.length > 20);
  assert.ok(a.every((t) => t.u < 0.5));
});
