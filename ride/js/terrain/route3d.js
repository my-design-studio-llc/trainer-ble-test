import { withElevationProfile } from '../geo.js';
import { inferTrailProfile } from './profile.js';

/**
 * Replaces a route's elevation with one inferred from the DEM, so the rider, the
 * trainer's grade and the rendered terrain all agree. Adds per-sample `ground`
 * (DEM height), `bridge` and `underpass` flags.
 */
export async function prepareRoute3D(route, dem, onProgress = () => {}) {
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
  return withElevationProfile(route, ele, { ground, bridge, underpass });
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
