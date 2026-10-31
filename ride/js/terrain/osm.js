// Buildings and named landmarks along the route, from OpenStreetMap (Overpass API).
//
// The bundled sample routes ship these as static JSON (made by tools/bake-osm.mjs); other
// routes query Overpass once per ride, for boxes along the whole route. Buildings come back as
// footprints with a height (tagged, from levels, or guessed from the building type);
// landmarks are named shelters, historic objects and artworks right beside the trail.

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
export const BUILDING_REACH = 100; // metres either side of the route
export const LANDMARK_REACH = 40;

export const OSM_ATTRIBUTION = 'Buildings and landmarks © OpenStreetMap contributors';

/** Fetches { buildings, landmarks } for the route; resolves empty if Overpass is unreachable. */
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
  return { buildings: [], landmarks: [] };
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
    }
  }
  return { buildings, landmarks };
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
