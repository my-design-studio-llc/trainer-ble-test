import { buildRoute, distanceAtTime, sampleAt } from './geo.js';
import { parseTrackFile } from './parsers.js';
import { DEFAULT_RIDER, stepSpeed } from './physics.js';
import { ElevationProfile } from './profile.js';
import { Trainer, HeartRateMonitor, bluetoothAvailable } from './trainer.js';
import { exportRideTCX, exportRouteCSV, exportRouteJSON } from './export.js';
import { CanvasMiniMap } from './minimap2d.js';
import { DEM_ATTRIBUTION, DemSampler, IMAGERY_PROVIDERS, createImagery } from './terrain/sources.js';
import { prepareRoute3D } from './terrain/route3d.js';

// Bump on every change so the page shows when it has updated.
const VERSION = '0.2.0';
const SAMPLE_GPX = '../samples/cross-kirkland-corridor.gpx';

// three.js is only downloaded when a ride starts.
const loadTerrainView = () => import('./terrain/view3d.js');

const $ = (id) => document.getElementById(id);

// ---------- settings (per-browser convenience only) ----------

const SETTINGS_KEY = 'ride-3d-settings';
const settings = {
  mass: DEFAULT_RIDER.mass,
  difficulty: 50,
  mode: 'power',
  imagery: 'esri',
  ...readSettings(),
};

function readSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {};
  } catch {
    return {};
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable */
  }
}

// ---------- state ----------

let route = null;
let ride = null;
const sensors = { power: undefined, cadence: undefined, speed: undefined, hr: undefined, trainerAt: 0, hrAt: 0 };
const trainer = new Trainer();
const hrm = new HeartRateMonitor();

// ---------- setup screen ----------

function init() {
  $('ver').textContent = `v${VERSION}`;
  $('mass').value = settings.mass;
  $('difficulty').value = settings.difficulty;
  $('mode').value = settings.mode;
  for (const [id, p] of Object.entries(IMAGERY_PROVIDERS)) $('imagery').add(new Option(p.label, id));
  $('imagery').value = IMAGERY_PROVIDERS[settings.imagery] ? settings.imagery : 'esri';
  for (const id of ['mass', 'difficulty', 'imagery']) $(id).addEventListener('change', readSettingsForm);

  $('file-input').addEventListener('change', onFile);
  $('load-sample').addEventListener('click', loadSample);
  $('export-csv').addEventListener('click', () => route && exportRouteCSV(route));
  $('export-json').addEventListener('click', () => route && exportRouteJSON(route));
  $('start').addEventListener('click', startRide);

  setupRideControls();
  if (new URLSearchParams(location.search).has('sample')) loadSample();
}

function readSettingsForm() {
  settings.mass = Number($('mass').value) || DEFAULT_RIDER.mass;
  settings.difficulty = Math.min(100, Math.max(0, Number($('difficulty').value)));
  settings.imagery = $('imagery').value;
  saveSettings();
}

function showError(msg) {
  $('setup-error').textContent = msg;
}

async function onFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const { name, points } = parseTrackFile(await file.text(), file.name);
    setRoute(buildRoute(points, { name }));
  } catch (err) {
    showError(err.message);
  }
}

async function loadSample() {
  try {
    const res = await fetch(SAMPLE_GPX);
    if (!res.ok) throw new Error(`Could not load the sample route (${res.status})`);
    const { name, points } = parseTrackFile(await res.text(), 'sample.gpx');
    setRoute(buildRoute(points, { name }));
  } catch (err) {
    showError(err.message);
  }
}

function setRoute(r) {
  route = r;
  showError('');
  $('route-card').hidden = false;
  $('route-name').textContent = r.name;
  $('route-stats').textContent = [
    `${(r.total / 1000).toFixed(2)} km`,
    r.hasEle ? `${Math.round(r.climb)} m climbing` : 'no elevation data',
    `${r.n} points (every ${r.step} m)`,
    r.hasTime ? `recorded time ${formatTime(r.time[r.n - 1])}` : 'no time data',
  ].join(' · ');
  $('start-km').max = (r.total / 1000).toFixed(1);
  $('start').disabled = false;
}

// ---------- ride ----------

async function startRide() {
  readSettingsForm();
  showError('');
  const startD = Math.min(Math.max(0, Number($('start-km').value) * 1000 || 0), route.total - 1);

  $('start').disabled = true;
  let r = route;
  let view;
  let minimap;
  let attribution = '';
  try {
    const { Terrain3DView } = await loadTerrainView();
    const imagery = createImagery(settings.imagery);
    const dem = new DemSampler();
    r = await prepareRoute3D(route, dem, showError);
    showError('');
    showRideScreen();
    view = new Terrain3DView($('pano'), r, { dem, imagery, onStatus: showStatus });
    await view.start(startD);
    minimap = new CanvasMiniMap($('minimap'), r);
    attribution = `${imagery.attribution} · ${DEM_ATTRIBUTION} · Road height, bridges and trees are inferred`;
  } catch (err) {
    view?.dispose?.();
    $('ride').hidden = true;
    $('setup').hidden = false;
    return showError(err.message);
  } finally {
    $('start').disabled = false;
  }

  $('attribution').textContent = attribution;
  ride = {
    route: r,
    d: startD,
    v: 0,
    replayT: r.time[Math.floor(startD / r.step)],
    elapsed: 0,
    paused: false,
    finished: false,
    samples: [],
    nextSampleAt: 0,
    lastGradeSent: null,
    lastGradeAt: -Infinity,
    resistance: null, // fixed resistance % set from the bar; null follows the road grade
    lastFrame: performance.now(),
    raf: 0,
    view,
    minimap,
    profile: new ElevationProfile($('profile'), r),
  };
  $('hud-total').textContent = `/ ${(r.total / 1000).toFixed(1)} km`;
  $('pause').textContent = 'Pause';
  updateModeControls();
  if (new URLSearchParams(location.search).has('debug')) window.__ride = ride;
  ride.raf = requestAnimationFrame(frame);
}

function showRideScreen() {
  $('pano').replaceChildren();
  $('setup').hidden = true;
  $('ride').hidden = false;
  $('banner').hidden = true;
}

function frame(now) {
  const dt = Math.min(0.25, (now - ride.lastFrame) / 1000);
  ride.lastFrame = now;
  const { route } = ride;
  const here = sampleAt(route, ride.d);
  const rider = { ...DEFAULT_RIDER, mass: settings.mass };
  const trainerFresh = now - sensors.trainerAt < 3000;

  if (!ride.paused && !ride.finished) {
    switch (settings.mode) {
      case 'power':
        ride.v = stepSpeed(ride.v, trainerFresh ? sensors.power ?? 0 : 0, here.grade, dt, rider);
        ride.d += ride.v * dt;
        break;
      case 'trainer-speed':
        ride.v = trainerFresh ? sensors.speed ?? 0 : 0;
        ride.d += ride.v * dt;
        break;
      case 'replay': {
        ride.replayT += dt * (Number($('replay-speed').value) || 1);
        const next = distanceAtTime(route, ride.replayT);
        ride.v = dt > 0 ? (next - ride.d) / dt : 0;
        ride.d = next;
        break;
      }
      case 'manual': {
        const target = (Number($('manual-speed').value) || 0) / 3.6;
        ride.v += (target - ride.v) * (1 - Math.exp(-dt * 1.5));
        ride.d += ride.v * dt;
        break;
      }
    }
    ride.elapsed += dt;

    if (ride.d >= route.total) {
      ride.d = route.total;
      ride.finished = true;
      showBanner(`🏁 Finished! ${(route.total / 1000).toFixed(1)} km in ${formatTime(ride.elapsed)}`);
    }
    if (ride.elapsed >= ride.nextSampleAt) {
      ride.nextSampleAt += 1;
      recordSample(here, now);
      sendGrade(here.grade, rider);
    }
  }

  ride.view.update(ride.d, dt);
  ride.minimap.update(here.lat, here.lng);
  ride.profile.draw(ride.d);
  renderHud(here, trainerFresh, now);
  ride.raf = requestAnimationFrame(frame);
}

function recordSample(here, now) {
  ride.samples.push({
    time: new Date(),
    lat: here.lat,
    lng: here.lng,
    ele: here.ele,
    distance: ride.d,
    speed: ride.v,
    power: now - sensors.trainerAt < 3000 ? sensors.power : undefined,
    cadence: now - sensors.trainerAt < 3000 ? sensors.cadence : undefined,
    hr: now - sensors.hrAt < 5000 ? sensors.hr : undefined,
  });
}

/** Pushes the road grade to the trainer, scaled by the difficulty setting. */
function sendGrade(grade, rider) {
  if (settings.mode !== 'power' || !trainer.canSimulate || ride.resistance !== null) return;
  const g = Math.round(grade * (settings.difficulty / 100) * 1000) / 1000;
  if (g === ride.lastGradeSent && ride.elapsed - ride.lastGradeAt < 10) return;
  ride.lastGradeSent = g;
  ride.lastGradeAt = ride.elapsed;
  trainer.setSimulation({ grade: g, crr: rider.crr, cw: 0.5 * rider.rho * rider.cda });
}

function renderHud(here, trainerFresh, now) {
  $('hud-speed').textContent = (ride.v * 3.6).toFixed(1);
  $('hud-power').textContent = trainerFresh && sensors.power !== undefined ? Math.round(sensors.power) : '--';
  $('hud-cadence').textContent = trainerFresh && sensors.cadence !== undefined ? Math.round(sensors.cadence) : '--';
  const hrFresh = now - sensors.hrAt < 5000;
  $('hud-hr').textContent = hrFresh && sensors.hr ? Math.round(sensors.hr) : '--';
  $('hud-grade').textContent = (here.grade * 100).toFixed(1);
  $('hud-distance').textContent = (ride.d / 1000).toFixed(2);
  $('hud-time').textContent = formatTime(ride.elapsed);
}

function showStatus(text) {
  if (text) {
    showBanner(text);
    $('banner').dataset.kind = 'status';
  } else if ($('banner').dataset.kind === 'status') {
    $('banner').hidden = true;
  }
}

function showBanner(text) {
  $('banner').textContent = text;
  $('banner').dataset.kind = '';
  $('banner').hidden = false;
}

function setupRideControls() {
  // The profile and minimap sit above the controls, which wrap onto more rows on narrow screens.
  // The resistance bar fits between the HUD and the minimap.
  const measure = () => {
    $('ride').style.setProperty('--controls-h', `${$('controls').offsetHeight}px`);
    $('ride').style.setProperty('--hud-h', `${$('hud').offsetHeight}px`);
    $('ride').style.setProperty('--minimap-h', `${$('minimap').offsetHeight}px`);
  };
  const ro = new ResizeObserver(measure);
  for (const id of ['controls', 'hud', 'minimap']) ro.observe($(id));
  $('mode').addEventListener('change', () => {
    settings.mode = $('mode').value;
    saveSettings();
    if (ride) ride.replayT = sampleAt(ride.route, ride.d).time;
    updateModeControls();
  });

  const onSensor = (e) => {
    Object.assign(sensors, e.detail);
    if (e.detail.hr !== undefined) sensors.hrAt = performance.now();
  };
  trainer.addEventListener('data', (e) => {
    onSensor(e);
    sensors.trainerAt = performance.now();
  });
  hrm.addEventListener('data', onSensor);
  trainer.addEventListener('disconnected', () => {
    markConnected('connect-trainer', false, 'Connect trainer');
    updateResistBar();
  });
  hrm.addEventListener('disconnected', () => markConnected('connect-hr', false, 'Connect heart rate'));

  if (!bluetoothAvailable()) {
    for (const id of ['connect-trainer', 'connect-hr']) {
      $(id).disabled = true;
      $(id).title = 'This browser does not support Web Bluetooth. Use Chrome on Android or desktop Chrome / Edge.';
    }
  }
  $('connect-trainer').addEventListener('click', () => connectDevice(trainer, 'connect-trainer'));
  $('connect-hr').addEventListener('click', () => connectDevice(hrm, 'connect-hr'));

  setupResistBar();
  $('landscape').addEventListener('click', toggleLandscape);
  $('pause').addEventListener('click', togglePause);
  document.addEventListener('keydown', (e) => {
    if (!ride || $('ride').hidden || e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') {
      e.preventDefault();
      togglePause();
    }
  });
  $('export-tcx').addEventListener('click', () => ride && exportRideTCX(route.name, ride.samples));
  $('exit').addEventListener('click', () => {
    if (ride?.samples.length > 60 && !confirm('Exit the ride? Anything not exported will be lost.')) return;
    cancelAnimationFrame(ride.raf);
    ride.view.dispose?.();
    ride = null;
    updateResistBar();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    $('ride').hidden = true;
    $('setup').hidden = false;
  });
}

async function connectDevice(device, buttonId) {
  try {
    const name = await device.connect();
    const detail = device === trainer ? ` · ${trainer.protocol}${trainer.canSimulate ? '' : ' (power only, no grade)'}` : '';
    markConnected(buttonId, true, name + detail);
    updateResistBar();
  } catch (err) {
    if (err.name !== 'NotFoundError') alert(`Connection failed: ${err.message}`);
  }
}

function markConnected(id, on, label) {
  $(id).classList.toggle('connected', on);
  $(id).textContent = label;
}

// ---------- resistance bar ----------
// Dragging the bar puts the trainer on a fixed resistance; Auto goes back to the road grade.
// Speed is still worked out from power and the road grade either way.

let resTimer = 0;

function setupResistBar() {
  const set = (pct) => {
    $('res').value = Math.max(0, Math.min(100, pct));
    applyResistance();
  };
  $('res').addEventListener('input', () => applyResistance());
  $('res-up').addEventListener('click', () => set(Number($('res').value) + 1));
  $('res-down').addEventListener('click', () => set(Number($('res').value) - 1));
  $('res-auto').addEventListener('click', () => {
    if (!ride) return;
    ride.resistance = null;
    ride.lastGradeSent = null; // the next sample re-sends the grade, which leaves fixed resistance
    updateResistBar();
  });
  updateResistBar();
}

function applyResistance() {
  if (!ride) return;
  ride.resistance = Number($('res').value);
  updateResistBar();
  // Send the latest value once dragging pauses, so writes don't pile up.
  clearTimeout(resTimer);
  resTimer = setTimeout(() => ride?.resistance != null && trainer.setResistance(ride.resistance), 150);
}

function updateResistBar() {
  const manual = ride?.resistance != null;
  const enabled = trainer.canResist;
  for (const id of ['res', 'res-up', 'res-down', 'res-auto']) $(id).disabled = !enabled;
  $('resist').title = enabled ? 'Trainer resistance. Auto follows the road grade.' : 'Connect a trainer that supports resistance control';
  $('res-val').textContent = manual ? `${ride.resistance}%` : 'Auto';
  $('res-auto').classList.toggle('on', !manual);
}

// ---------- landscape ----------

async function toggleLandscape() {
  try {
    if (document.fullscreenElement) {
      screen.orientation?.unlock?.();
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      await screen.orientation?.lock?.('landscape').catch(() => {}); // not every browser allows the lock
    }
  } catch (err) {
    showBanner(`Fullscreen not available: ${err.message}`);
  }
}

document.addEventListener('fullscreenchange', () => {
  $('landscape').textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Landscape';
});

function togglePause() {
  if (!ride || ride.finished) return;
  ride.paused = !ride.paused;
  $('pause').textContent = ride.paused ? 'Resume' : 'Pause';
  if (ride.paused) showBanner('Paused (space to resume)');
  else $('banner').hidden = true;
}

function updateModeControls() {
  $('replay-speed-wrap').hidden = settings.mode !== 'replay';
  $('manual-speed-wrap').hidden = settings.mode !== 'manual';
}

function formatTime(sec) {
  const s = Math.floor(sec);
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

init();
