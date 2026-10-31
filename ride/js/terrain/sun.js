// Sun and moon positions, sky colours and haze: plain functions, no three.js (unit tested in Node).

const RAD = Math.PI / 180;

const days = (date) => date.getTime() / 86400000 - 10957.5; // days since J2000.0
const obliquity = (d) => (23.439 - 0.00000036 * d) * RAD;

/** Elevation and azimuth (clockwise from north) of right ascension / declination at a place. */
function horizontal(ra, dec, d, lat, lng) {
  const gmst = (((18.697374558 + 24.06570982441908 * d) % 24) + 24) % 24;
  const ha = (gmst * 15 + lng) * RAD - ra;
  const φ = lat * RAD;
  const elevation = Math.asin(Math.sin(φ) * Math.sin(dec) + Math.cos(φ) * Math.cos(dec) * Math.cos(ha));
  const azimuth = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(φ) - Math.sin(φ) * Math.cos(ha));
  return { elevation, azimuth: (azimuth + 2 * Math.PI) % (2 * Math.PI) };
}

function sunEquatorial(d) {
  const g = (357.529 + 0.98560028 * d) * RAD;
  const L = (280.459 + 0.98564736 * d + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const e = obliquity(d);
  return { ra: Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)), dec: Math.asin(Math.sin(e) * Math.sin(L)) };
}

/**
 * Solar position (NOAA-style low-precision formulas, good to ~0.1°).
 * @returns {{ elevation: number, azimuth: number }} radians; azimuth clockwise from north
 */
export function sunPosition(date, lat, lng) {
  const d = days(date);
  const { ra, dec } = sunEquatorial(d);
  return horizontal(ra, dec, d, lat, lng);
}

/**
 * Lunar position (low-precision series, ~0.5°; parallax ignored) and the lit fraction of the disk.
 * @returns {{ elevation: number, azimuth: number, fraction: number }}
 */
export function moonPosition(date, lat, lng) {
  const d = days(date);
  const L = (218.316 + 13.176396 * d) * RAD; // mean longitude
  const M = (134.963 + 13.064993 * d) * RAD; // mean anomaly
  const F = (93.272 + 13.22935 * d) * RAD; // mean distance from the ascending node
  const l = L + 6.289 * RAD * Math.sin(M);
  const b = 5.128 * RAD * Math.sin(F);
  const e = obliquity(d);
  const ra = Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
  const dec = Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
  const sun = sunEquatorial(d);
  // Elongation from the sun; the phase angle seen from the moon is nearly its supplement.
  const cosElong = Math.sin(sun.dec) * Math.sin(dec) + Math.cos(sun.dec) * Math.cos(dec) * Math.cos(sun.ra - ra);
  const fraction = (1 - cosElong) / 2;
  return { ...horizontal(ra, dec, d, lat, lng), fraction };
}

/** A clear, still midday: used when live sky is off or weather is unavailable. */
export const FAIR_WEATHER = { cloud: 0.1, visibility: 40000, rain: 0, snow: 0, fog: false, windSpeed: 2, windDir: 225 };

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mix3 = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/**
 * Sky colours (sRGB 0..1) and light levels for a sun elevation (radians) and cloud cover 0..1.
 * day: 0 at night to 1 in daylight; golden: strength of the sunrise / sunset tint.
 */
export function skyState(elevation, cloud) {
  const deg = elevation / RAD;
  const day = smooth(-7, 8, deg);
  const golden = smooth(-6, 0, deg) * (1 - smooth(4, 14, deg));
  let zenith = mix3([0.01, 0.015, 0.04], [0.27, 0.5, 0.85], day);
  let horizon = mix3([0.03, 0.04, 0.08], [0.74, 0.83, 0.92], day);
  horizon = mix3(horizon, [0.98, 0.62, 0.38], golden * 0.75);
  zenith = mix3(zenith, [0.36, 0.42, 0.62], golden * 0.4);
  const grey = [0.62, 0.65, 0.69].map((v) => v * (0.08 + 0.92 * day));
  zenith = mix3(zenith, grey.map((v) => v * 0.9), cloud * 0.85);
  horizon = mix3(horizon, grey, cloud * 0.8);
  return {
    day,
    golden,
    zenith,
    horizon,
    sun: day * (1 - 0.8 * cloud),
    sunColor: mix3([1, 0.96, 0.88], [1, 0.62, 0.35], golden),
  };
}

/** Haze density for THREE.FogExp2 from reported visibility in metres. */
export function fogDensity(visibility) {
  // ~70 % haze at 100 km on a clear day (distant peaks show, blued); about 65 % at the reported
  // visibility once it drops below ~20 km.
  return Math.max(1.1e-5, 1.3 / Math.max(200, visibility) - 5.4e-5);
}
