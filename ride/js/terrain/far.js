// Distant terrain out to ~120 km around the route, for the skyline: hills, the Cascades,
// the Olympics and big volcanoes. One coarse height-field mesh from z9 Terrarium tiles
// (~200 m per pixel), coloured by height, slope and a seasonal snow line, and drawn in its own
// pass behind the detailed tiles. Earth curvature (with standard refraction) is applied in
// the vertex shader relative to the camera, so far peaks sink as they should.

import * as THREE from 'three';
import { DemSampler, runLimited } from './sources.js';
import { lngLatToTile } from './tiles.js';

const ZOOM = 9;
const REACH = 120000; // metres beyond the route's bounding box
const GRID = 224; // ~1.1 km cells: enough for a skyline, 100k triangles
const SINK = 8; // keeps the coarse mesh under the detailed tiles where both exist
const EARTH_R_EFF = 6371000 * (7 / 6); // refraction makes the horizon a little farther

// Snow line (m) by month in the Pacific Northwest; peaks above stay white.
const SNOWLINE = [900, 900, 1000, 1200, 1500, 1900, 2300, 2500, 2400, 1900, 1500, 1000];

export function snowLine(date, lat) {
  const m = lat >= 0 ? date.getMonth() : (date.getMonth() + 6) % 12;
  return SNOWLINE[m];
}

export class FarTerrain {
  constructor(frame, route) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < route.n; i++) {
      const p = frame.project(route.lat[i], route.lng[i]);
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    this.frame = frame;
    this.cx = (minX + maxX) / 2;
    this.cz = (minZ + maxZ) / 2;
    this.half = REACH + Math.max(maxX - minX, maxZ - minZ) / 2;
    this.dem = new DemSampler({ zoom: ZOOM });
  }

  /** Loads the elevation and resolves with the mesh (null if nothing loaded). */
  async build(date = new Date()) {
    const { frame, cx, cz, half } = this;
    const nw = frame.unproject(cx - half, cz - half);
    const se = frame.unproject(cx + half, cz + half);
    const a = lngLatToTile(nw.lng, nw.lat, ZOOM);
    const b = lngLatToTile(se.lng, se.lat, ZOOM);
    const tiles = [];
    for (let y = Math.floor(a.y); y <= Math.floor(b.y); y++) for (let x = Math.floor(a.x); x <= Math.floor(b.x); x++) tiles.push([x, y]);
    let loaded = 0;
    await runLimited(tiles, 6, ([x, y]) => this.dem.load(x, y).then(() => loaded++, () => {}));
    if (!loaded) return null;

    const n = GRID + 1;
    const step = (2 * half) / GRID;
    const h = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const ll = frame.unproject(cx - half + i * step, cz - half + j * step);
        const v = this.dem.heightAt(ll.lng, ll.lat);
        h[j * n + i] = Number.isFinite(v) ? v : 0;
      }
    }

    const pos = new Float32Array(n * n * 3);
    const col = new Float32Array(n * n * 3);
    const snow = snowLine(date, frame.lat0);
    const c = new THREE.Color();
    const at = (i, j) => h[Math.min(n - 1, Math.max(0, j)) * n + Math.min(n - 1, Math.max(0, i))];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const y = h[k];
        pos.set([cx - half + i * step, y - SINK, cz - half + j * step], k * 3);
        const dx = at(i + 1, j) - at(i - 1, j);
        const dz = at(i, j + 1) - at(i, j - 1);
        const slope = Math.hypot(dx, dz) / (2 * step);
        const range = Math.max(Math.abs(dx), Math.abs(dz), Math.abs(at(i + 1, j + 1) - at(i - 1, j - 1)));
        // Lakes are perfectly flat in the DEM; the sea is at or below zero.
        const water = y <= 0.5 || (y < 60 && range < 0.6);
        const jitter = Math.sin(i * 12.9898 + j * 78.233) * 43758.5453 % 1;
        if (water) c.setRGB(0.18, 0.26, 0.34, THREE.SRGBColorSpace);
        else if (y > snow + 150 * jitter && slope < 1.1) c.setRGB(0.93, 0.95, 0.98, THREE.SRGBColorSpace);
        else if (slope > 0.75 || y > 1900) c.setRGB(0.42, 0.41, 0.4, THREE.SRGBColorSpace);
        else if (y > 250) c.setRGB(0.15, 0.23, 0.14, THREE.SRGBColorSpace); // conifer forest
        else c.setRGB(0.27, 0.31, 0.24, THREE.SRGBColorSpace); // lowland towns and woods
        col.set([c.r, c.g, c.b], k * 3);
      }
    }
    const idx = new Uint32Array(GRID * GRID * 6);
    for (let j = 0, o = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const q = j * n + i;
        idx.set([q, q + n, q + 1, q + 1, q + n, q + n + 1], o);
        o += 6;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    const material = new THREE.MeshLambertMaterial({ vertexColors: true });
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec2 fromEye = transformed.xz - cameraPosition.xz;
        transformed.y -= dot(fromEye, fromEye) / ${(2 * EARTH_R_EFF).toFixed(1)};`,
      );
    };
    const mesh = new THREE.Mesh(geo, material);
    mesh.frustumCulled = false; // curvature moves vertices after culling
    return mesh;
  }
}
