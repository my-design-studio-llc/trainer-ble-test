import test from 'node:test';
import assert from 'node:assert/strict';
import { buildingHeight, parseOsm } from '../ride/js/terrain/osm.js';

test('building height from tags, levels, or type', () => {
  assert.equal(buildingHeight({ building: 'yes', height: '21.5' }), 21.5);
  assert.equal(buildingHeight({ building: 'yes', 'building:levels': '3' }), 10);
  assert.equal(buildingHeight({ building: 'house' }), 6);
  assert.equal(buildingHeight({ building: 'yes' }), 7);
});

test('a named shelter that is also a building becomes a landmark', () => {
  const square = [[47.6752, -122.1925], [47.6752, -122.1923], [47.6754, -122.1923], [47.6754, -122.1925], [47.6752, -122.1925]];
  const geometry = square.map(([lat, lon]) => ({ lat, lon }));
  const { buildings, landmarks } = parseOsm({
    elements: [
      { type: 'way', id: 1, tags: { name: 'Central Station', amenity: 'shelter', building: 'yes' }, geometry },
      { type: 'node', id: 2, lat: 47.671, lon: -122.198, tags: { name: 'Caboose', historic: 'locomotive' } },
      { type: 'way', id: 1, tags: { name: 'Central Station', amenity: 'shelter', building: 'yes' }, geometry },
      { type: 'way', id: 3, tags: { building: 'house' }, geometry },
      { type: 'way', id: 4, tags: { name: 'Shell', brand: 'Shell', building: 'roof', amenity: 'fuel' }, geometry },
      { type: 'node', id: 5, lat: 47.7, lon: -122.2, tags: { name: 'Kenmore', amenity: 'shelter', shelter_type: 'public_transport' } },
    ],
  });
  assert.deepEqual(landmarks.map((l) => [l.name, l.kind]), [['Central Station', 'shelter'], ['Caboose', 'railcar']]);
  assert.ok(Math.abs(landmarks[0].lat - 47.6753) < 1e-6);
  assert.equal(buildings.length, 2); // the fuel canopy is still drawn, as a building
  assert.equal(buildings[0].height, 6);
  assert.equal(buildings[1].height, 4);
});

test('hotels are buildings, old rail stops are landmarks', () => {
  const geometry = [[0, 0], [0, 1e-4], [1e-4, 1e-4], [0, 0]].map(([a, b]) => ({ lat: 47.7 + a, lon: -122.2 + b }));
  const { buildings, landmarks } = parseOsm({
    elements: [
      { type: 'way', id: 1, tags: { name: 'Inn', building: 'hotel', tourism: 'hotel' }, geometry },
      { type: 'node', id: 2, lat: 47.75, lon: -122.25, tags: { name: 'Kenmore', historic: 'yes', railway: 'site' } },
    ],
  });
  assert.equal(buildings.length, 1);
  assert.deepEqual(landmarks.map((l) => l.name), ['Kenmore (former rail stop)']);
});

test('bridges and tunnels: tags, widths, and placement on or over the route', async () => {
  const { crossing, placeCrossings } = await import('../ride/js/terrain/osm.js');
  assert.equal(crossing({ highway: 'residential' }), null);
  assert.equal(crossing({ highway: 'motorway', bridge: 'no' }), null);
  const i405 = crossing({ highway: 'motorway', bridge: 'yes', ref: 'I 405', lanes: '4' });
  assert.deepEqual([i405.kind, i405.name, i405.width], ['bridge', 'I 405', 16.4]);
  assert.equal(crossing({ highway: 'cycleway', tunnel: 'yes' }).kind, 'tunnel');
  assert.equal(crossing({ highway: 'footway', bridge: 'yes', width: '0.5' }).width, 2.5);

  // A straight route due north, 5 m samples over ~500 m.
  const n = 101;
  const lat = Float64Array.from({ length: n }, (_, i) => 47.6 + (i * 5) / 111320);
  const lng = new Float64Array(n).fill(-122.2);
  const route = { n, lat, lng, step: 5 };
  const dLng = 1 / (111320 * Math.cos((47.6 * Math.PI) / 180));
  const along = { ...crossing({ highway: 'cycleway', bridge: 'yes' }), line: [[lat[40], -122.2], [lat[50], -122.2]] };
  const over = { ...i405, line: [[lat[70], -122.2 - 40 * dLng], [lat[70], -122.2 + 40 * dLng]] };
  const { spans, over: hits } = placeCrossings(route, [along, over]);
  assert.equal(spans.length, 1);
  assert.ok(Math.abs(spans[0].i0 - 40) <= 1 && Math.abs(spans[0].i1 - 50) <= 1, JSON.stringify(spans[0]));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].crossing.name, 'I 405');
  assert.ok(Math.abs(hits[0].i + hits[0].t - 70) < 0.5);
});
