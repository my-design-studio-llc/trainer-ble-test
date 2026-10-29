import { test } from 'node:test';
import assert from 'node:assert/strict';
import { steadySpeed, stepSpeed } from '../ride/js/physics.js';

const kmh = (v) => v * 3.6;

test('steady speeds are realistic', () => {
  const flat = kmh(steadySpeed(200, 0));
  assert.ok(flat > 30 && flat < 36, `flat ${flat}`);
  const climb = kmh(steadySpeed(250, 0.08));
  assert.ok(climb > 9 && climb < 13, `climb ${climb}`);
  const descent = kmh(steadySpeed(0, -0.06));
  assert.ok(descent > 45 && descent < 65, `descent ${descent}`);
});

test('stepSpeed converges to the steady speed', () => {
  let v = 0;
  for (let i = 0; i < 600; i++) v = stepSpeed(v, 200, 0.02, 0.1);
  assert.ok(Math.abs(v - steadySpeed(200, 0.02)) < 0.05);
});

test('no power on a climb stops you without rolling backwards', () => {
  let v = 5;
  for (let i = 0; i < 300; i++) v = stepSpeed(v, 0, 0.1, 0.1);
  assert.equal(v, 0);
});
