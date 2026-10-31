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
