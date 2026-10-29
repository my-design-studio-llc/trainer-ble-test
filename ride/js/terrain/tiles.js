// Web Mercator tile math, Terrarium elevation decoding and a local metric frame.

export const TILE_SIZE = 256;

/** Fractional tile coordinates of a point at zoom z. */
export function lngLatToTile(lng, lat, z) {
  const n = 2 ** z;
  const φ = (lat * Math.PI) / 180;
  return {
    x: ((lng + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(φ) + 1 / Math.cos(φ)) / Math.PI) / 2) * n,
  };
}

/** Inverse of lngLatToTile; x/y may be fractional. */
export function tileToLngLat(x, y, z) {
  const n = 2 ** z;
  return {
    lng: (x / n) * 360 - 180,
    lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI,
  };
}

/** Ground width of one tile in metres at latitude `lat`. */
export function tileWidthMeters(lat, z) {
  return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
}

/** Terrarium PNG pixels (RGBA) to metres: (R·256 + G + B/256) − 32768. */
export function decodeTerrarium(rgba) {
  const out = new Float32Array(rgba.length / 4);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = rgba[p] * 256 + rgba[p + 1] + rgba[p + 2] / 256 - 32768;
  }
  return out;
}

/**
 * Flat local frame around an origin, good to a few cm over tens of km.
 * Matches three.js conventions: x = east, y = up, z = south (north is −z).
 */
export class LocalFrame {
  constructor(lat0, lng0) {
    this.lat0 = lat0;
    this.lng0 = lng0;
    // WGS84 meridional and prime-vertical radii of curvature at the origin.
    const a = 6378137;
    const e2 = 0.00669437999014;
    const s = Math.sin((lat0 * Math.PI) / 180);
    const w = Math.sqrt(1 - e2 * s * s);
    this.mPerDegLat = ((a * (1 - e2)) / (w * w * w)) * (Math.PI / 180);
    this.mPerDegLng = (a / w) * Math.cos((lat0 * Math.PI) / 180) * (Math.PI / 180);
  }

  project(lat, lng) {
    return { x: (lng - this.lng0) * this.mPerDegLng, z: -(lat - this.lat0) * this.mPerDegLat };
  }

  unproject(x, z) {
    return { lat: this.lat0 - z / this.mPerDegLat, lng: this.lng0 + x / this.mPerDegLng };
  }
}
