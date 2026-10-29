// Route geometry: turns raw GPS points into an evenly spaced route that the
// player can sample by distance.

const EARTH_RADIUS = 6371008.8;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

export function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, degrees clockwise from north in [0, 360). */
export function bearing(a, b) {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lng - a.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Interpolates between two headings along the shortest arc. */
export function lerpAngle(a, b, t) {
  const diff = ((b - a + 540) % 360) - 180;
  return (a + diff * t + 360) % 360;
}

/**
 * Builds a route resampled every `step` metres.
 * @param {{lat:number,lng:number,ele?:number,t?:number}[]} points  t = seconds since start
 */
export function buildRoute(points, { step = 5, name = 'Route' } = {}) {
  const pts = points.filter(
    (p, i) =>
      Number.isFinite(p.lat) &&
      Number.isFinite(p.lng) &&
      Math.abs(p.lat) <= 90 &&
      Math.abs(p.lng) <= 180 &&
      !(i > 0 && p.lat === points[i - 1].lat && p.lng === points[i - 1].lng),
  );
  if (pts.length < 2) throw new Error('Track has fewer than two usable GPS points');

  const hasEle = pts.every((p) => Number.isFinite(p.ele));
  const hasTime = pts.every((p) => Number.isFinite(p.t));

  const cum = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1] + haversine(pts[i - 1], pts[i]);
  const total = cum[pts.length - 1];
  if (total < step * 2) throw new Error('Track is too short');

  const n = Math.floor(total / step) + 2;
  const lat = new Float64Array(n);
  const lng = new Float64Array(n);
  const rawEle = new Float64Array(n);
  const rawTime = new Float64Array(n);
  const dist = new Float64Array(n);

  let j = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.min(i * step, total);
    while (j < pts.length - 2 && cum[j + 1] < d) j++;
    const seg = cum[j + 1] - cum[j];
    const f = seg > 0 ? (d - cum[j]) / seg : 0;
    const a = pts[j];
    const b = pts[j + 1];
    dist[i] = d;
    lat[i] = a.lat + (b.lat - a.lat) * f;
    lng[i] = a.lng + (b.lng - a.lng) * f;
    rawEle[i] = hasEle ? a.ele + (b.ele - a.ele) * f : 0;
    rawTime[i] = hasTime ? a.t + (b.t - a.t) * f : 0;
  }

  const ele = smooth(rawEle, Math.round(20 / step));

  const grade = computeGrades(ele, dist, step);

  // Heading looks ~15 m ahead so small GPS wiggles don't swing the camera.
  const bw = Math.max(1, Math.round(15 / step));
  const heading = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.min(i, n - 1 - bw);
    heading[i] = bearing({ lat: lat[a], lng: lng[a] }, { lat: lat[a + bw], lng: lng[a + bw] });
  }

  // Original ride timing. Stops are squeezed out (min 1.5 m/s) so a replay never sits still.
  const time = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const seg = dist[i] - dist[i - 1];
    const dt = hasTime ? clamp(rawTime[i] - rawTime[i - 1], seg / 25, seg / 1.5) : seg / (25 / 3.6);
    time[i] = time[i - 1] + dt;
  }

  return { name, step, n, total, lat, lng, ele, grade, heading, dist, time, hasEle, hasTime, climb: totalClimb(ele) };
}

/** The same track ridden the other way. Recorded times are mirrored so a replay still runs forward. */
export function reversePoints(points) {
  const tEnd = points.at(-1)?.t;
  return points
    .map((p) => ({ ...p, t: Number.isFinite(p.t) && Number.isFinite(tEnd) ? tEnd - p.t : undefined }))
    .reverse();
}

/** Copy of `route` with a new elevation profile (one value per sample); extra fields are merged in. */
export function withElevationProfile(route, ele, extra = {}) {
  const e = Float64Array.from(ele);
  return { ...route, ...extra, ele: e, grade: computeGrades(e, route.dist, route.step), climb: totalClimb(e), hasEle: true };
}

// Grade over a ±25 m window, clamped to something a trainer can simulate.
function computeGrades(ele, dist, step) {
  const n = ele.length;
  const gw = Math.max(1, Math.round(25 / step));
  const grade = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - gw);
    const hi = Math.min(n - 1, i + gw);
    const run = dist[hi] - dist[lo];
    grade[i] = run > 0 ? clamp((ele[hi] - ele[lo]) / run, -0.25, 0.25) : 0;
  }
  return grade;
}

function totalClimb(ele) {
  let climb = 0;
  for (let i = 1; i < ele.length; i++) climb += Math.max(0, ele[i] - ele[i - 1]);
  return climb;
}

/** Interpolated position and attributes at distance `d` metres along the route. */
export function sampleAt(route, d) {
  const dd = clamp(d, 0, route.total);
  const i = Math.min(Math.floor(dd / route.step), route.n - 2);
  const span = route.dist[i + 1] - route.dist[i];
  const f = span > 0 ? clamp((dd - route.dist[i]) / span, 0, 1) : 0;
  const mix = (arr) => arr[i] + (arr[i + 1] - arr[i]) * f;
  return {
    i,
    d: dd,
    lat: mix(route.lat),
    lng: mix(route.lng),
    ele: mix(route.ele),
    grade: mix(route.grade),
    time: mix(route.time),
    heading: lerpAngle(route.heading[i], route.heading[i + 1], f),
  };
}

/** Distance reached at `t` seconds when replaying the original ride timing. */
export function distanceAtTime(route, t) {
  const { time, dist, n } = route;
  if (t <= 0) return 0;
  if (t >= time[n - 1]) return route.total;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (time[mid] <= t) lo = mid;
    else hi = mid;
  }
  const f = (t - time[lo]) / (time[hi] - time[lo]);
  return dist[lo] + (dist[hi] - dist[lo]) * f;
}

/**
 * Gives each point an elevation interpolated from `profile`, a list of
 * { d, ele } sorted by distance along the same points.
 */
export function attachElevation(points, profile) {
  let d = 0;
  let k = 0;
  return points.map((p, i) => {
    if (i > 0) d += haversine(points[i - 1], p);
    while (k < profile.length - 2 && profile[k + 1].d < d) k++;
    const a = profile[k];
    const b = profile[Math.min(k + 1, profile.length - 1)];
    const f = b.d > a.d ? clamp((d - a.d) / (b.d - a.d), 0, 1) : 0;
    return { ...p, ele: a.ele + (b.ele - a.ele) * f };
  });
}

/** Resampled route as plain coordinate rows, for export. */
export function routeRows(route) {
  const rows = [];
  for (let i = 0; i < route.n; i++) {
    rows.push({
      lat: +route.lat[i].toFixed(7),
      lng: +route.lng[i].toFixed(7),
      ele: +route.ele[i].toFixed(1),
      distance: +route.dist[i].toFixed(1),
      grade: +(route.grade[i] * 100).toFixed(2),
      heading: +route.heading[i].toFixed(1),
    });
  }
  return rows;
}

export function routeToCSV(route) {
  const rows = routeRows(route);
  const cols = Object.keys(rows[0]);
  return [cols.join(','), ...rows.map((r) => cols.map((c) => r[c]).join(','))].join('\n');
}

function smooth(arr, radius) {
  if (radius < 1) return Float64Array.from(arr);
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(arr.length - 1, i + radius);
    let sum = 0;
    for (let k = lo; k <= hi; k++) sum += arr[k];
    out[i] = sum / (hi - lo + 1);
  }
  return out;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
