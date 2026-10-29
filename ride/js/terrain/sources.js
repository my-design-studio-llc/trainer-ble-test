// Elevation and satellite imagery tile sources.

import { TILE_SIZE, decodeTerrarium, lngLatToTile } from './tiles.js';

// AWS Open Data "Terrain Tiles" (Mapzen Terrarium). In the US the source is USGS 3DEP.
const TERRARIUM = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
export const DEM_ATTRIBUTION = 'Elevation: Terrain Tiles (AWS Open Data; USGS 3DEP, SRTM, others)';

export const IMAGERY_PROVIDERS = {
  esri: {
    label: 'High resolution (Esri World Imagery)',
    maxZoom: 17,
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
  },
  eox: {
    label: '10 m, cloud free (Sentinel-2)',
    maxZoom: 15,
    url: (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/g/${z}/${y}/${x}.jpg`,
    attribution: 'Sentinel-2 cloudless by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2023)',
  },
};

async function loadPixels(url) {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const bitmap = await createImageBitmap(await res.blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}

/** Caches Terrarium tiles at one zoom and answers bilinear height queries. */
export class DemSampler {
  constructor({ zoom = 15, url = TERRARIUM } = {}) {
    this.zoom = zoom;
    this.url = url;
    this.pending = new Map();
    this.tiles = new Map();
  }

  load(x, y) {
    const key = `${x}/${y}`;
    if (!this.pending.has(key)) {
      this.pending.set(
        key,
        loadPixels(this.url(this.zoom, x, y)).then(
          (px) => this.tiles.set(key, decodeTerrarium(px)),
          (err) => {
            this.pending.delete(key); // allow a retry later
            throw err;
          },
        ),
      );
    }
    return this.pending.get(key);
  }

  /** Loads every tile touched by the points (and the neighbour when a point sits on an edge). */
  async loadForPoints(points, onProgress = () => {}) {
    const keys = new Map();
    for (const p of points) {
      const t = lngLatToTile(p.lng, p.lat, this.zoom);
      for (const dx of [-0.02, 0.02]) {
        for (const dy of [-0.02, 0.02]) keys.set(`${Math.floor(t.x + dx)}/${Math.floor(t.y + dy)}`, null);
      }
    }
    const list = [...keys.keys()].map((k) => k.split('/').map(Number));
    let done = 0;
    await runLimited(list, 6, async ([x, y]) => {
      await this.load(x, y);
      onProgress(++done, list.length);
    });
  }

  /** Height in metres, or NaN if the tile isn't loaded. */
  heightAt(lng, lat) {
    const t = lngLatToTile(lng, lat, this.zoom);
    const gx = t.x * TILE_SIZE - 0.5;
    const gy = t.y * TILE_SIZE - 0.5;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;
    const h00 = this.#pixel(x0, y0);
    const h10 = this.#pixel(x0 + 1, y0);
    const h01 = this.#pixel(x0, y0 + 1);
    const h11 = this.#pixel(x0 + 1, y0 + 1);
    return (h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy;
  }

  #pixel(gx, gy) {
    const tx = Math.floor(gx / TILE_SIZE);
    const ty = Math.floor(gy / TILE_SIZE);
    const tile = this.tiles.get(`${tx}/${ty}`);
    if (!tile) return NaN;
    return tile[(gy - ty * TILE_SIZE) * TILE_SIZE + (gx - tx * TILE_SIZE)];
  }
}

/** Returns the imagery provider with its id. */
export function createImagery(providerId) {
  const provider = IMAGERY_PROVIDERS[providerId] ?? IMAGERY_PROVIDERS.esri;
  return { ...provider, id: IMAGERY_PROVIDERS[providerId] ? providerId : 'esri' };
}

/**
 * Satellite image covering one terrain tile (x, y at `zoom`), stitched from imagery
 * tiles at `imageryZoom`. Returns null if nothing could be loaded.
 */
export async function loadImageryMosaic(imagery, zoom, x, y, imageryZoom) {
  const iz = Math.max(zoom, Math.min(imageryZoom, imagery.maxZoom));
  const k = 2 ** (iz - zoom);
  const canvas = new OffscreenCanvas(TILE_SIZE * k, TILE_SIZE * k);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#6d7560';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const cells = [];
  for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) cells.push([i, j]);
  let loaded = 0;
  await runLimited(cells, 8, async ([i, j]) => {
    try {
      const res = await fetch(imagery.url(iz, x * k + i, y * k + j), { mode: 'cors' });
      if (!res.ok) return;
      const bmp = await createImageBitmap(await res.blob());
      ctx.drawImage(bmp, i * TILE_SIZE, j * TILE_SIZE, TILE_SIZE, TILE_SIZE);
      bmp.close();
      loaded++;
    } catch {
      /* leave the placeholder colour */
    }
  });
  return loaded ? { canvas, zoom: iz } : null;
}

export async function runLimited(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
