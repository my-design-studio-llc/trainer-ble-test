import { withElevationProfile } from '../geo.js';
import { inferTrailProfile } from './profile.js';

/**
 * Replaces a route's elevation with one inferred from the DEM, so the rider, the
 * trainer's grade and the rendered terrain all agree. Adds per-sample `ground`
 * (DEM height), `bridge`, `underpass` and `tunnel` flags. `spans` are bridges and tunnels
 * the route runs along according to OpenStreetMap ({ kind, i0, i1 }); they override the
 * guesses from the elevation profile.
 */
export async function prepareRoute3D(route, dem, onProgress = () => {}, spans = []) {
  const points = [];
  for (let i = 0; i < route.n; i++) points.push({ lat: route.lat[i], lng: route.lng[i] });
  await dem.loadForPoints(points, (done, total) => onProgress(`Downloading terrain ${done}/${total}`));

  const ground = new Float64Array(route.n);
  for (let i = 0; i < route.n; i++) ground[i] = dem.heightAt(points[i].lng, points[i].lat);
  fillGaps(ground);

  // A recorded (barometric/GPS) profile helps tell real dips from deleted bridges;
  // one that itself came from a DEM doesn't.
  const source = route.hasEle && !route.eleFromDem ? route.ele : undefined;
  const { ele, bridge, underpass } = inferTrailProfile(ground, route.step, { source });
  const tunnel = new Uint8Array(route.n);
  for (const { kind, i0, i1 } of spans) {
    // A straight deck (or tunnel floor) between the ground just outside each end.
    const a = Math.max(0, i0 - 2);
    const b = Math.min(route.n - 1, i1 + 2);
    for (let i = a + 1; i < b; i++) ele[i] = ele[a] + ((ele[b] - ele[a]) * (i - a)) / (b - a);
    for (let i = i0; i <= i1; i++) (kind === 'tunnel' ? tunnel : bridge)[i] = 1;
  }
  return withElevationProfile(route, ele, { ground, bridge, underpass, tunnel });
}

/** Replaces NaNs (missing tiles) by interpolating neighbours. */
function fillGaps(a) {
  const valid = [];
  a.forEach((v, i) => Number.isFinite(v) && valid.push(i));
  if (!valid.length) throw new Error('Could not load terrain data for this route');
  for (let i = 0; i < a.length; i++) {
    if (Number.isFinite(a[i])) continue;
    const next = valid.find((k) => k > i);
    const prev = valid.findLast((k) => k < i);
    if (prev === undefined) a[i] = a[next];
    else if (next === undefined) a[i] = a[prev];
    else a[i] = a[prev] + ((a[next] - a[prev]) * (i - prev)) / (next - prev);
  }
}
