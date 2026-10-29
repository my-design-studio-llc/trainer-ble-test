// Infers the elevation of a trail/road from a bare-earth DEM sampled along it.
//
// Bare-earth models (lidar, SRTM) delete bridge decks, which produces two mirror-image
// artefacts along a route:
//   - on a bridge, the profile drops into the valley below (a narrow, steep dip);
//   - under an overpass, the hole left by the deleted deck is filled from the
//     overpass embankments, so the profile climbs over it (a narrow, steep hump).
// Both are replaced by a straight deck between their ends. Gentle features are kept,
// and if the source track has its own elevation (barometric altimeter), a feature
// it also shows is treated as real.

/**
 * @param ground DEM height at each route sample
 * @param step   metres between samples
 * @param opts.source optional elevation recorded with the track, same length
 * @returns {{ ele: Float64Array, bridge: Uint8Array, underpass: Uint8Array, minGrade: number }}
 */
export function inferTrailProfile(
  ground,
  step,
  { source, maxBridge = 400, maxUnderpass = 250, minHeight = 2.5, smoothRadius = 15 } = {},
) {
  const g = Float64Array.from(ground);
  // A feature must be much steeper than the route's usual grade: a 6 % bump is
  // suspicious on a rail trail but ordinary on a hilly road.
  const minGrade = Math.min(0.12, Math.max(0.04, 3 * typicalGrade(g, step)));
  const opts = { source, minGrade, minHeight, step };

  // Bridges first: dips narrower than maxBridge.
  const bridge = new Uint8Array(g.length);
  const wb = Math.round(maxBridge / 2 / step);
  const closed = erode(dilate(g, wb), wb);
  const bridged = Float64Array.from(g);
  replaceFeatures(g, (i) => closed[i] - g[i], bridged, bridge, opts);

  // Then underpasses: humps narrower than maxUnderpass, on the bridged profile so a
  // bridge abutment between two filled dips isn't mistaken for one.
  const underpass = new Uint8Array(g.length);
  const wu = Math.round(maxUnderpass / 2 / step);
  const opened = dilate(erode(bridged, wu), wu);
  const fill = Float64Array.from(bridged);
  replaceFeatures(bridged, (i) => bridged[i] - opened[i], fill, underpass, opts);

  return { ele: smooth(fill, Math.round(smoothRadius / step)), bridge, underpass, minGrade };
}

/** 75th percentile of |grade| over 50 m windows. */
function typicalGrade(g, step) {
  const w = Math.max(1, Math.round(25 / step));
  const grades = [];
  for (let i = w; i < g.length - w; i++) grades.push(Math.abs(g[i + w] - g[i - w]) / (2 * w * step));
  if (!grades.length) return 0;
  grades.sort((a, b) => a - b);
  return grades[Math.floor(grades.length * 0.75)];
}

/**
 * Finds runs where excess(i) ≥ 0.5 m; replaces those that are tall and steep enough
 * with a straight line between the run's ends (in `out`) and flags them.
 */
function replaceFeatures(base, excess, out, flags, { source, minGrade, minHeight, step }) {
  const n = base.length;
  for (let i = 0; i < n; ) {
    if (excess(i) < 0.5) {
      i++;
      continue;
    }
    let j = i;
    let depth = 0;
    while (j < n && excess(j) >= 0.5) depth = Math.max(depth, excess(j++));
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, j);
    const steep = depth >= minHeight && depth / Math.max(step, ((j - i) * step) / 2) >= minGrade;
    if (steep && !(source && sourceShowsFeature(source, a, b, base, depth))) {
      for (let k = i; k < j; k++) {
        out[k] = base[a] + ((base[b] - base[a]) * (k - a)) / Math.max(1, b - a);
        if (Math.abs(out[k] - base[k]) >= minHeight) flags[k] = 1;
      }
    }
    i = j;
  }
}

/** True if the recorded elevation deviates from a straight line over [a, b] the way the DEM does. */
function sourceShowsFeature(source, a, b, g, depth) {
  let demDev = 0;
  let srcDev = 0;
  for (let k = a; k <= b; k++) {
    const f = (k - a) / Math.max(1, b - a);
    const d = g[k] - (g[a] + (g[b] - g[a]) * f);
    const s = source[k] - (source[a] + (source[b] - source[a]) * f);
    if (Math.abs(d) > Math.abs(demDev)) {
      demDev = d;
      srcDev = s;
    }
  }
  return Math.sign(srcDev) === Math.sign(demDev) && Math.abs(srcDev) >= depth * 0.5;
}

function dilate(a, w) {
  return slidingWindow(a, w, Math.max, -Infinity);
}

function erode(a, w) {
  return slidingWindow(a, w, Math.min, Infinity);
}

function slidingWindow(a, w, op, init) {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) {
    let v = init;
    for (let k = Math.max(0, i - w); k <= Math.min(a.length - 1, i + w); k++) v = op(v, a[k]);
    out[i] = v;
  }
  return out;
}

function smooth(a, r) {
  if (r < 1) return a;
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - r);
    const hi = Math.min(a.length - 1, i + r);
    let s = 0;
    for (let k = lo; k <= hi; k++) s += a[k];
    out[i] = s / (hi - lo + 1);
  }
  return out;
}
