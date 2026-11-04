import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc16, rideFIT } from '../ride/js/fit.js';

const samples = Array.from({ length: 30 }, (_, i) => ({
  time: new Date(Date.UTC(2026, 10, 1, 18, 0, i)),
  lat: 47.6 + i * 1e-4,
  lng: -122.3,
  ele: 10 + i * 0.1,
  distance: i * 7,
  speed: 7,
  power: 200,
  cadence: 85,
  hr: 140,
}));

test('FIT file: header, size and CRCs', () => {
  const f = rideFIT(samples);
  const v = new DataView(f.buffer);
  assert.equal(f[0], 14);
  assert.equal(String.fromCharCode(...f.subarray(8, 12)), '.FIT');
  assert.equal(v.getUint32(4, true), f.length - 16);
  assert.equal(v.getUint16(12, true), crc16(f.subarray(0, 12)));
  assert.equal(crc16(f), 0); // a file followed by its CRC checks to zero
});

test('FIT file: session is cycling / virtual_activity', () => {
  const f = rideFIT(samples);
  // The session definition: global message 18, then its data carries sport 2 and sub-sport 58.
  const i = f.findIndex((b, k) => (b & 0x40) && f[k + 3] === 18 && f[k + 4] === 0 && f[k + 2] === 0 && f[k + 1] === 0);
  assert.ok(i > 0);
  assert.ok(f.subarray(i).includes(58));
});
