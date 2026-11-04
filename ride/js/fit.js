// The ride as a FIT activity file. Unlike TCX, FIT can say the ride was virtual (sub-sport
// "virtual_activity"); Strava then tags it Indoor Cycling and shows it as a virtual ride, rather
// than an outdoor ride on the real roads. Plain function, no DOM (unit tested in Node).

const FIT_EPOCH = Date.UTC(1989, 11, 31) / 1000;
const SPORT_CYCLING = 2;
const SUB_SPORT_VIRTUAL = 58;
const MANUFACTURER_DEVELOPMENT = 255;

// Base types: [id, bytes, invalid value]
const T = {
  enum: [0x00, 1, 0xff],
  uint8: [0x02, 1, 0xff],
  uint16: [0x84, 2, 0xffff],
  sint32: [0x85, 4, 0x7fffffff],
  uint32: [0x86, 4, 0xffffffff],
  uint32z: [0x8c, 4, 0],
};

// Global message number and fields [number, type, name] per message, from the FIT profile.
const MESSAGES = {
  file_id: [0, [[0, 'enum', 'type'], [1, 'uint16', 'manufacturer'], [2, 'uint16', 'product'], [3, 'uint32z', 'serial'], [4, 'uint32', 'time_created']]],
  event: [21, [[253, 'uint32', 'timestamp'], [0, 'enum', 'event'], [1, 'enum', 'event_type']]],
  record: [20, [
    [253, 'uint32', 'timestamp'], [0, 'sint32', 'lat'], [1, 'sint32', 'lng'], [2, 'uint16', 'altitude'],
    [3, 'uint8', 'hr'], [4, 'uint8', 'cadence'], [5, 'uint32', 'distance'], [6, 'uint16', 'speed'], [7, 'uint16', 'power'],
  ]],
  lap: [19, [
    [253, 'uint32', 'timestamp'], [0, 'enum', 'event'], [1, 'enum', 'event_type'], [2, 'uint32', 'start_time'],
    [3, 'sint32', 'start_lat'], [4, 'sint32', 'start_lng'], [5, 'sint32', 'end_lat'], [6, 'sint32', 'end_lng'],
    [7, 'uint32', 'elapsed'], [8, 'uint32', 'timer'], [9, 'uint32', 'distance'], [11, 'uint16', 'calories'],
    [13, 'uint16', 'avg_speed'], [14, 'uint16', 'max_speed'], [15, 'uint8', 'avg_hr'], [16, 'uint8', 'max_hr'],
    [17, 'uint8', 'avg_cadence'], [18, 'uint8', 'max_cadence'], [19, 'uint16', 'avg_power'], [20, 'uint16', 'max_power'],
    [21, 'uint16', 'ascent'], [25, 'enum', 'sport'], [39, 'enum', 'sub_sport'],
  ]],
  session: [18, [
    [253, 'uint32', 'timestamp'], [0, 'enum', 'event'], [1, 'enum', 'event_type'], [2, 'uint32', 'start_time'],
    [3, 'sint32', 'start_lat'], [4, 'sint32', 'start_lng'], [5, 'enum', 'sport'], [6, 'enum', 'sub_sport'],
    [7, 'uint32', 'elapsed'], [8, 'uint32', 'timer'], [9, 'uint32', 'distance'], [11, 'uint16', 'calories'],
    [14, 'uint16', 'avg_speed'], [15, 'uint16', 'max_speed'], [16, 'uint8', 'avg_hr'], [17, 'uint8', 'max_hr'],
    [18, 'uint8', 'avg_cadence'], [19, 'uint8', 'max_cadence'], [20, 'uint16', 'avg_power'], [21, 'uint16', 'max_power'],
    [22, 'uint16', 'ascent'], [25, 'uint16', 'first_lap'], [26, 'uint16', 'num_laps'],
  ]],
  activity: [34, [
    [253, 'uint32', 'timestamp'], [0, 'uint32', 'timer'], [1, 'uint16', 'num_sessions'], [2, 'enum', 'type'],
    [3, 'enum', 'event'], [4, 'enum', 'event_type'], [5, 'uint32', 'local_timestamp'],
  ]],
};

const CRC_TABLE = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];

export function crc16(bytes, crc = 0) {
  for (const b of bytes) {
    let t = CRC_TABLE[crc & 0xf];
    crc = ((crc >> 4) & 0x0fff) ^ t ^ CRC_TABLE[b & 0xf];
    t = CRC_TABLE[crc & 0xf];
    crc = ((crc >> 4) & 0x0fff) ^ t ^ CRC_TABLE[(b >> 4) & 0xf];
  }
  return crc;
}

const fitTime = (date) => Math.round(date.getTime() / 1000 - FIT_EPOCH);
const semicircles = (deg) => Math.round((deg * 2 ** 31) / 180);

class Writer {
  bytes = [];
  local = new Map(); // message name -> local message type

  write(name, values) {
    const [global, fields] = MESSAGES[name];
    if (!this.local.has(name)) {
      const type = this.local.size; // fewer than 16 message kinds, so each keeps its definition
      this.local.set(name, type);
      this.bytes.push(0x40 | type, 0, 0, global & 0xff, global >> 8, fields.length);
      for (const [num, t] of fields) this.bytes.push(num, T[t][1], T[t][0]);
    }
    this.bytes.push(this.local.get(name));
    const view = new DataView(new ArrayBuffer(8));
    for (const [, t, key] of fields) {
      const [, size, invalid] = T[t];
      const v = values[key];
      const n = v === undefined || !Number.isFinite(v) ? invalid : Math.round(v);
      if (t === 'sint32') view.setInt32(0, n, true);
      else if (size === 4) view.setUint32(0, Math.min(Math.max(n, 0), 0xffffffff), true);
      else if (size === 2) view.setUint16(0, Math.min(Math.max(n, 0), 0xffff), true);
      else view.setUint8(0, Math.min(Math.max(n, 0), 0xff));
      for (let i = 0; i < size; i++) this.bytes.push(view.getUint8(i));
    }
  }
}

const finite = (samples, key) => samples.map((s) => s[key]).filter((x) => x !== undefined && Number.isFinite(x));
const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : undefined);
const max = (v) => (v.length ? Math.max(...v) : undefined);

/**
 * @param samples {{ time: Date, lat, lng, ele, distance, speed, power?, cadence?, hr? }[]}
 * @returns {Uint8Array} a FIT activity file: one lap, one session, sub-sport virtual
 */
export function rideFIT(samples) {
  if (!samples.length) throw new Error('no samples');
  const first = samples[0];
  const last = samples[samples.length - 1];
  const start = fitTime(first.time);
  const end = fitTime(last.time);
  const elapsed = (last.time - first.time) / 1000;

  // Work in kJ; with ~24 % gross efficiency, kcal burned is about the same number.
  let joules = 0;
  let ascent = 0;
  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i].time - samples[i - 1].time) / 1000;
    if (samples[i].power !== undefined && dt > 0 && dt < 10) joules += samples[i].power * dt;
    ascent += Math.max(0, samples[i].ele - samples[i - 1].ele);
  }
  const speeds = finite(samples, 'speed');
  const totals = {
    elapsed: elapsed * 1000,
    timer: elapsed * 1000,
    distance: last.distance * 100,
    calories: joules ? joules / 1000 : undefined,
    avg_speed: elapsed > 0 ? (last.distance / elapsed) * 1000 : undefined,
    max_speed: speeds.length ? max(speeds) * 1000 : undefined,
    avg_hr: mean(finite(samples, 'hr')),
    max_hr: max(finite(samples, 'hr')),
    avg_cadence: mean(finite(samples, 'cadence').filter((c) => c > 0)), // pedalling only
    max_cadence: max(finite(samples, 'cadence')),
    avg_power: mean(finite(samples, 'power')),
    max_power: max(finite(samples, 'power')),
    ascent,
  };

  const w = new Writer();
  w.write('file_id', { type: 4, manufacturer: MANUFACTURER_DEVELOPMENT, product: 1, serial: 1, time_created: start });
  w.write('event', { timestamp: start, event: 0, event_type: 0 }); // timer start
  for (const s of samples) {
    w.write('record', {
      timestamp: fitTime(s.time),
      lat: semicircles(s.lat),
      lng: semicircles(s.lng),
      altitude: (s.ele + 500) * 5,
      hr: s.hr,
      cadence: s.cadence,
      distance: s.distance * 100,
      speed: s.speed * 1000,
      power: s.power,
    });
  }
  w.write('event', { timestamp: end, event: 0, event_type: 4 }); // timer stop all
  const startPos = { start_lat: semicircles(first.lat), start_lng: semicircles(first.lng) };
  w.write('lap', {
    timestamp: end, event: 9, event_type: 1, start_time: start, ...startPos,
    end_lat: semicircles(last.lat), end_lng: semicircles(last.lng), ...totals,
    sport: SPORT_CYCLING, sub_sport: SUB_SPORT_VIRTUAL,
  });
  w.write('session', {
    timestamp: end, event: 8, event_type: 1, start_time: start, ...startPos, ...totals,
    sport: SPORT_CYCLING, sub_sport: SUB_SPORT_VIRTUAL, first_lap: 0, num_laps: 1,
  });
  const offset = -first.time.getTimezoneOffset() * 60;
  w.write('activity', { timestamp: end, timer: elapsed * 1000, num_sessions: 1, type: 0, event: 26, event_type: 1, local_timestamp: end + offset });

  const data = w.bytes;
  const header = new DataView(new ArrayBuffer(14));
  header.setUint8(0, 14);
  header.setUint8(1, 0x20); // protocol 2.0
  header.setUint16(2, 2132, true); // profile 21.32
  header.setUint32(4, data.length, true);
  for (let i = 0; i < 4; i++) header.setUint8(8 + i, '.FIT'.charCodeAt(i));
  const head = new Uint8Array(header.buffer);
  header.setUint16(12, crc16(head.subarray(0, 12)), true);
  const out = new Uint8Array(14 + data.length + 2);
  out.set(head, 0);
  out.set(data, 14);
  const crc = crc16(out.subarray(0, 14 + data.length));
  out[out.length - 2] = crc & 0xff;
  out[out.length - 1] = crc >> 8;
  return out;
}
