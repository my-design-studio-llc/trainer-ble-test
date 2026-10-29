// Bluetooth GATT payload encoding/decoding for smart trainers and HR straps.
// Pure functions, so they can be unit tested without a browser.

export const UUID = {
  FTMS: 0x1826,
  INDOOR_BIKE_DATA: 0x2ad2,
  FTMS_CONTROL_POINT: 0x2ad9,
  SUPPORTED_RESISTANCE_RANGE: 0x2ad6,
  CYCLING_POWER: 0x1818,
  CYCLING_POWER_MEASUREMENT: 0x2a63,
  HEART_RATE: 0x180d,
  HEART_RATE_MEASUREMENT: 0x2a37,
};

export const FTMS_OP = {
  REQUEST_CONTROL: 0x00,
  SET_RESISTANCE: 0x04,
  START_OR_RESUME: 0x07,
  SET_SIMULATION: 0x11,
  RESPONSE: 0x80,
};

/** FTMS Indoor Bike Data (0x2AD2). Returns speed in m/s, cadence in rpm, power in W. */
export function parseIndoorBikeData(dv) {
  const flags = dv.getUint16(0, true);
  let o = 2;
  const out = {};
  // Bit 0 is "More Data": when it is 0, instantaneous speed is present.
  if (!(flags & 0x0001)) {
    out.speed = dv.getUint16(o, true) / 100 / 3.6;
    o += 2;
  }
  if (flags & 0x0002) o += 2; // average speed
  if (flags & 0x0004) {
    out.cadence = dv.getUint16(o, true) / 2;
    o += 2;
  }
  if (flags & 0x0008) o += 2; // average cadence
  if (flags & 0x0010) o += 3; // total distance
  if (flags & 0x0020) o += 2; // resistance level
  if (flags & 0x0040) {
    out.power = dv.getInt16(o, true);
    o += 2;
  }
  if (flags & 0x0080) o += 2; // average power
  if (flags & 0x0100) o += 5; // expended energy
  if (flags & 0x0200) {
    out.hr = dv.getUint8(o);
    o += 1;
  }
  return out;
}

/** Cycling Power Measurement (0x2A63). Crank data is returned raw for cadence derivation. */
export function parseCyclingPower(dv) {
  const flags = dv.getUint16(0, true);
  const out = { power: dv.getInt16(2, true) };
  let o = 4;
  if (flags & 0x0001) o += 1; // pedal power balance
  if (flags & 0x0004) o += 2; // accumulated torque
  if (flags & 0x0010) o += 6; // wheel revolution data
  if (flags & 0x0020) {
    out.crankRevs = dv.getUint16(o, true);
    out.crankTime = dv.getUint16(o + 2, true); // 1/1024 s
  }
  return out;
}

/** Cadence (rpm) from two crank revolution samples, handling 16-bit rollover. */
export function cadenceFromCrank(prev, next) {
  if (prev?.crankRevs === undefined || next?.crankRevs === undefined) return undefined;
  const revs = (next.crankRevs - prev.crankRevs + 0x10000) % 0x10000;
  const ticks = (next.crankTime - prev.crankTime + 0x10000) % 0x10000;
  if (ticks === 0) return undefined;
  return (revs / (ticks / 1024)) * 60;
}

/** Heart Rate Measurement (0x2A37). */
export function parseHeartRate(dv) {
  const flags = dv.getUint8(0);
  return flags & 0x01 ? dv.getUint16(1, true) : dv.getUint8(1);
}

/**
 * FTMS "Set Indoor Bike Simulation Parameters".
 * @param grade rise/run, e.g. 0.05 for 5 %
 * @param cw wind resistance coefficient kg/m (0.5·ρ·CdA)
 */
export function encodeSimulation({ grade, windSpeed = 0, crr = 0.004, cw = 0.51 }) {
  const buf = new DataView(new ArrayBuffer(7));
  buf.setUint8(0, FTMS_OP.SET_SIMULATION);
  buf.setInt16(1, clampInt(windSpeed * 1000, -32768, 32767), true);
  buf.setInt16(3, clampInt(grade * 10000, -32768, 32767), true);
  buf.setUint8(5, clampInt(crr * 10000, 0, 255));
  buf.setUint8(6, clampInt(cw * 100, 0, 255));
  return new Uint8Array(buf.buffer);
}

/**
 * FTMS "Set Target Resistance Level": `pct` 0-100 mapped onto the trainer's supported
 * range (0.1 units). Older trainers take one byte, newer ones a 16-bit level.
 */
export function encodeResistance(pct, [lo, hi] = [0, 100]) {
  const q = clampInt(lo + ((hi - lo) * pct) / 100, lo, hi);
  return hi <= 255 ? Uint8Array.of(FTMS_OP.SET_RESISTANCE, q) : Uint8Array.of(FTMS_OP.SET_RESISTANCE, q & 0xff, (q >> 8) & 0xff);
}

function clampInt(v, lo, hi) {
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

// ---- FE-C over BLE ----
// Some trainers tunnel ANT+ FE-C messages over a Nordic UART style service.
// Used when a trainer has no FTMS (e.g. older firmware) or its FTMS control is unavailable.

export const FEC_BLE = {
  SERVICE: '6e40fec1-b5a3-f393-e0a9-e50e24dcca9e',
  RX: '6e40fec2-b5a3-f393-e0a9-e50e24dcca9e', // trainer -> app (notify)
  TX: '6e40fec3-b5a3-f393-e0a9-e50e24dcca9e', // app -> trainer (write)
};

const ANT_SYNC = 0xa4;
const ANT_BROADCAST = 0x4e;
const ANT_ACKNOWLEDGED = 0x4f;
const FEC_CHANNEL = 0x05;

/** Decodes an ANT FE-C message: page 0x10 (general data) or 0x19 (trainer data). */
export function parseFecMessage(dv) {
  if (dv.byteLength < 12 || dv.getUint8(0) !== ANT_SYNC) return {};
  const msgId = dv.getUint8(2);
  if (msgId !== ANT_BROADCAST && msgId !== ANT_ACKNOWLEDGED) return {};
  const p = 4; // payload starts after sync, length, message id, channel
  switch (dv.getUint8(p)) {
    case 0x10:
      return { speed: dv.getUint16(p + 4, true) / 1000 };
    case 0x19: {
      const out = {};
      const power = dv.getUint8(p + 5) | ((dv.getUint8(p + 6) & 0x0f) << 8);
      if (power !== 0xfff) out.power = power;
      if (dv.getUint8(p + 2) !== 0xff) out.cadence = dv.getUint8(p + 2);
      return out;
    }
    default:
      return {};
  }
}

/** FE-C page 0x30 Basic Resistance: `pct` 0-100 % of the trainer's range, 0.5 % steps. */
export function encodeFecBasicResistance(pct) {
  return fecFrame([0x30, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, clampInt(pct * 2, 0, 200)]);
}

/** FE-C page 0x33 Track Resistance: grade in rise/run, rolling resistance coefficient. */
export function encodeFecTrackResistance(grade, crr = 0.004) {
  const g = clampInt((grade * 100 + 200) * 100, 0, 40000);
  return fecFrame([0x33, 0xff, 0xff, 0xff, 0xff, g & 0xff, g >> 8, clampInt(crr / 0.00005, 0, 255)]);
}

/** FE-C page 0x32 Wind Resistance: cw kg/m, no wind, no drafting. */
export function encodeFecWindResistance(cw = 0.51) {
  return fecFrame([0x32, 0xff, 0xff, 0xff, 0xff, clampInt(cw * 100, 0, 186), 127, 100]);
}

function fecFrame(payload) {
  const msg = [ANT_SYNC, 0x09, ANT_ACKNOWLEDGED, FEC_CHANNEL, ...payload];
  msg.push(msg.reduce((x, b) => x ^ b, 0));
  return Uint8Array.from(msg);
}
