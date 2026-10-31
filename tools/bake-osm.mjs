// Bakes the OpenStreetMap buildings and landmarks along a GPX route into a compact JSON file,
// so the bundled sample routes don't depend on the (slow, often busy) public Overpass API.
//
//   node tools/bake-osm.mjs samples/cross-kirkland-corridor.gpx samples/cross-kirkland-corridor.osm.json

import fs from 'node:fs';
import { buildRoute, haversine } from '../ride/js/geo.js';
import { BUILDING_REACH, LANDMARK_REACH, overpassQuery, parseOsm } from '../ride/js/terrain/osm.js';

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const CHUNK_KM = 8;
const [gpxPath, outPath] = process.argv.slice(2);

const points = [...fs.readFileSync(gpxPath, 'utf8').matchAll(/<trkpt lat="([\d.-]+)" lon="([\d.-]+)"/g)].map((m) => ({ lat: +m[1], lng: +m[2] }));
const route = buildRoute(points);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function overpass(query) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(OVERPASS, { method: 'POST', headers: { 'User-Agent': 'trainer-ble-test bake-osm' }, body: new URLSearchParams({ data: query }) });
    if (res.ok) return res.json();
    if (attempt === 6) throw new Error(`Overpass ${res.status}`);
    console.log(`  Overpass ${res.status}, retrying`);
    await sleep(attempt * 10000);
  }
}

// Distance from a point to a piece of the route, checked against samples every 5 m (good to ~2.5 m).
const near = (piece, lat, lng, reach) => {
  for (let i = 0; i < piece.n; i++) if (haversine({ lat, lng }, { lat: piece.lat[i], lng: piece.lng[i] }) <= reach + 2.5) return true;
  return false;
};

const per = Math.round((CHUNK_KM * 1000) / route.step);
const buildings = new Map();
const landmarks = new Map();
for (let i = 0; i < route.n - 1; i += per) {
  const end = Math.min(route.n, i + per + 1);
  const piece = { ...route, n: end - i, lat: route.lat.slice(i, end), lng: route.lng.slice(i, end) };
  console.log(`km ${((i * route.step) / 1000).toFixed(0)}-${(((end - 1) * route.step) / 1000).toFixed(0)}`);
  const f = parseOsm(await overpass(overpassQuery(piece)));
  for (const l of f.landmarks) if (near(piece, l.lat, l.lng, LANDMARK_REACH + (l.ring ? 20 : 0))) landmarks.set(l.id, l);
  for (const b of f.buildings) if (!buildings.has(b.id) && b.ring.some(([la, lo]) => near(piece, la, lo, BUILDING_REACH))) buildings.set(b.id, b);
  await sleep(2000);
}

const r6 = (v) => Math.round(v * 1e6) / 1e6;
const ring = (pts) => pts?.map(([la, lo]) => [r6(la), r6(lo)]) ?? null;
const out = {
  source: 'OpenStreetMap contributors (ODbL), via Overpass API',
  buildings: [...buildings.values()].map((b) => ({ ring: ring(b.ring), height: b.height })),
  landmarks: [...landmarks.values()].map((l) => ({ ...l, lat: r6(l.lat), lng: r6(l.lng), ring: ring(l.ring) })),
};
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`${out.buildings.length} buildings, ${out.landmarks.length} landmarks: ${out.landmarks.map((l) => l.name).join(', ')}`);
console.log(`wrote ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(0)} KB)`);
