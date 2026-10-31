// First-person 3D view reconstructed from a DEM and satellite imagery.
//
// Terrain tiles (Web Mercator z15, ~820 m wide at 47° N) stream in around the rider.
// Each is a height-field mesh draped with satellite imagery; a corridor along the
// route is graded to the inferred trail elevation; trees are planted where the
// imagery looks like canopy; bridges inferred from the elevation profile get a
// deck, railings and trestle bents (OpenStreetMap bridge and tunnel tags take precedence);
// roads and railways that cross over the route get a concrete overpass, and tunnels a tube
// with portals. OpenStreetMap buildings beside the route are
// extruded from their footprints, and named landmarks get a simple model and a sign.
// Where a land-cover map is baked for a tile, the ground close to the rider is drawn with
// tiling grass / forest floor / dirt / asphalt textures toned by the aerial photo, and
// trees stand where the map says canopy. Beyond the tiles, a coarse far-terrain mesh draws
// the skyline in its own pass; the sun, sky and weather follow the real time and place.

import * as THREE from 'three';
import { sampleAt } from '../geo.js';
import { LocalFrame, lngLatToTile, tileToLngLat, tileWidthMeters } from './tiles.js';
import { LANDCOVER, LandCover, loadImageryMosaic } from './sources.js';
import { BUILDING_REACH, LANDMARK_REACH, placeCrossings } from './osm.js';
import { mulberry32, scatterTrees } from './vegetation.js';
import { FarTerrain } from './far.js';
import { FAIR_WEATHER, Precipitation, SkyDome, fogDensity, moonPosition, skyState, sunDirection, sunPosition } from './sky.js';
import { LiveWeather } from './weather.js';

const ZOOM = 15;
const GRID_NEAR = 128; // terrain mesh quads per tile side (~6.4 m) within one tile of the rider
const GRID_FAR = 64;
const LOAD_RING = 2; // tiles kept loaded around the rider (5 × 5)
const DROP_RING = 3;
const TRAIL_HALF_WIDTH = 1.8; // 12 ft paved path
const SHOULDER = 0.9;
const TRAIL_LIFT = 0.12;
const EYE_HEIGHT = 1.55;
const FIXED_SUN = { elevation: (50 * Math.PI) / 180, azimuth: (225 * Math.PI) / 180 }; // early afternoon, south-west
const UP = new THREE.Vector3(0, 1, 0);

export class Terrain3DView {
  constructor(container, route, { dem, imagery, features = null, look = null, sky = 'live', onStatus = () => {} }) {
    this.route = route;
    this.look = look; // { yaw, pitch, fov }: offsets from the road direction, radians; fov in degrees
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
    this.features = null; // { buildings, landmarks } by tile, once OpenStreetMap answers
    this.landmarks = []; // named landmarks beside the route, sorted by route distance

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.autoClear = false; // far pass, then the detailed scene over it
    this.renderer.domElement.style.cssText = 'width:100%;height:100%;display:block';
    container.appendChild(this.renderer.domElement);
    this.container = container;

    // Two scenes share the fog: the far one (sky dome, distant terrain) is drawn first with a
    // deep depth range, then the detailed one with a short range for precise depth up close.
    this.scene = new THREE.Scene();
    this.farScene = new THREE.Scene();
    this.fog = new THREE.FogExp2(0xd4e1ec, fogDensity(FAIR_WEATHER.visibility));
    this.scene.fog = this.farScene.fog = this.fog;
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.3, 4000);
    this.farCamera = new THREE.PerspectiveCamera(70, 1, 1000, 400000);
    this.hemis = [];
    this.suns = [];
    this.moons = [];
    for (const sc of [this.scene, this.farScene]) {
      const hemi = new THREE.HemisphereLight(0xf2f6ff, 0x4a5240, 2.2);
      const sun = new THREE.DirectionalLight(0xfff4e0, 1.5);
      const moon = new THREE.DirectionalLight(0xbfd0ff, 0);
      sc.add(hemi, sun, moon);
      this.hemis.push(hemi);
      this.suns.push(sun);
      this.moons.push(moon);
    }
    this.sky = new SkyDome(300000);
    this.farScene.add(this.sky.mesh);
    this.precipitation = new Precipitation(this.scene);
    this.liveSky = sky !== 'fixed';
    this.weather = this.liveSky ? new LiveWeather() : null;
    new FarTerrain(this.frame, route)
      .build()
      .then((mesh) => (mesh && !this.disposed ? this.farScene.add(mesh) : null))
      .catch((err) => console.warn('far terrain unavailable', err));

    this.materials = {
      asphalt: new THREE.MeshLambertMaterial({ color: 0x5a5c5f, polygonOffset: true, polygonOffsetFactor: -4, side: THREE.DoubleSide }),
      gravel: new THREE.MeshLambertMaterial({ color: 0xa39479, polygonOffset: true, polygonOffsetFactor: -2, side: THREE.DoubleSide }),
      timber: new THREE.MeshLambertMaterial({ color: 0x6e5238, side: THREE.DoubleSide }),
      foliage: new THREE.MeshLambertMaterial({ color: 0xffffff }),
      bark: new THREE.MeshLambertMaterial({ color: 0x4a3a2c }),
      bare: new THREE.MeshLambertMaterial({ color: 0x7b8566 }),
      building: new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }),
      roof: new THREE.MeshLambertMaterial({ color: 0x4f5a4c }),
      caboose: new THREE.MeshLambertMaterial({ color: 0xa8322b }),
      concrete: new THREE.MeshLambertMaterial({ color: 0xa3a39e, side: THREE.DoubleSide }),
      soffit: new THREE.MeshLambertMaterial({ color: 0x74746f, emissive: 0x3a3a37, side: THREE.DoubleSide }), // light bounced off the ground below
      roadway: new THREE.MeshLambertMaterial({ color: 0x4d4f52, side: THREE.DoubleSide }),
      tunnel: new THREE.MeshLambertMaterial({ color: 0x5c5c5e, emissive: 0x2a2a2a, side: THREE.DoubleSide }),
      berm: new THREE.MeshLambertMaterial({ color: 0x5d6b47, side: THREE.DoubleSide }),
      shade: new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.38, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6 }),
      iron: new THREE.MeshLambertMaterial({ color: 0x2b2b2b }),
    };
    this.geometries = {
      cone: new THREE.ConeGeometry(1, 1, 7).translate(0, 0.5, 0),
      crown: new THREE.IcosahedronGeometry(1, 1),
      trunk: new THREE.CylinderGeometry(0.12, 0.18, 1, 5).translate(0, 0.5, 0),
      box: new THREE.BoxGeometry(1, 1, 1),
      hip: new THREE.ConeGeometry(Math.SQRT1_2, 1, 4).rotateY(Math.PI / 4).translate(0, 0.5, 0), // 1 × 1 base
    };
    if (imagery?.landcover) {
      this.landcover = new LandCover(imagery.landcover);
      const loader = new THREE.TextureLoader();
      const detail = (name) => {
        const t = loader.load(`textures/${name}.jpg`);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
        return { value: t };
      };
      this.detail = { tGrass: detail('grass'), tFloor: detail('forest-floor'), tDirt: detail('dirt'), tAsphalt: detail('asphalt') };
    }
    this.#buildTrail();
    this.#buildBridges();
    this.#buildTunnels();

    features?.then((f) => !this.disposed && this.#setFeatures(f));

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
    const view = this.dir.clone();
    if (this.look) {
      view.applyAxisAngle(UP, this.look.yaw);
      view.applyAxisAngle(new THREE.Vector3().crossVectors(view, UP).normalize(), this.look.pitch);
      if (this.camera.fov !== this.look.fov) {
        this.camera.fov = this.look.fov;
        this.camera.updateProjectionMatrix();
      }
    }
    this.camera.position.copy(eye);
    this.camera.lookAt(view.add(eye));
    this.sky.mesh.position.copy(eye);
    this.#environment(here, eye, dt);

    this.#syncTiles(here.lng, here.lat);
    const far = this.farCamera;
    far.position.copy(eye);
    far.quaternion.copy(this.camera.quaternion);
    if (far.fov !== this.camera.fov || far.aspect !== this.camera.aspect) {
      far.fov = this.camera.fov;
      far.aspect = this.camera.aspect;
      far.updateProjectionMatrix();
    }
    this.renderer.clear();
    this.renderer.render(this.farScene, far);
    this.renderer.clearDepth();
    this.renderer.render(this.scene, this.camera);
  }

  /** Sun, sky colours, lights, haze and precipitation for now (or a fixed fair afternoon). */
  #environment(here, eye, dt) {
    if (this.weather) this.weather.poll(here.lat, here.lng);
    const w = this.weather?.current ?? FAIR_WEATHER;
    const now = this.now?.() ?? new Date();
    const sun = this.liveSky ? sunPosition(now, here.lat, here.lng) : FIXED_SUN;
    const moon = this.liveSky ? moonPosition(now, here.lat, here.lng) : { elevation: -1, azimuth: 0, fraction: 0 };
    const dir = sunDirection(sun);
    const moonDir = sunDirection(moon);
    const st = skyState(sun.elevation, w.cloud);
    this.environment = { sun, moon, weather: w };
    this.sky.set(dir, moonDir, moon.fraction, st, w, performance.now() / 1000);
    this.fog.color.setRGB(...st.horizon, THREE.SRGBColorSpace);
    this.fog.density = fogDensity(w.fog ? Math.min(w.visibility, 600) : w.visibility);
    // Moonlight scales with the phase and the moon's height; a faint floor (stars, city glow)
    // keeps the trail visible on moonless nights.
    const night = 1 - st.day;
    const moonlight = night * moon.fraction * Math.min(1, Math.max(0, moon.elevation / 0.15)) * (1 - 0.8 * w.cloud);
    for (const m of this.moons) {
      m.position.copy(moonDir).multiplyScalar(1000);
      m.intensity = 0.9 * moonlight;
    }
    for (const s of this.suns) {
      s.position.copy(dir).multiplyScalar(1000);
      s.color.setRGB(...st.sunColor, THREE.SRGBColorSpace);
      s.intensity = 1.6 * st.sun * Math.min(1, Math.max(0, sun.elevation / 0.05));
    }
    const ground = 0.3 + 0.7 * st.day;
    for (const h of this.hemis) {
      h.intensity = 0.35 + 0.35 * moonlight + 1.85 * st.day * (1 - 0.25 * w.cloud);
      h.color.setRGB(0.95 - 0.45 * night, 0.96 - 0.36 * night, 1, THREE.SRGBColorSpace);
      h.groundColor.setRGB(0.29 * ground, 0.32 * ground, 0.25 * ground, THREE.SRGBColorSpace);
    }
    const toward = (w.windDir * Math.PI) / 180; // wind blows from windDir
    const wind = new THREE.Vector2(-Math.sin(toward), Math.cos(toward)).multiplyScalar(w.windSpeed / 3.6);
    this.precipitation.set(w.snow ? 'snow' : w.rain ? 'rain' : null, w.snow || w.rain);
    this.precipitation.update(eye, Math.min(dt, 0.1), wind);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.resize.disconnect();
    for (const t of this.tiles.values()) this.#dropTile(t);
    this.scene.traverse((o) => o.geometry?.dispose());
    this.farScene.traverse((o) => o.geometry?.dispose());
    this.sky.dispose();
    this.precipitation.dispose();
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
      if (!obj.userData.sharedGeometry) obj.geometry.dispose();
      if (obj.userData.ownsMaterial) {
        obj.material.map?.dispose();
        obj.material.userData.classMap?.dispose();
        obj.material.dispose();
      }
    }
  }

  async #buildTile(tile) {
    const { x, y } = tile;
    const near = tile.ring <= 1;
    const GRID = near ? GRID_NEAR : GRID_FAR;
    await Promise.all([[0, 0], [1, 0], [0, 1], [1, 1]].map(([dx, dy]) => this.dem.load(x + dx, y + dy).catch(() => null)));
    const cover = this.landcover ? await this.landcover.load(ZOOM, x, y).catch(() => null) : null;
    const img = cover ?? (this.imagery ? await loadImageryMosaic(this.imagery, ZOOM, x, y, near ? 17 : 16).catch(() => null) : null);
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
      material = cover ? this.#coverMaterial(tex, cover) : new THREE.MeshLambertMaterial({ map: tex });
      ownsMaterial = true;
    }
    const mesh = new THREE.Mesh(geo, material);
    mesh.userData.ownsMaterial = ownsMaterial;
    const objects = [mesh, ...(img ? this.#plantTrees(tile, img.canvas, ground, cover) : []), ...this.#featureObjects(tile)];
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

  /** Photo-draped ground that switches to tiling detail textures by land-cover class up close. */
  #coverMaterial(photo, cover) {
    const classMap = new THREE.DataTexture(cover.classes, cover.size, cover.size, THREE.RedFormat);
    classMap.magFilter = classMap.minFilter = THREE.NearestFilter;
    classMap.unpackAlignment = 1;
    classMap.needsUpdate = true;
    const material = new THREE.MeshLambertMaterial({ map: photo });
    material.userData.classMap = classMap;
    material.customProgramCacheKey = () => 'landcover';
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.detail, { classMap: { value: classMap } });
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vGround;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGround = transformed;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${COVER_PARS}`)
        .replace('#include <map_fragment>', COVER_FRAGMENT);
    };
    return material;
  }

  #plantTrees(tile, canvas, ground, cover = null) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const center = tileToLngLat(tile.x + 0.5, tile.y + 0.5, ZOOM);
    const metersPerPx = tileWidthMeters(center.lat, ZOOM) / width;
    const rand = mulberry32(tile.x * 73856093 ^ tile.y * 19349663);
    // With a land-cover map, trees go where it says canopy instead of where the photo looks dark green.
    const score = cover && ((px, py) => (cover.classes[py * width + px] === LANDCOVER.forestFloor ? 0.6 : 0));
    const spots = scatterTrees(data, width, height, { spacing: Math.max(1, Math.round(14 / metersPerPx)), rand, max: 1500, score });

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
    // Foliage colour by tree type, shaded by the photo's brightness, with a little of the photo's
    // own colour so neighbours differ. Photo colour alone turns grey or blue in shadow and haze.
    const tint = (t) => {
      const shade = Math.min(1.25, Math.max(0.6, (0.3 * t.r + 0.59 * t.g + 0.11 * t.b) / 255 / 0.22));
      const base = t.conifer ? [0.2, 0.34, 0.17] : t.r > t.g * 1.05 ? [0.62, 0.42, 0.16] : [0.36, 0.5, 0.2]; // autumn when the photo says so
      const [r, g, b] = base.map((v, i) => Math.min(1, v * shade * 0.75 + ([t.r, t.g, t.b][i] / 255) * 0.32));
      return c.setRGB(r, g, b, THREE.SRGBColorSpace);
    };
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

  // ---------- OpenStreetMap buildings and landmarks ----------

  #setFeatures({ buildings, landmarks, crossings = [] }) {
    const byTile = new Map();
    const bucket = (lat, lng) => {
      const t = lngLatToTile(lng, lat, ZOOM);
      const key = `${Math.floor(t.x)}/${Math.floor(t.y)}`;
      if (!byTile.has(key)) byTile.set(key, { buildings: [], landmarks: [] });
      return byTile.get(key);
    };
    for (const b of buildings) {
      const pts = b.ring.slice(0, -1).map(([lat, lng]) => ({ lat, lng, ...this.frame.project(lat, lng) }));
      // Keep what is near the trail, but nothing the trail runs through (overhangs, covered sections).
      if (!pts.some((p) => this.index.nearest(p.x, p.z, BUILDING_REACH))) continue;
      if (pts.some((p) => this.index.nearest(p.x, p.z, TRAIL_HALF_WIDTH + 1.5))) continue;
      bucket(pts[0].lat, pts[0].lng).buildings.push({ pts, height: b.height });
    }
    for (const l of landmarks) {
      const p = this.frame.project(l.lat, l.lng);
      const near = this.index.nearest(p.x, p.z, LANDMARK_REACH + (l.ring ? 20 : 0));
      if (!near) continue;
      const lm = { ...l, x: p.x, z: p.z, d: (near.i + near.t) * this.route.step, along: near };
      this.landmarks.push(lm);
      bucket(l.lat, l.lng).landmarks.push(lm);
    }
    // Overpasses are few and long, so they're built once rather than per tile.
    const { spans, over } = placeCrossings(this.route, crossings);
    for (const o of over) {
      const objects = this.#overpass(o);
      objects.forEach((obj) => this.scene.add(obj));
      const name = o.crossing.name;
      if (name) this.landmarks.push({ id: `under:${name}`, name: `Under ${name}`, d: (o.i + o.t) * this.route.step });
    }
    // Named bridges and tunnels on the route get a banner too (not the trail's own name).
    for (const sp of spans) {
      if (sp.name && /bridge|trestle|tunnel|viaduct/i.test(sp.name)) this.landmarks.push({ id: `span:${sp.i0}`, name: sp.name, d: sp.i0 * this.route.step });
    }
    this.landmarks.sort((a, b) => a.d - b.d);
    this.features = byTile;
    // Tiles built before the answer came back get their buildings now.
    for (const tile of this.tiles.values()) {
      if (tile.state !== 'done' || !tile.objects) continue;
      const extra = this.#featureObjects(tile);
      extra.forEach((o) => this.scene.add(o));
      tile.objects.push(...extra);
    }
  }

  #ground(lng, lat, x, z) {
    const h = this.dem.heightAt(lng, lat);
    return this.#gradeToTrail(x, z, Number.isFinite(h) ? h : 0);
  }

  #featureObjects(tile) {
    const f = this.features?.get(tile.key);
    if (!f) return [];
    const objects = [];
    if (f.buildings.length) objects.push(this.#buildingMesh(f.buildings));
    for (const lm of f.landmarks) objects.push(...this.#landmarkObjects(lm));
    return objects;
  }

  /** All the tile's buildings as one mesh: walls in a muted facade colour, flat roofs. */
  #buildingMesh(buildings) {
    const pos = [];
    const col = [];
    const c = new THREE.Color();
    for (const b of buildings) {
      const hs = b.pts.map((p) => this.#ground(p.lng, p.lat, p.x, p.z));
      const base = Math.min(...hs) - 0.5;
      const top = Math.max(...hs) + b.height;
      const rand = mulberry32(Math.round(b.pts[0].x * 31 + b.pts[0].z * 17));
      const wall = FACADES[Math.floor(rand() * FACADES.length)];
      const n = b.pts.length;
      for (let i = 0; i < n; i++) {
        const a = b.pts[i];
        const e = b.pts[(i + 1) % n];
        pos.push(a.x, base, a.z, e.x, base, e.z, e.x, top, e.z, a.x, base, a.z, e.x, top, e.z, a.x, top, a.z);
        c.setHex(wall).multiplyScalar(0.92 + rand() * 0.12);
        for (let k = 0; k < 6; k++) col.push(c.r, c.g, c.b);
      }
      const tris = THREE.ShapeUtils.triangulateShape(b.pts.map((p) => new THREE.Vector2(p.x, p.z)), []);
      c.setHex(0x6b6d70);
      for (const tri of tris) {
        for (const k of tri) {
          pos.push(b.pts[k].x, top, b.pts[k].z);
          col.push(c.r, c.g, c.b);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.computeVertexNormals(); // flat shading: the geometry is not indexed
    return new THREE.Mesh(geo, this.materials.building);
  }

  /** A simple model for the landmark (shelter or railcar) built from the shared pieces, plus its name sign. */
  #landmarkObjects(lm) {
    const objects = [];
    const y = this.#ground(lm.lng, lm.lat, lm.x, lm.z);
    const { w, l, yaw } = this.#footprint(lm);
    const part = (geometry, material, dx, dy, dz, sx, sy, sz) => {
      const m = new THREE.Mesh(geometry, material);
      m.position.set(lm.x + dx * Math.cos(yaw) + dz * Math.sin(yaw), y + dy, lm.z - dx * Math.sin(yaw) + dz * Math.cos(yaw));
      m.rotation.y = yaw;
      m.scale.set(sx, sy, sz);
      m.userData.sharedGeometry = true;
      objects.push(m);
    };
    const { box, hip } = this.geometries;
    let height = 2.5;
    if (lm.kind === 'shelter') {
      // Timber pavilion: posts every ~4 m along each long side under a hipped roof.
      const posts = Math.max(2, Math.round(l / 4) + 1);
      for (let k = 0; k < posts; k++) {
        const dz = -l / 2 + 0.3 + ((l - 0.6) * k) / (posts - 1);
        for (const dx of [-w / 2 + 0.3, w / 2 - 0.3]) part(box, this.materials.timber, dx, 1.5, dz, 0.3, 3, 0.3);
      }
      part(box, this.materials.timber, 0, 3.05, 0, w + 0.4, 0.2, l + 0.4);
      part(hip, this.materials.roof, 0, 3.15, 0, w + 1, Math.min(w, l) * 0.45, l + 1);
      height = 3.2 + Math.min(w, l) * 0.45;
    } else if (lm.kind === 'railcar') {
      // Caboose: red body with a cupola, sitting on dark trucks.
      part(box, this.materials.iron, 0, 0.5, -3, 2.2, 1, 2);
      part(box, this.materials.iron, 0, 0.5, 3, 2.2, 1, 2);
      part(box, this.materials.caboose, 0, 2.4, 0, 3, 2.8, 10);
      part(box, this.materials.caboose, 0, 4.3, 0, 2.4, 1, 3);
      part(box, this.materials.iron, 0, 4.85, 0, 2.7, 0.12, 3.4);
      height = 5;
    } else {
      part(box, this.materials.timber, 0, 1.25, 0, 0.15, 2.5, 0.15);
    }
    objects.push(makeLabel(lm.name, lm.x, y + height + 1.6, lm.z));
    return objects;
  }

  /** Width, length and heading of a landmark: its OSM outline if it has one, else along the trail. */
  #footprint(lm) {
    const kindSize = { shelter: [5, 8], railcar: [3, 10], sign: [1, 1] }[lm.kind];
    if (lm.ring && lm.kind !== 'railcar') {
      const pts = lm.ring.slice(0, -1).map(([lat, lng]) => this.frame.project(lat, lng));
      let best = null;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        if (!best || len > best.len) best = { len, yaw: Math.atan2(b.x - a.x, b.z - a.z) };
      }
      // Extent across the long axis.
      const ax = Math.sin(best.yaw);
      const az = Math.cos(best.yaw);
      const along = pts.map((p) => (p.x - lm.x) * ax + (p.z - lm.z) * az);
      const across = pts.map((p) => -(p.x - lm.x) * az + (p.z - lm.z) * ax);
      const l = Math.max(...along) - Math.min(...along);
      const w = Math.max(...across) - Math.min(...across);
      if (l > 2 && w > 2 && l < 60) return { w, l, yaw: best.yaw };
    }
    const i = lm.along.i;
    return { w: kindSize[0], l: kindSize[1], yaw: Math.atan2(this.rx[i + 1] - this.rx[i], this.rz[i + 1] - this.rz[i]) };
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

  /** A road or railway bridge crossing over the route: deck, parapets, piers and its shade. */
  #overpass({ crossing: c, i, t }) {
    const { rx, rz } = this;
    const { ele, step } = this.route;
    const cx = rx[i] + (rx[i + 1] - rx[i]) * t;
    const cz = rz[i] + (rz[i + 1] - rz[i]) * t;
    const trailY = ele[i] + (ele[i + 1] - ele[i]) * t;
    const pts = c.line.map(([lat, lng]) => this.frame.project(lat, lng));
    // Resample the line every 4 m, with distance s from where it crosses the route.
    const line = [];
    let s = 0;
    let sc = 0;
    let bestD = Infinity;
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k];
      const b = pts[k + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const n = Math.max(1, Math.ceil(len / 4));
      for (let j = 0; j < n; j++) {
        const x = a.x + ((b.x - a.x) * j) / n;
        const z = a.z + ((b.z - a.z) * j) / n;
        line.push({ x, z, s: s + (len * j) / n });
        const d = Math.hypot(x - cx, z - cz);
        if (d < bestD) [bestD, sc] = [d, s + (len * j) / n];
      }
      s += len;
    }
    line.push({ x: pts.at(-1).x, z: pts.at(-1).z, s });
    const footway = /^(footway|cycleway|path|pedestrian|steps|bridleway)$/.test(c.way);
    const thick = footway ? 0.8 : 1.4;
    const clearance = c.way.startsWith('rail') ? 7 : footway ? 4.6 : 5.4;
    const top = trailY + TRAIL_LIFT + clearance + thick;
    const seg = line.filter((p) => Math.abs(p.s - sc) <= 220);
    for (const p of seg) {
      const ll = this.frame.unproject(p.x, p.z);
      const g = this.dem.heightAt(ll.lng, ll.lat);
      p.g = Number.isFinite(g) ? g : trailY;
      // Level over the route, easing down at 3 % toward the embankments at either end.
      p.y = Math.max(p.g + 0.6, top - 0.03 * Math.abs(p.s - sc));
    }
    if (seg.length < 2) return [];
    const hw = c.width / 2;
    const quads = { roadway: [], concrete: [], soffit: [] };
    const side = (k, off) => {
      const a = seg[Math.max(0, k - 1)];
      const b = seg[Math.min(seg.length - 1, k + 1)];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const l = Math.hypot(dx, dz) || 1;
      return [seg[k].x - (dz / l) * off, seg[k].z + (dx / l) * off];
    };
    const quad = (list, a0, a1, b0, b1) => list.push([...a0, ...a1, ...b0, ...b1]);
    for (let k = 0; k < seg.length - 1; k++) {
      const [ya, yb] = [seg[k].y, seg[k + 1].y];
      const [lax, laz] = side(k, -hw);
      const [rax, raz] = side(k, hw);
      const [lbx, lbz] = side(k + 1, -hw);
      const [rbx, rbz] = side(k + 1, hw);
      quad(quads.roadway, [lax, ya, laz], [rax, ya, raz], [lbx, yb, lbz], [rbx, yb, rbz]);
      quad(quads.soffit, [lax, ya - thick, laz], [rax, ya - thick, raz], [lbx, yb - thick, lbz], [rbx, yb - thick, rbz]);
      for (const [ax, az, bx, bz] of [[lax, laz, lbx, lbz], [rax, raz, rbx, rbz]]) {
        // Girder face down to the soffit, then a solid parapet.
        quad(quads.concrete, [ax, ya - thick, az], [ax, ya + 1.05, az], [bx, yb - thick, bz], [bx, yb + 1.05, bz]);
      }
    }
    const objects = Object.entries(quads).map(([m, list]) => {
      const pos = [];
      for (const [ax, ay, az, bx, by, bz, cx2, cy, cz2, dx, dy, dz] of list) pos.push(ax, ay, az, cx2, cy, cz2, bx, by, bz, bx, by, bz, cx2, cy, cz2, dx, dy, dz);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.computeVertexNormals();
      return new THREE.Mesh(geo, this.materials[m]);
    });
    // Piers every ~32 m where the deck is well above the ground, well clear of the trail.
    const piers = [];
    const across = hw > 3 ? [-hw * 0.55, hw * 0.55] : [0];
    for (let k = 0; k < seg.length; k++) {
      const p = seg[k];
      if (Math.abs(Math.round(p.s - sc) % 32) > 3 || p.y - thick - p.g < 2.5) continue;
      for (const off of across) {
        const [x, z] = side(k, off);
        if (this.index.nearest(x, z, TRAIL_HALF_WIDTH + SHOULDER + 4)) continue;
        piers.push({ x, z, y0: p.g - 1, y1: p.y - thick });
      }
    }
    if (piers.length) {
      const m = new THREE.InstancedMesh(this.geometries.box, this.materials.concrete, piers.length);
      const o = new THREE.Object3D();
      piers.forEach((p, k) => {
        o.position.set(p.x, (p.y0 + p.y1) / 2, p.z);
        o.scale.set(1.1, p.y1 - p.y0, 1.1);
        o.updateMatrix();
        m.setMatrixAt(k, o.matrix);
      });
      objects.push(m);
    }
    // Shade on the trail under the deck (no shadow maps here).
    const angle = Math.abs(Math.sin(Math.atan2(rz[i + 1] - rz[i], rx[i + 1] - rx[i]) - Math.atan2(seg.at(-1).z - seg[0].z, seg.at(-1).x - seg[0].x))) || 1;
    const half = Math.min(60, hw / Math.max(0.3, angle));
    const d0 = Math.max(0, Math.floor(((i + t) * step - half) / step));
    const d1 = Math.min(this.route.n - 1, Math.ceil(((i + t) * step + half) / step));
    const pos = [];
    const sw = TRAIL_HALF_WIDTH + SHOULDER;
    for (let k = d0; k < d1; k++) {
      const [ax, az] = this.#edge(k, -sw);
      const [bx, bz] = this.#edge(k, sw);
      const [cx2, cz2] = this.#edge(k + 1, -sw);
      const [dx, dz] = this.#edge(k + 1, sw);
      const ya = ele[k] + TRAIL_LIFT + 0.03;
      const yb = ele[k + 1] + TRAIL_LIFT + 0.03;
      pos.push(ax, ya, az, cx2, yb, cz2, bx, ya, bz, bx, ya, bz, cx2, yb, cz2, dx, yb, dz);
    }
    if (pos.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      objects.push(new THREE.Mesh(geo, this.materials.shade));
    }
    return objects;
  }

  /**
   * Tunnels the route runs through: walls, a flat ceiling and a portal at each end. On trails
   * these are nearly always underpasses below a road embankment, which the bare-earth DEM
   * leaves out, so an earth berm is built over the tube and the portals span its width.
   */
  #buildTunnels() {
    const { tunnel, ele, n } = this.route;
    if (!tunnel?.some((v) => v)) return;
    const hw = TRAIL_HALF_WIDTH + 1.4;
    const height = 4.8;
    const pos = [];
    const earth = [];
    const portals = [];
    const BERM = 22; // half width of the embankment across the trail
    const lid = height + 1.6;
    for (let i = 0; i < n - 1; i++) {
      if (!tunnel[i] || !tunnel[i + 1]) continue;
      const ya = ele[i] + TRAIL_LIFT;
      const yb = ele[i + 1] + TRAIL_LIFT;
      const [la, lza] = this.#edge(i, -hw);
      const [ra, rza] = this.#edge(i, hw);
      const [lb, lzb] = this.#edge(i + 1, -hw);
      const [rb, rzb] = this.#edge(i + 1, hw);
      const wall = (ax, az, bx, bz) => pos.push(ax, ya - 0.2, az, bx, yb - 0.2, bz, ax, ya + height, az, bx, yb - 0.2, bz, bx, yb + height, bz, ax, ya + height, az);
      wall(la, lza, lb, lzb);
      wall(ra, rza, rb, rzb);
      pos.push(la, ya + height, lza, lb, yb + height, lzb, ra, ya + height, rza, ra, ya + height, rza, lb, yb + height, lzb, rb, yb + height, rzb);
      // Berm: flat top out to BERM, then 1:1.5 side slopes down to the ground.
      for (const sgn of [-1, 1]) {
        const [ta, tza] = this.#edge(i, sgn * BERM);
        const [tb, tzb] = this.#edge(i + 1, sgn * BERM);
        const [fa, fza] = this.#edge(i, sgn * (BERM + lid * 1.5));
        const [fb, fzb] = this.#edge(i + 1, sgn * (BERM + lid * 1.5));
        earth.push(this.rx[i], ya + lid, this.rz[i], this.rx[i + 1], yb + lid, this.rz[i + 1], ta, ya + lid, tza, ta, ya + lid, tza, this.rx[i + 1], yb + lid, this.rz[i + 1], tb, yb + lid, tzb);
        earth.push(ta, ya + lid, tza, tb, yb + lid, tzb, fa, ya - 0.5, fza, fa, ya - 0.5, fza, tb, yb + lid, tzb, fb, yb - 0.5, fzb);
      }
      if (!tunnel[i - 1] || !tunnel[i + 2]) portals.push(tunnel[i - 1] ? i + 1 : i);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    this.scene.add(new THREE.Mesh(geo, this.materials.tunnel));
    const bermGeo = new THREE.BufferGeometry();
    bermGeo.setAttribute('position', new THREE.Float32BufferAttribute(earth, 3));
    bermGeo.computeVertexNormals();
    this.scene.add(new THREE.Mesh(bermGeo, this.materials.berm));
    // Portal headwalls: a lintel over the opening and wing walls out to the berm's edges.
    const blocks = [];
    for (const i of portals) {
      const [px, pz] = this.#perp(i);
      const yaw = Math.atan2(-pz, px);
      const y = ele[i] + TRAIL_LIFT;
      blocks.push({ x: this.rx[i], z: this.rz[i], y: y + height + 0.9, sx: hw * 2 + 0.2, sy: 1.8, yaw });
      const wing = BERM - hw;
      for (const sgn of [-1, 1]) {
        const off = sgn * (hw + wing / 2);
        blocks.push({ x: this.rx[i] + px * off, z: this.rz[i] + pz * off, y: y + lid / 2 - 0.5, sx: wing, sy: lid + 1, yaw });
      }
    }
    const m = new THREE.InstancedMesh(this.geometries.box, this.materials.concrete, blocks.length);
    const o = new THREE.Object3D();
    blocks.forEach((b, k) => {
      o.position.set(b.x, b.y, b.z);
      o.rotation.set(0, b.yaw, 0);
      o.scale.set(b.sx, b.sy, 1.2);
      o.updateMatrix();
      m.setMatrixAt(k, o.matrix);
    });
    this.scene.add(m);
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
// Land-cover ground shading. Up close each class uses its own texture (two scales mixed to hide
// the repeat), lit by a softened brightness from a blurred (high mip) read of the aerial photo,
// so photo shadows and clearings still show without its smear. Classes are blended bilinearly
// from the 4 nearest texels.
const COVER_PARS = `
uniform sampler2D classMap, tGrass, tFloor, tDirt, tAsphalt;
varying vec3 vGround;
vec3 detail(sampler2D t, vec2 g, float s) { return 0.5 * (texture(t, g / s).rgb + texture(t, g / (s * 2.7) + 0.37).rgb); }
`;
const COVER_FRAGMENT = `
#ifdef USE_MAP
  vec3 photo = texture(map, vMapUv).rgb;
  float fade = 1.0 - smoothstep(60.0, 350.0, distance(vGround, cameraPosition));
  vec3 ground = photo;
  // Most of the screen is beyond the fade: skip the class lookups and detail textures there.
  if (fade > 0.0) {
  vec3 tone = texture(map, vMapUv, 3.5).rgb;
  ivec2 size = textureSize(classMap, 0);
  vec2 tc = vec2(vMapUv.x, 1.0 - vMapUv.y) * vec2(size) - 0.5;
  ivec2 t0 = ivec2(floor(tc));
  vec2 f = fract(tc);
  vec4 w = vec4(0.0); // grass, forest floor, dirt, paved
  float water = 0.0;
  for (int k = 0; k < 4; k++) {
    ivec2 o = ivec2(k & 1, k >> 1);
    float wt = mix(1.0 - f.x, f.x, float(o.x)) * mix(1.0 - f.y, f.y, float(o.y));
    int c = int(texelFetch(classMap, clamp(t0 + o, ivec2(0), size - 1), 0).r * 255.0 + 0.5);
    if (c == ${LANDCOVER.grass}) w.x += wt;
    else if (c == ${LANDCOVER.forestFloor}) w.y += wt;
    else if (c == ${LANDCOVER.dirt}) w.z += wt;
    else if (c == ${LANDCOVER.paved}) w.w += wt;
    else if (c == ${LANDCOVER.water}) water += wt;
  }
  vec2 g = vGround.xz;
  float shade = clamp(dot(tone, vec3(0.2126, 0.7152, 0.0722)) / 0.09, 0.55, 1.2);
  vec3 textured = shade * (w.x * detail(tGrass, g, 2.0) + w.y * detail(tFloor, g, 3.0) + w.z * detail(tDirt, g, 4.0) + w.w * detail(tAsphalt, g, 3.5))
    + water * mix(tone * 0.85, vec3(0.55, 0.66, 0.78), 0.3)
    + photo * (1.0 - w.x - w.y - w.z - w.w - water);
  ground = mix(photo, textured, fade);
  }
  diffuseColor.rgb *= ground;
#endif
`;

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

// Muted facade colours: white and grey siding, beige stucco, brick, dark brown.
const FACADES = [0xe4e1da, 0xc9c7c2, 0xd8c8a8, 0xa86c56, 0x8a7a68, 0xb9c2c8];

/** A name sign that always faces the camera; its canvas texture is the only per-landmark asset. */
function makeLabel(text, x, y, z) {
  const font = 'bold 44px system-ui, sans-serif';
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  const w = Math.min(1024, Math.ceil(ctx.measureText(text).width) + 48);
  canvas.width = w;
  canvas.height = 72;
  ctx.font = font;
  ctx.fillStyle = 'rgba(17, 19, 22, 0.82)';
  ctx.beginPath();
  ctx.roundRect(0, 0, w, 72, 16);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 24, 38, w - 48);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
  sprite.scale.set((w / 72) * 1.6, 1.6, 1);
  sprite.position.set(x, y, z);
  sprite.userData.sharedGeometry = true;
  sprite.userData.ownsMaterial = true;
  return sprite;
}

function smoothstep(t) {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}
