// First-person 3D view reconstructed from a DEM and satellite imagery.
//
// Terrain tiles (Web Mercator z15, ~820 m wide at 47° N) stream in around the rider.
// Each is a height-field mesh draped with satellite imagery; a corridor along the
// route is graded to the inferred trail elevation; trees are planted where the
// imagery looks like canopy; bridges inferred from the elevation profile get a
// deck, railings and trestle bents.

import * as THREE from 'three';
import { sampleAt } from '../geo.js';
import { LocalFrame, lngLatToTile, tileToLngLat, tileWidthMeters } from './tiles.js';
import { loadImageryMosaic } from './sources.js';
import { mulberry32, scatterTrees } from './vegetation.js';

const ZOOM = 15;
const GRID_NEAR = 128; // terrain mesh quads per tile side (~6.4 m) within one tile of the rider
const GRID_FAR = 64;
const LOAD_RING = 2; // tiles kept loaded around the rider (5 × 5)
const DROP_RING = 3;
const TRAIL_HALF_WIDTH = 1.8; // 12 ft paved path
const SHOULDER = 0.9;
const TRAIL_LIFT = 0.12;
const EYE_HEIGHT = 1.55;
const HORIZON = 0xd4e1ec;

export class Terrain3DView {
  constructor(container, route, { dem, imagery, onStatus = () => {} }) {
    this.route = route;
    this.dem = dem;
    this.imagery = imagery;
    this.onStatus = onStatus;
    this.frame = new LocalFrame(route.lat[0], route.lng[0]);
    this.rx = new Float64Array(route.n);
    this.rz = new Float64Array(route.n);
    for (let i = 0; i < route.n; i++) {
      const p = this.frame.project(route.lat[i], route.lng[i]);
      this.rx[i] = p.x;
      this.rz[i] = p.z;
    }
    this.index = new RouteIndex(this.rx, this.rz, 25);
    this.tiles = new Map();
    this.building = 0;
    this.dir = null;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.style.cssText = 'width:100%;height:100%;display:block';
    container.appendChild(this.renderer.domElement);
    this.container = container;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(HORIZON);
    this.scene.fog = new THREE.Fog(HORIZON, 300, 1900); // hides the edge of the loaded tiles
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.3, 4000);
    this.scene.add(new THREE.HemisphereLight(0xf2f6ff, 0x4a5240, 2.2));
    const sun = new THREE.DirectionalLight(0xfff4e0, 1.5);
    sun.position.set(-0.5, 0.8, 0.4); // afternoon sun from the south-west
    this.scene.add(sun);
    this.sky = makeSky();
    this.scene.add(this.sky);

    this.materials = {
      asphalt: new THREE.MeshLambertMaterial({ color: 0x5a5c5f, polygonOffset: true, polygonOffsetFactor: -4, side: THREE.DoubleSide }),
      gravel: new THREE.MeshLambertMaterial({ color: 0xa39479, polygonOffset: true, polygonOffsetFactor: -2, side: THREE.DoubleSide }),
      timber: new THREE.MeshLambertMaterial({ color: 0x6e5238, side: THREE.DoubleSide }),
      foliage: new THREE.MeshLambertMaterial({ color: 0xffffff }),
      bark: new THREE.MeshLambertMaterial({ color: 0x4a3a2c }),
      bare: new THREE.MeshLambertMaterial({ color: 0x7b8566 }),
    };
    this.geometries = {
      cone: new THREE.ConeGeometry(1, 1, 7).translate(0, 0.5, 0),
      crown: new THREE.IcosahedronGeometry(1, 1),
      trunk: new THREE.CylinderGeometry(0.12, 0.18, 1, 5).translate(0, 0.5, 0),
      box: new THREE.BoxGeometry(1, 1, 1),
    };
    this.#buildTrail();
    this.#buildBridges();

    this.resize = new ResizeObserver(() => this.#resize());
    this.resize.observe(container);
    this.#resize();
  }

  /** Loads the tiles around the start before the ride begins. */
  async start(d) {
    const here = sampleAt(this.route, d);
    this.#syncTiles(here.lng, here.lat);
    const near = [...this.tiles.values()].filter((t) => t.ring <= 1);
    let done = 0;
    await Promise.all(
      near.map((t) =>
        t.ready.then(() => this.onStatus(`Building 3D scene ${++done}/${near.length}`)),
      ),
    );
    this.update(d, 0);
  }

  update(d, dt) {
    const here = sampleAt(this.route, d);
    const ahead = sampleAt(this.route, d + 15);
    const p = this.frame.project(here.lat, here.lng);
    const a = this.frame.project(ahead.lat, ahead.lng);
    const eye = new THREE.Vector3(p.x, here.ele + TRAIL_LIFT + EYE_HEIGHT, p.z);
    const want = new THREE.Vector3(a.x, ahead.ele + TRAIL_LIFT + EYE_HEIGHT - 0.25, a.z).sub(eye).normalize();
    if (!this.dir || dt === 0) this.dir = want;
    else this.dir.lerp(want, 1 - Math.exp(-dt * 4)).normalize();
    this.camera.position.copy(eye);
    this.camera.lookAt(eye.clone().add(this.dir));
    this.sky.position.copy(eye);

    this.#syncTiles(here.lng, here.lat);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.disposed = true;
    this.resize.disconnect();
    for (const t of this.tiles.values()) this.#dropTile(t);
    this.scene.traverse((o) => o.geometry?.dispose());
    Object.values(this.materials).forEach((m) => m.dispose());
    Object.values(this.geometries).forEach((g) => g.dispose());
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  #resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---------- tile streaming ----------

  #syncTiles(lng, lat) {
    const t = lngLatToTile(lng, lat, ZOOM);
    const cx = Math.floor(t.x);
    const cy = Math.floor(t.y);
    for (const tile of this.tiles.values()) {
      tile.ring = Math.max(Math.abs(tile.x - cx), Math.abs(tile.y - cy));
      if (tile.ring > DROP_RING) this.#dropTile(tile);
      // Built coarse while far away; rebuild with full detail now that it's close.
      else if (tile.ring <= 1 && tile.state === 'done' && !tile.near) tile.state = 'queued';
    }
    for (let dy = -LOAD_RING; dy <= LOAD_RING; dy++) {
      for (let dx = -LOAD_RING; dx <= LOAD_RING; dx++) {
        const key = `${cx + dx}/${cy + dy}`;
        if (!this.tiles.has(key)) {
          let resolve;
          const ready = new Promise((r) => (resolve = r));
          this.tiles.set(key, { key, x: cx + dx, y: cy + dy, ring: Math.max(Math.abs(dx), Math.abs(dy)), state: 'queued', ready, resolve });
        }
      }
    }
    this.#pump();
    const pending = [...this.tiles.values()].filter((x) => x.state !== 'done').length;
    if (pending !== this.lastPending) {
      this.lastPending = pending;
      this.onStatus(pending ? `Loading terrain (${pending} tiles left)` : '');
    }
  }

  #pump() {
    const queued = [...this.tiles.values()].filter((t) => t.state === 'queued').sort((a, b) => a.ring - b.ring);
    while (this.building < 3 && queued.length) {
      const tile = queued.shift();
      tile.state = 'building';
      this.building++;
      this.#buildTile(tile)
        .catch((err) => console.warn('tile failed', tile.key, err))
        .finally(() => {
          this.building--;
          tile.state = 'done';
          tile.resolve();
          if (!this.disposed) this.#pump();
        });
    }
  }

  #dropTile(tile) {
    this.tiles.delete(tile.key);
    tile.dropped = true;
    this.#disposeObjects(tile.objects);
  }

  #disposeObjects(objects = []) {
    for (const obj of objects) {
      this.scene.remove(obj);
      if (obj.isInstancedMesh) {
        obj.dispose(); // instance buffers only; the geometry is shared
        continue;
      }
      obj.geometry.dispose();
      if (obj.userData.ownsMaterial) {
        obj.material.map?.dispose();
        obj.material.dispose();
      }
    }
  }

  async #buildTile(tile) {
    const { x, y } = tile;
    const near = tile.ring <= 1;
    const GRID = near ? GRID_NEAR : GRID_FAR;
    await Promise.all([[0, 0], [1, 0], [0, 1], [1, 1]].map(([dx, dy]) => this.dem.load(x + dx, y + dy).catch(() => null)));
    const img = this.imagery ? await loadImageryMosaic(this.imagery, ZOOM, x, y, near ? 17 : 16).catch(() => null) : null;
    if (tile.dropped || this.disposed) return;

    const ground = (lng, lat) => {
      const h = this.dem.heightAt(lng, lat);
      return Number.isFinite(h) ? h : 0;
    };

    // Height field
    const n = GRID + 1;
    const pos = new Float32Array(n * n * 3);
    const uv = new Float32Array(n * n * 2);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const ll = tileToLngLat(x + i / GRID, y + j / GRID, ZOOM);
        const p = this.frame.project(ll.lat, ll.lng);
        const k = j * n + i;
        pos[k * 3] = p.x;
        pos[k * 3 + 1] = this.#gradeToTrail(p.x, p.z, ground(ll.lng, ll.lat));
        pos[k * 3 + 2] = p.z;
        uv[k * 2] = i / GRID;
        uv[k * 2 + 1] = 1 - j / GRID;
      }
    }
    const idx = new Uint32Array(GRID * GRID * 6);
    for (let j = 0, o = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const a = j * n + i;
        idx.set([a, a + n, a + 1, a + 1, a + n, a + n + 1], o);
        o += 6;
      }
    }
    const geo = withSkirt(pos, uv, idx, n);
    let material = this.materials.bare;
    let ownsMaterial = false;
    if (img) {
      const tex = new THREE.CanvasTexture(img.canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      material = new THREE.MeshLambertMaterial({ map: tex });
      ownsMaterial = true;
    }
    const mesh = new THREE.Mesh(geo, material);
    mesh.userData.ownsMaterial = ownsMaterial;
    const objects = [mesh, ...(img ? this.#plantTrees(tile, img.canvas, ground) : [])];
    objects.forEach((o) => this.scene.add(o));
    this.#disposeObjects(tile.objects); // the coarse version, if this is a rebuild
    tile.objects = objects;
    tile.near = near;
  }

  /** Grades terrain near the route to the trail elevation (except under bridges). */
  #gradeToTrail(x, z, g) {
    const near = this.index.nearest(x, z, 24);
    if (!near) return g;
    const { ele, bridge } = this.route;
    if (bridge?.[near.i] || bridge?.[near.i + 1]) return g;
    const trail = ele[near.i] + (ele[near.i + 1] - ele[near.i]) * near.t - 0.2;
    const inner = TRAIL_HALF_WIDTH + SHOULDER + 1.5;
    if (near.r <= inner) return trail;
    const s = smoothstep((near.r - inner) / (24 - inner));
    return trail + (g - trail) * s;
  }

  #plantTrees(tile, canvas, ground) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const center = tileToLngLat(tile.x + 0.5, tile.y + 0.5, ZOOM);
    const metersPerPx = tileWidthMeters(center.lat, ZOOM) / width;
    const rand = mulberry32(tile.x * 73856093 ^ tile.y * 19349663);
    const spots = scatterTrees(data, width, height, { spacing: Math.max(1, Math.round(7 / metersPerPx)), rand, max: 3500 });

    const conifers = [];
    const broadleaf = [];
    for (const s of spots) {
      // Douglas fir / western red cedar vs maple / alder; crowns kept realistic and off the path.
      const h = s.conifer ? 14 + s.size * 20 : 9 + s.size * 11;
      const radius = s.conifer ? h * 0.14 : h * 0.28;
      const ll = tileToLngLat(tile.x + s.u, tile.y + s.v, ZOOM);
      const p = this.frame.project(ll.lat, ll.lng);
      if (this.index.nearest(p.x, p.z, TRAIL_HALF_WIDTH + SHOULDER + 1.5 + radius)) continue;
      const tree = { ...s, h, radius, x: p.x, z: p.z, y: ground(ll.lng, ll.lat) - 0.3 };
      (s.conifer ? conifers : broadleaf).push(tree);
    }

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const c = new THREE.Color();
    const tint = (t) => c.setRGB(Math.min(1, (t.r / 255) * 1.3 + 0.03), Math.min(1, (t.g / 255) * 1.3 + 0.06), Math.min(1, (t.b / 255) * 1.2 + 0.02), THREE.SRGBColorSpace);
    const place = (mesh, k, x, y, z, sx, sy, sz) => mesh.setMatrixAt(k, m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(sx, sy, sz)));

    const objects = [];
    if (conifers.length) {
      const crowns = new THREE.InstancedMesh(this.geometries.cone, this.materials.foliage, conifers.length);
      const trunks = new THREE.InstancedMesh(this.geometries.trunk, this.materials.bark, conifers.length);
      conifers.forEach((t, k) => {
        place(crowns, k, t.x, t.y + t.h * 0.15, t.z, t.radius, t.h * 0.85, t.radius);
        place(trunks, k, t.x, t.y, t.z, t.h / 12, t.h * 0.3, t.h / 12);
        crowns.setColorAt(k, tint(t));
      });
      objects.push(crowns, trunks);
    }
    if (broadleaf.length) {
      const crowns = new THREE.InstancedMesh(this.geometries.crown, this.materials.foliage, broadleaf.length);
      const trunks = new THREE.InstancedMesh(this.geometries.trunk, this.materials.bark, broadleaf.length);
      broadleaf.forEach((t, k) => {
        place(crowns, k, t.x, t.y + t.h * 0.62, t.z, t.radius, t.h * 0.34, t.radius);
        place(trunks, k, t.x, t.y, t.z, t.h / 9, t.h * 0.5, t.h / 9);
        crowns.setColorAt(k, tint(t));
      });
      objects.push(crowns, trunks);
    }
    return objects;
  }

  // ---------- trail and bridges ----------

  #buildTrail() {
    this.scene.add(new THREE.Mesh(this.#ribbon(TRAIL_HALF_WIDTH + SHOULDER, TRAIL_LIFT - 0.04), this.materials.gravel));
    this.scene.add(new THREE.Mesh(this.#ribbon(TRAIL_HALF_WIDTH, TRAIL_LIFT), this.materials.asphalt));
  }

  #ribbon(halfWidth, lift) {
    const { n, ele } = this.route;
    const pos = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) {
      const [px, pz] = this.#perp(i);
      const y = ele[i] + lift;
      pos.set([this.rx[i] + px * halfWidth, y, this.rz[i] + pz * halfWidth, this.rx[i] - px * halfWidth, y, this.rz[i] - pz * halfWidth], i * 6);
    }
    const idx = [];
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  /** Unit vector pointing left of the direction of travel at sample i. */
  #perp(i) {
    const a = Math.max(0, i - 1);
    const b = Math.min(this.route.n - 1, i + 1);
    const dx = this.rx[b] - this.rx[a];
    const dz = this.rz[b] - this.rz[a];
    const len = Math.hypot(dx, dz) || 1;
    return [dz / len, -dx / len];
  }

  #buildBridges() {
    const { bridge, ele, ground, n, step } = this.route;
    if (!bridge) return;
    const hw = TRAIL_HALF_WIDTH + 0.3;
    const walls = [];
    const beams = [];
    for (let i = 0; i < n - 1; i++) {
      if (!bridge[i] && !bridge[i + 1]) continue;
      const deck = [ele[i] + TRAIL_LIFT, ele[i + 1] + TRAIL_LIFT];
      for (const side of [1, -1]) {
        const [ax, az] = this.#edge(i, side * hw);
        const [bx, bz] = this.#edge(i + 1, side * hw);
        // Deck fascia, then an open railing (mid and top rails) so the valley shows through.
        for (const [lo, hi] of [[-1.0, 0], [0.5, 0.6], [1.0, 1.12]]) {
          walls.push([ax, az, bx, bz, deck[0] + lo, deck[1] + lo, deck[0] + hi, deck[1] + hi]);
        }
        if (bridge[i]) {
          const [px, pz] = this.#perp(i);
          beams.push({ x: ax, z: az, y: deck[0] + 0.56, sx: 0.14, sy: 1.12, sz: 0.14, yaw: Math.atan2(-pz, px) });
        }
      }
      // Trestle bent every ~5 m: posts down to the ground plus a cap beam.
      if (i % Math.max(1, Math.round(5 / step)) === 0 && bridge[i]) {
        const [px, pz] = this.#perp(i);
        const yaw = Math.atan2(-pz, px);
        const top = deck[0] - 1.0;
        const bottom = ground[i] - 1;
        for (const off of [-hw, -hw / 3, hw / 3, hw]) {
          beams.push({ x: this.rx[i] + px * off, z: this.rz[i] + pz * off, y: (top + bottom) / 2, sx: 0.35, sy: top - bottom, sz: 0.35, yaw });
        }
        beams.push({ x: this.rx[i], z: this.rz[i], y: top, sx: hw * 2 + 0.6, sy: 0.35, sz: 0.4, yaw });
        for (let h = top - 6; h > bottom + 1; h -= 6) {
          beams.push({ x: this.rx[i], z: this.rz[i], y: h, sx: hw * 2 + 0.2, sy: 0.2, sz: 0.2, yaw });
        }
      }
    }
    if (walls.length) {
      const pos = [];
      for (const [ax, az, bx, bz, ya0, yb0, ya1, yb1] of walls) {
        pos.push(ax, ya0, az, bx, yb0, bz, ax, ya1, az, bx, yb0, bz, bx, yb1, bz, ax, ya1, az);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.computeVertexNormals();
      this.scene.add(new THREE.Mesh(geo, this.materials.timber));
    }
    if (beams.length) {
      const mesh = new THREE.InstancedMesh(this.geometries.box, this.materials.timber, beams.length);
      const o = new THREE.Object3D();
      beams.forEach((b, k) => {
        o.position.set(b.x, b.y, b.z);
        o.rotation.set(0, b.yaw, 0);
        o.scale.set(b.sx, b.sy, b.sz);
        o.updateMatrix();
        mesh.setMatrixAt(k, o.matrix);
      });
      this.scene.add(mesh);
    }
  }

  #edge(i, offset) {
    const [px, pz] = this.#perp(i);
    return [this.rx[i] + px * offset, this.rz[i] + pz * offset];
  }
}

/**
 * Grid geometry plus a 10 m "skirt" hanging from its outline, which hides the cracks
 * where a coarse tile meets a detailed one. Normals come from the grid alone.
 */
function withSkirt(pos, uv, idx, n) {
  const grid = new THREE.BufferGeometry();
  grid.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  grid.setIndex(new THREE.BufferAttribute(idx, 1));
  grid.computeVertexNormals();
  const normal = grid.attributes.normal.array;

  const ring = [];
  for (let i = 0; i < n; i++) ring.push(i); // north edge, west -> east
  for (let j = 1; j < n; j++) ring.push(j * n + n - 1); // east edge
  for (let i = n - 2; i >= 0; i--) ring.push((n - 1) * n + i); // south edge
  for (let j = n - 2; j >= 0; j--) ring.push(j * n); // west edge

  const base = n * n;
  const P = new Float32Array((base + ring.length) * 3);
  const N = new Float32Array((base + ring.length) * 3);
  const U = new Float32Array((base + ring.length) * 2);
  P.set(pos);
  N.set(normal);
  U.set(uv);
  ring.forEach((v, k) => {
    P.set([pos[v * 3], pos[v * 3 + 1] - 10, pos[v * 3 + 2]], (base + k) * 3);
    N.set(normal.subarray(v * 3, v * 3 + 3), (base + k) * 3);
    U.set(uv.subarray(v * 2, v * 2 + 2), (base + k) * 2);
  });
  const I = new Uint32Array(idx.length + (ring.length - 1) * 12);
  I.set(idx);
  let o = idx.length;
  for (let k = 0; k < ring.length - 1; k++) {
    const a = ring[k];
    const b = ring[k + 1];
    const sa = base + k;
    const sb = base + k + 1;
    I.set([a, sa, b, b, sa, sb, a, b, sa, b, sb, sa], o); // both windings
    o += 12;
  }
  grid.dispose();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(U, 2));
  geo.setIndex(new THREE.BufferAttribute(I, 1));
  return geo;
}

/** Spatial hash over route segments for nearest-point queries. */
class RouteIndex {
  constructor(xs, zs, cell) {
    this.xs = xs;
    this.zs = zs;
    this.cell = cell;
    this.grid = new Map();
    for (let i = 0; i < xs.length - 1; i++) {
      const keys = new Set([this.#key(xs[i], zs[i]), this.#key(xs[i + 1], zs[i + 1])]);
      for (const k of keys) {
        if (!this.grid.has(k)) this.grid.set(k, []);
        this.grid.get(k).push(i);
      }
    }
  }

  #key(x, z) {
    return `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`;
  }

  /** Closest point on the route within maxR: { r, i, t } (segment i, fraction t), or null. */
  nearest(x, z, maxR) {
    const reach = Math.ceil(maxR / this.cell);
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    let best = null;
    for (let gz = cz - reach; gz <= cz + reach; gz++) {
      for (let gx = cx - reach; gx <= cx + reach; gx++) {
        for (const i of this.grid.get(`${gx},${gz}`) ?? []) {
          const ax = this.xs[i];
          const az = this.zs[i];
          const dx = this.xs[i + 1] - ax;
          const dz = this.zs[i + 1] - az;
          const len2 = dx * dx + dz * dz || 1;
          const t = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / len2));
          const r = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
          if (r <= maxR && (!best || r < best.r)) best = { r, i, t };
        }
      }
    }
    return best;
  }
}

function makeSky() {
  const geo = new THREE.SphereGeometry(3500, 32, 16);
  const colors = [];
  const zenith = new THREE.Color(0x6f9fd2);
  const horizon = new THREE.Color(HORIZON);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const t = Math.max(0, pos.getY(i) / 3500);
    const c = horizon.clone().lerp(zenith, Math.pow(t, 0.6));
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
}

function smoothstep(t) {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}
