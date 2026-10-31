// Buildings and named landmarks along the route, from OpenStreetMap (Overpass API).
//
// The bundled sample routes ship these as static JSON (made by tools/bake-osm.mjs); other
// routes query Overpass once per ride, for boxes along the whole route. Buildings come back as
// footprints with a height (tagged, from levels, or guessed from the building type);
// landmarks are named shelters, historic objects and artworks right beside the trail;
// crossings are road / rail bridges and tunnels, both on the route and over it.

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
export const BUILDING_REACH = 100; // metres either side of the route
export const LANDMARK_REACH = 40;

export const OSM_ATTRIBUTION = 'Buildings and landmarks © OpenStreetMap contributors';

/** Fetches { buildings, landmarks, crossings } for the route; resolves empty if Overpass is unreachable. */
export async function fetchOsmFeatures(route, staticUrl = null) {
  if (staticUrl) {
    try {
      const res = await fetch(staticUrl);
      if (res.ok) return await res.json();
    } catch (err) {
      console.warn('bundled OSM features unavailable', err);
    }
  }
  const query = overpassQuery(route);
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }) });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      return parseOsm(await res.json());
    } catch (err) {
      console.warn('OSM features unavailable from', url, err);
    }
  }
  return { buildings: [], landmarks: [], crossings: [] };
}

/**
 * Boxes around 1 km pieces of the route are much faster for Overpass than an "around" filter
 * on the whole line; the 3D view keeps only what is actually within reach of the trail.
 */
export function overpassQuery(route) {
  const boxes = routeBoxes(route, 1000, BUILDING_REACH);
  const each = (filter) => boxes.map((b) => `${filter}(${b});`).join('');
  return `[out:json][timeout:180];
(${each('nwr["name"]["amenity"="shelter"]')}${each('nwr["name"]["historic"]')}${each(`nwr["name"]["tourism"~"${LANDMARK_TOURISM.source}"]`)});
out geom qt;
(${each('way["building"]')});
out geom qt;
${crossingFilters(each)}
out geom qt;`;
}

const crossingFilters = (each) => `(${each('way["highway"]["bridge"]')}${each('way["highway"]["tunnel"]')}${each('way["railway"]["bridge"]')}${each('way["railway"]["tunnel"]')});`;

/** Only the bridges and tunnels near the route (tools/bake-osm.mjs --crossings). */
export function crossingsQuery(route) {
  const boxes = routeBoxes(route, 1000, 60);
  return `[out:json][timeout:180];
${crossingFilters((filter) => boxes.map((b) => `${filter}(${b});`).join(''))}
out geom qt;`;
}

/** "south,west,north,east" boxes covering each `length` m piece of the route plus `pad` m. */
function routeBoxes(route, length, pad) {
  const every = Math.max(1, Math.round(length / route.step));
  const dLat = pad / 111320;
  const dLng = pad / (111320 * Math.cos((route.lat[0] * Math.PI) / 180));
  const boxes = [];
  for (let i = 0; i < route.n - 1; i += every) {
    let s = 90, w = 180, n = -90, e = -180;
    for (let k = i; k <= Math.min(route.n - 1, i + every); k++) {
      s = Math.min(s, route.lat[k]);
      n = Math.max(n, route.lat[k]);
      w = Math.min(w, route.lng[k]);
      e = Math.max(e, route.lng[k]);
    }
    boxes.push([s - dLat, w - dLng, n + dLat, e + dLng].map((v) => v.toFixed(5)).join(','));
  }
  return boxes;
}

export function parseOsm(json) {
  const buildings = [];
  const landmarks = [];
  const crossings = [];
  const seen = new Set();
  for (const e of json.elements ?? []) {
    const id = `${e.type}/${e.id}`;
    if (seen.has(id)) continue; // landmarks come first, so a shelter that is also a building stays a landmark
    seen.add(id);
    const t = e.tags ?? {};
    const ring = e.geometry?.map((p) => [p.lat, p.lon]);
    const kind = landmarkKind(t);
    if (kind) {
      const c = ring ? centroid(ring) : [e.lat, e.lon];
      // Old stations along a rail trail are mapped as historic railway sites.
      const name = t.railway === 'site' || t['abandoned:railway'] ? `${t.name} (former rail stop)` : t.name;
      if (Number.isFinite(c[0])) landmarks.push({ id, name, kind, lat: c[0], lng: c[1], ring: ring?.length > 3 ? ring : null });
    } else if (t.building && ring?.length > 3) {
      buildings.push({ id, ring, height: buildingHeight(t) });
    } else if ((t.highway || t.railway) && ring?.length > 1) {
      const c = crossing(t);
      if (c) crossings.push({ id, ...c, line: ring });
    }
  }
  return { buildings, landmarks, crossings };
}

const LANDMARK_TOURISM = /^(artwork|attraction|museum|viewpoint)$/;

function landmarkKind(t) {
  if (!t.name) return null;
  // Businesses (fuel canopies, shops, hotels) and bus shelters are not landmarks.
  if (t.shop || t.brand || t.operator === 'King County Metro' || (t.amenity && t.amenity !== 'shelter')) return null;
  if (/^(locomotive|railway_car|wagon|train)$/.test(t.historic ?? '')) return 'railcar';
  if (t.amenity === 'shelter') return t.shelter_type === 'public_transport' || t.bus === 'yes' ? null : 'shelter';
  if (t.building === 'pavilion') return 'shelter';
  if (t.historic || LANDMARK_TOURISM.test(t.tourism ?? '')) return 'sign';
  return null;
}

const BRIDGE = /^(yes|viaduct|boardwalk|cantilever|covered|movable|trestle|aqueduct)$/;
const TUNNEL = /^(yes|building_passage|avalanche_protector)$/;
const LANE = 3.6;
const WAY_WIDTH = {
  motorway: 2 * LANE + 4, trunk: 2 * LANE + 3, primary: 2 * LANE + 2, secondary: 2 * LANE + 2, tertiary: 2 * LANE + 1,
  motorway_link: LANE + 3, trunk_link: LANE + 3, primary_link: LANE + 2, secondary_link: LANE + 2, tertiary_link: LANE + 2,
  residential: 2 * LANE, unclassified: 2 * LANE, service: LANE + 1, living_street: 2 * LANE,
  cycleway: 4, footway: 3, path: 3, pedestrian: 5, track: 4, bridleway: 3, steps: 2.5,
};

/** Bridge / tunnel facts for a highway or railway way, or null if it is neither. */
export function crossing(t) {
  const kind = BRIDGE.test(t.bridge ?? '') ? 'bridge' : TUNNEL.test(t.tunnel ?? '') ? 'tunnel' : null;
  if (!kind) return null;
  const lanes = parseInt(t.lanes, 10);
  const rail = !t.highway;
  const width = Math.max(2.5, parseFloat(t.width) || (lanes > 0 ? lanes * LANE + 2 : rail ? 5 : WAY_WIDTH[t.highway] ?? 6));
  return {
    kind,
    name: t['bridge:name'] || t['tunnel:name'] || t.name || t.ref || null,
    way: t.highway ?? `rail:${t.railway}`,
    layer: parseInt(t.layer, 10) || (kind === 'bridge' ? 1 : -1),
    width: Math.round(width * 10) / 10,
    structure: t['bridge:structure'] || t.bridge || t.tunnel,
    material: t.material || null,
  };
}

/**
 * Places crossings relative to the route. A bridge or tunnel the route itself runs along
 * (most of its line within `along` m of the route) becomes a span of route samples; one
 * that crosses the route line is an overpass (or a tunnel under the route, ignored).
 * @returns {{ spans: {kind, name, i0, i1}[], over: {crossing, i, t}[] }}
 */
export function placeCrossings(route, crossings, along = 7) {
  const lat0 = route.lat[0];
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 111320;
  const rx = new Float64Array(route.n);
  const ry = new Float64Array(route.n);
  const cell = 50;
  const grid = new Map();
  for (let i = 0; i < route.n; i++) {
    rx[i] = (route.lng[i] - route.lng[0]) * kx;
    ry[i] = (route.lat[i] - lat0) * ky;
    const key = `${Math.floor(rx[i] / cell)},${Math.floor(ry[i] / cell)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(i);
  }
  const nearby = (x, y) => {
    const out = [];
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) out.push(...(grid.get(`${cx + dx},${cy + dy}`) ?? []));
    return out;
  };
  const spans = [];
  const over = [];
  for (const c of crossings) {
    const pts = c.line.map(([la, lo]) => [(lo - route.lng[0]) * kx, (la - lat0) * ky]);
    // Along the route? Check the nearest sample to points spread along the line.
    let close = 0;
    let lo = Infinity;
    let hi = -Infinity;
    const probes = densify(pts, 5);
    for (const [x, y] of probes) {
      let best = Infinity;
      let bi = -1;
      for (const i of nearby(x, y)) {
        const d = Math.hypot(rx[i] - x, ry[i] - y);
        if (d < best) [best, bi] = [d, i];
      }
      if (best <= along) {
        close++;
        lo = Math.min(lo, bi);
        hi = Math.max(hi, bi);
      }
    }
    if (close >= Math.max(2, probes.length * 0.6) && hi > lo) {
      spans.push({ kind: c.kind, name: c.name, i0: lo, i1: hi });
      continue;
    }
    if (c.kind !== 'bridge') continue;
    // Crosses the route line?
    for (let k = 0; k < pts.length - 1; k++) {
      const [ax, ay] = pts[k];
      const [bx, by] = pts[k + 1];
      const cand = new Set([...nearby(ax, ay), ...nearby(bx, by), ...nearby((ax + bx) / 2, (ay + by) / 2)]);
      for (const i of cand) {
        if (i >= route.n - 1) continue;
        const t = segmentHit(rx[i], ry[i], rx[i + 1], ry[i + 1], ax, ay, bx, by);
        if (t !== null && !over.some((o) => o.crossing === c)) over.push({ crossing: c, i, t });
      }
    }
  }
  // Where the route is itself on a bridge, a crossing way is part of the same structure.
  const onSpan = (i) => spans.some((sp) => i >= sp.i0 - 4 && i <= sp.i1 + 4);
  return { spans, over: over.filter((o) => !onSpan(o.i)) };
}

function densify(pts, step) {
  const out = [];
  for (let k = 0; k < pts.length - 1; k++) {
    const [ax, ay] = pts[k];
    const [bx, by] = pts[k + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let j = 0; j < n; j++) out.push([ax + ((bx - ax) * j) / n, ay + ((by - ay) * j) / n]);
  }
  out.push(pts.at(-1));
  return out;
}

/** Fraction along p1→p2 where it crosses q1→q2, or null. */
function segmentHit(p1x, p1y, p2x, p2y, q1x, q1y, q2x, q2y) {
  const dx = p2x - p1x;
  const dy = p2y - p1y;
  const ex = q2x - q1x;
  const ey = q2y - q1y;
  const den = dx * ey - dy * ex;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((q1x - p1x) * ey - (q1y - p1y) * ex) / den;
  const u = ((q1x - p1x) * dy - (q1y - p1y) * dx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

const TYPE_HEIGHT = {
  house: 6, detached: 6, semidetached_house: 6, terrace: 7, residential: 7, bungalow: 4,
  garage: 3, garages: 3, shed: 3, carport: 3, roof: 4, hut: 3, kiosk: 3,
  apartments: 13, dormitory: 13, hotel: 15, office: 12, commercial: 9, retail: 7, supermarket: 7,
  industrial: 9, warehouse: 9, school: 9, university: 12, church: 12, hospital: 18, parking: 10,
};

export function buildingHeight(t) {
  const h = parseFloat(t.height);
  if (h > 0) return h;
  const levels = parseFloat(t['building:levels']);
  if (levels > 0) return levels * 3 + 1;
  return TYPE_HEIGHT[t.building] ?? 7;
}

function centroid(ring) {
  let la = 0;
  let lo = 0;
  const n = ring.length - (ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? 1 : 0);
  for (let i = 0; i < n; i++) {
    la += ring[i][0];
    lo += ring[i][1];
  }
  return [la / n, lo / n];
}
