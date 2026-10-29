import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cadenceFromCrank, encodeSimulation, parseCyclingPower, parseHeartRate, parseIndoorBikeData } from '../ride/js/ble-protocol.js';

const dv = (bytes) => new DataView(Uint8Array.from(bytes).buffer);

test('Indoor Bike Data: speed, cadence, power', () => {
  // flags 0x0044 = cadence + power; speed present (bit 0 clear)
  // speed 3000 (30.00 km/h), cadence 180 (90 rpm), power 250
  const m = parseIndoorBikeData(dv([0x44, 0x00, 0xb8, 0x0b, 0xb4, 0x00, 0xfa, 0x00]));
  assert.ok(Math.abs(m.speed - 30 / 3.6) < 1e-9);
  assert.equal(m.cadence, 90);
  assert.equal(m.power, 250);
});

test('Indoor Bike Data: skips optional fields before power', () => {
  // flags: avg speed(0x02) + cadence(0x04) + distance(0x10) + resistance(0x20) + power(0x40) + HR(0x200)
  const m = parseIndoorBikeData(
    dv([0x76, 0x02, 0x10, 0x27, 0x00, 0x00, 0xa0, 0x00, 0x01, 0x02, 0x03, 0x05, 0x00, 0x2c, 0x01, 0x8c]),
  );
  assert.equal(m.speed, 100 / 3.6);
  assert.equal(m.cadence, 80);
  assert.equal(m.power, 300);
  assert.equal(m.hr, 140);
});

test('Cycling Power with crank data and cadence rollover', () => {
  // flags 0x0020 crank data; power 210; revs 65535; time 64512
  const a = parseCyclingPower(dv([0x20, 0x00, 0xd2, 0x00, 0xff, 0xff, 0x00, 0xfc]));
  assert.equal(a.power, 210);
  // one revolution, 0.666 s later (682 ticks), wrapping both counters
  const b = { crankRevs: 0, crankTime: (64512 + 682) % 65536 };
  assert.ok(Math.abs(cadenceFromCrank(a, b) - 90.1) < 0.2);
  assert.equal(cadenceFromCrank(undefined, b), undefined);
});

test('Heart rate 8 and 16 bit', () => {
  assert.equal(parseHeartRate(dv([0x00, 150])), 150);
  assert.equal(parseHeartRate(dv([0x01, 0x2c, 0x01])), 300);
});

test('Simulation parameters encoding', () => {
  const b = encodeSimulation({ grade: 0.055, crr: 0.004, cw: 0.196 });
  assert.deepEqual([...b], [0x11, 0, 0, 0x26, 0x02, 40, 20]); // 550 = 0x0226
  const down = encodeSimulation({ grade: -0.1 });
  assert.equal(new DataView(down.buffer).getInt16(3, true), -1000);
});

import { encodeFecTrackResistance, encodeFecWindResistance, parseFecMessage } from '../ride/js/ble-protocol.js';

const xor = (bytes) => bytes.slice(0, -1).reduce((x, b) => x ^ b, 0);

test('FE-C track resistance frame', () => {
  const f = [...encodeFecTrackResistance(0.05, 0.004)];
  // 5 % -> (5 + 200) / 0.01 = 20500 = 0x5014; crr 0.004 / 5e-5 = 80
  assert.deepEqual(f.slice(0, 12), [0xa4, 0x09, 0x4f, 0x05, 0x33, 0xff, 0xff, 0xff, 0xff, 0x14, 0x50, 80]);
  assert.equal(f[12], xor(f));
  const down = [...encodeFecTrackResistance(-0.08)];
  assert.equal(down[9] | (down[10] << 8), 19200);
});

test('FE-C wind resistance frame', () => {
  const f = [...encodeFecWindResistance(0.2)];
  assert.deepEqual(f.slice(4, 12), [0x32, 0xff, 0xff, 0xff, 0xff, 20, 127, 100]);
  assert.equal(f[12], xor(f));
});

test('FE-C trainer and general data pages', () => {
  // page 0x19: cadence 88, power 0x113 = 275
  const trainer = parseFecMessage(dv([0xa4, 0x09, 0x4e, 0x05, 0x19, 0x01, 88, 0x00, 0x00, 0x13, 0x31, 0x00, 0x00]));
  assert.deepEqual(trainer, { cadence: 88, power: 275 });
  // page 0x10: speed 8333 mm/s
  const general = parseFecMessage(dv([0xa4, 0x09, 0x4e, 0x05, 0x10, 0x19, 0, 0, 0x8d, 0x20, 0xff, 0x00, 0x00]));
  assert.ok(Math.abs(general.speed - 8.333) < 1e-9);
  assert.deepEqual(parseFecMessage(dv([0x00, 1, 2])), {});
  // invalid power marker 0xFFF is dropped
  assert.deepEqual(parseFecMessage(dv([0xa4, 0x09, 0x4e, 0x05, 0x19, 0x01, 0xff, 0, 0, 0xff, 0x0f, 0, 0])), {});
});

import { encodeFecBasicResistance, encodeResistance } from '../ride/js/ble-protocol.js';

test('FE-C basic resistance is page 0x30 in 0.5 % steps with a valid checksum', () => {
  const m = encodeFecBasicResistance(40);
  assert.deepEqual([...m.slice(0, 12)], [0xa4, 0x09, 0x4f, 0x05, 0x30, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 80]);
  assert.equal(m[12], [...m.slice(0, 12)].reduce((x, b) => x ^ b, 0));
  assert.equal(encodeFecBasicResistance(150)[11], 200);
});

test('FTMS resistance maps percent onto the supported range', () => {
  assert.deepEqual([...encodeResistance(50)], [0x04, 50]);
  assert.deepEqual([...encodeResistance(50, [0, 1000])], [0x04, 500 & 0xff, 500 >> 8]);
  assert.deepEqual([...encodeResistance(120, [0, 200])], [0x04, 200]);
});
