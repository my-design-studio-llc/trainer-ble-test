// Sky, sun and weather effects.
//
// The sun is placed from the real date, time and the rider's position; the sky dome, the
// fog colour and the lights follow its elevation, so rides at dusk or night look like dusk or
// night. Weather (cloud cover, visibility, rain, snow, wind) comes from weather.js; clouds are
// drawn on the dome and rain or snow falls around the camera.

import * as THREE from 'three';
import { FAIR_WEATHER, fogDensity, moonPosition, skyState, sunPosition } from './sun.js';

export { FAIR_WEATHER, fogDensity, moonPosition, skyState, sunPosition };

const RAD = Math.PI / 180;

/** Unit vector toward the sun (or moon) in the local frame (x east, y up, z south). */
export function sunDirection({ elevation, azimuth }) {
  return new THREE.Vector3(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation));
}

export class SkyDome {
  constructor(radius) {
    this.uniforms = {
      sunDir: { value: new THREE.Vector3(0, 1, 0) },
      moonDir: { value: new THREE.Vector3(0, -1, 0) },
      moonFraction: { value: 0 },
      zenith: { value: new THREE.Color() },
      horizon: { value: new THREE.Color() },
      sunColor: { value: new THREE.Color() },
      day: { value: 1 },
      golden: { value: 0 },
      cloud: { value: 0 },
      wind: { value: new THREE.Vector2() },
      time: { value: 0 },
    };
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 48, 24),
      new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, fog: false }),
    );
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
  }

  set(sunDir, moonDir, moonFraction, state, weather, time) {
    const u = this.uniforms;
    u.sunDir.value.copy(sunDir);
    u.moonDir.value.copy(moonDir);
    u.moonFraction.value = moonFraction;
    u.zenith.value.setRGB(...state.zenith);
    u.horizon.value.setRGB(...state.horizon);
    u.sunColor.value.setRGB(...state.sunColor);
    u.day.value = state.day;
    u.golden.value = state.golden;
    u.cloud.value = weather.cloud;
    // Clouds drift with the wind (direction it blows from, so they move the other way).
    const v = weather.windSpeed / 3.6 / 2500;
    u.wind.value.set(-Math.sin(weather.windDir * RAD) * v, Math.cos(weather.windDir * RAD) * v);
    u.time.value = time;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

const SKY_VERT = `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// Colours are written as display (sRGB) values, like the uniforms.
const SKY_FRAG = `
uniform vec3 sunDir, moonDir, zenith, horizon, sunColor;
uniform float day, golden, cloud, time, moonFraction;
uniform vec2 wind;
varying vec3 vDir;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return v;
}
void main() {
  vec3 d = normalize(vDir);
  float h = max(d.y, 0.0);
  vec3 col = mix(horizon, zenith, pow(h, 0.45));
  float s = max(dot(d, sunDir), 0.0);
  float clear = 1.0 - cloud * 0.85;
  // Glow around the sun, wide and warm near sunrise and sunset.
  col += sunColor * (pow(s, 6.0) * (0.12 + 0.5 * golden) + pow(s, 64.0) * 0.35) * clear * max(day, golden);
  col += vec3(1.0, 0.97, 0.9) * smoothstep(0.99985, 0.9999, s) * clear * step(-0.02, sunDir.y);
  // Stars on a clear night.
  if (d.y > 0.0) {
    vec2 sp = floor(vec2(atan(d.z, d.x), asin(d.y)) * 380.0);
    float star = step(0.9975, hash(sp)) * hash(sp + 3.7);
    col += vec3(star) * (1.0 - day) * (1.0 - cloud) * smoothstep(0.0, 0.15, d.y);
  }
  // The moon: a sphere lit from the real sun direction, so its phase and the tilt of the
  // terminator come out right. Drawn at 2× its real size (0.26° radius) to read on a phone.
  float md = dot(d, moonDir);
  if (md > 0.9995) {
    vec3 u = (d - moonDir * md) / 0.0095;
    float r2 = dot(u, u);
    if (r2 < 1.0) {
      vec3 n = u - moonDir * sqrt(1.0 - r2);
      float lit = smoothstep(-0.04, 0.08, dot(n, sunDir));
      float maria = 0.82 + 0.18 * noise(u.xy * 2.6 + u.z * 1.7 + 4.0);
      vec3 moonCol = vec3(0.96, 0.95, 0.9) * maria * (lit + 0.03);
      col = mix(col, max(col, moonCol), smoothstep(1.0, 0.85, r2) * mix(1.0, 0.5, day) * step(-0.01, moonDir.y));
    }
  }
  col += vec3(0.45, 0.5, 0.62) * pow(max(md, 0.0), 300.0) * moonFraction * (1.0 - day) * clear * 0.35;
  // Clouds on a flat layer, thinning toward the horizon.
  if (d.y > 0.0 && cloud > 0.02) {
    vec2 p = d.xz / (d.y + 0.06) * 1.6 + wind * time;
    float n = fbm(p);
    float c = smoothstep(1.0 - cloud - 0.18, 1.0 - cloud + 0.22, n) * smoothstep(0.0, 0.1, d.y);
    float lit = 0.75 + 0.25 * pow(s, 3.0);
    vec3 night = vec3(0.05, 0.06, 0.08) + vec3(0.1, 0.11, 0.13) * moonFraction * step(0.0, moonDir.y);
    vec3 cloudCol = mix(night, vec3(1.0, 0.99, 0.97), day) * (1.0 - 0.42 * cloud) * lit;
    cloudCol = mix(cloudCol, sunColor * vec3(1.0, 0.75, 0.6), golden * 0.55 * (0.5 + 0.5 * s));
    col = mix(col, cloudCol, c * 0.95);
  }
  gl_FragColor = vec4(col, 1.0);
}`;

/** Rain streaks or snowflakes in a box that follows the camera. */
export class Precipitation {
  constructor(scene) {
    this.scene = scene;
    this.kind = null;
    this.object = null;
  }

  /** kind: 'rain' | 'snow' | null; amount 0..1 */
  set(kind, amount) {
    const count = Math.round(amount * (kind === 'snow' ? 6000 : 9000));
    if (kind === this.kind && count === this.count) return;
    this.#clear();
    this.kind = kind;
    this.count = count;
    if (!kind || !count) return;
    this.box = 40;
    this.offsets = new Float32Array(count * 3);
    for (let i = 0; i < this.offsets.length; i++) this.offsets[i] = Math.random() * this.box;
    if (kind === 'rain') {
      const pos = new Float32Array(count * 6);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      this.object = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xaab4c0, transparent: true, opacity: 0.45, fog: true }));
    } else {
      const pos = new Float32Array(count * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      this.object = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.05, map: flakeTexture(), transparent: true, depthWrite: false, fog: true }));
    }
    this.object.frustumCulled = false;
    this.scene.add(this.object);
  }

  update(eye, dt, wind) {
    if (!this.object) return;
    const fall = this.kind === 'rain' ? 9 : 1.1;
    const pos = this.object.geometry.attributes.position.array;
    const b = this.box;
    const wrap = (v) => ((v % b) + b) % b;
    for (let i = 0; i < this.count; i++) {
      const o = this.offsets;
      o[i * 3] += wind.x * dt * (this.kind === 'snow' ? 1 : 0.3);
      o[i * 3 + 1] -= fall * dt;
      o[i * 3 + 2] += wind.y * dt * (this.kind === 'snow' ? 1 : 0.3);
      if (this.kind === 'snow') o[i * 3] += Math.sin(o[i * 3 + 1] * 1.7 + i) * 0.3 * dt;
      const x = eye.x - b / 2 + wrap(o[i * 3] - eye.x);
      const y = eye.y - b / 2 + wrap(o[i * 3 + 1] - eye.y);
      const z = eye.z - b / 2 + wrap(o[i * 3 + 2] - eye.z);
      if (this.kind === 'rain') {
        pos.set([x, y, z, x + wind.x * 0.03, y + 0.55, z + wind.y * 0.03], i * 6);
      } else {
        pos.set([x, y, z], i * 3);
      }
    }
    this.object.geometry.attributes.position.needsUpdate = true;
  }

  #clear() {
    if (!this.object) return;
    this.scene.remove(this.object);
    this.object.geometry.dispose();
    this.object.material.map?.dispose();
    this.object.material.dispose();
    this.object = null;
  }

  dispose() {
    this.#clear();
  }
}

/** A soft round dot, so snowflakes aren't drawn as squares. */
function flakeTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.5, 'rgba(255,255,255,0.8)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}
