// Web Bluetooth connections to a smart trainer and a heart rate strap.
// Trainer protocols, in order of preference:
//   1. FTMS (the standard smart trainer protocol)
//   2. FE-C over BLE (trainers without FTMS, or whose FTMS control is unavailable)
//   3. Cycling Power (power/cadence only, no slope simulation)
// Emits "data" events whose detail holds any of { power, cadence, speed, hr }.

import {
  UUID,
  FTMS_OP,
  FEC_BLE,
  normUuid,
  parseIndoorBikeData,
  parseCyclingPower,
  cadenceFromCrank,
  parseHeartRate,
  parseFecMessage,
  encodeSimulation,
  encodeResistance,
  encodeFecBasicResistance,
  encodeFecTrackResistance,
  encodeFecWindResistance,
} from './ble-protocol.js';

export const bluetoothAvailable = () => typeof navigator !== 'undefined' && 'bluetooth' in navigator;

// Some Web Bluetooth implementations (e.g. Bluefy on iOS) only have the older writeValue().
const writeWith = (ch, bytes) => (ch.writeValueWithResponse ? ch.writeValueWithResponse(bytes) : ch.writeValue(bytes));
const writeWithout = (ch, bytes) => (ch.writeValueWithoutResponse ? ch.writeValueWithoutResponse(bytes) : ch.writeValue(bytes));

// Web Bluetooth on iOS (Bluefy) can't match service filters: its scan list comes up empty. List
// every device there instead; the trainer still shows up by name.
const isIOS = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const requestDevice = (services) =>
  navigator.bluetooth.requestDevice(
    isIOS()
      ? { acceptAllDevices: true, optionalServices: services }
      : { filters: services.map((s) => ({ services: [s] })), optionalServices: services },
  );

// Looked up by listing and comparing normalized UUIDs, since Bluefy spells them its own way.
const findService = async (server, uuid) =>
  (await server.getPrimaryServices()).find((s) => normUuid(s.uuid) === uuid) ?? null;
const getService = async (server, uuid) => {
  const svc = await findService(server, uuid);
  if (!svc) throw new Error(`service ${uuid} not found`);
  return svc;
};
const getCharacteristic = async (svc, uuid) => {
  const ch = (await svc.getCharacteristics()).find((c) => normUuid(c.uuid) === uuid);
  if (!ch) throw new Error(`characteristic ${uuid} not found`);
  return ch;
};

export class Trainer extends EventTarget {
  device = null;
  protocol = null; // 'FTMS' | 'FE-C' | 'Power'
  #control = null; // (params) => Promise, present when slope simulation works
  #resist = null; // (pct) => Promise, present when fixed resistance works
  #queue = Promise.resolve();
  #lastCrank = null;
  #fecWindSent = false;
  #fecDataAt = -Infinity;

  get connected() {
    return Boolean(this.device?.gatt?.connected);
  }

  get canSimulate() {
    return Boolean(this.#control);
  }

  get canResist() {
    return Boolean(this.#resist);
  }

  async connect() {
    this.device = await requestDevice([UUID.FTMS, UUID.CYCLING_POWER, FEC_BLE.SERVICE]);
    this.device.addEventListener('gattserverdisconnected', () => {
      this.#control = null;
      this.#resist = null;
      this.dispatchEvent(new Event('disconnected'));
    });
    const server = await this.device.gatt.connect();
    const [ftms, fec] = await Promise.all([
      findService(server, UUID.FTMS).catch(() => null),
      findService(server, FEC_BLE.SERVICE).catch(() => null),
    ]);

    if (ftms) {
      const data = await getCharacteristic(ftms, UUID.INDOOR_BIKE_DATA);
      data.addEventListener('characteristicvaluechanged', (e) => this.#emit(parseIndoorBikeData(e.target.value)));
      await data.startNotifications();
      this.protocol = 'FTMS';
      this.#control = await this.#setupFtmsControl(ftms);
      if (!this.#control && fec) {
        this.#control = await this.#setupFec(fec, { data: false });
        if (this.#control) this.protocol = 'FTMS + FE-C';
      }
    } else if (fec) {
      this.#control = await this.#setupFec(fec, { data: true });
      this.protocol = 'FE-C';
      // Cycling Power fills in power and cadence while FE-C sends no trainer data.
      await this.#subscribeCyclingPower(server, () => performance.now() - this.#fecDataAt > 3000).catch(() => {});
    } else {
      await this.#subscribeCyclingPower(server, () => true);
      this.protocol = 'Power';
    }
    return this.device.name ?? 'Trainer';
  }

  async #subscribeCyclingPower(server, shouldEmit) {
    const cps = await getService(server, UUID.CYCLING_POWER);
    const meas = await getCharacteristic(cps, UUID.CYCLING_POWER_MEASUREMENT);
    meas.addEventListener('characteristicvaluechanged', (e) => {
      const m = parseCyclingPower(e.target.value);
      const cadence = cadenceFromCrank(this.#lastCrank, m);
      if (m.crankRevs !== undefined) this.#lastCrank = m;
      if (shouldEmit()) this.#emit({ power: m.power, ...(cadence !== undefined && { cadence }) });
    });
    await meas.startNotifications();
  }

  async #setupFtmsControl(ftms) {
    try {
      const cp = await getCharacteristic(ftms, UUID.FTMS_CONTROL_POINT);
      await cp.startNotifications(); // responses arrive as indications
      await writeWith(cp, Uint8Array.of(FTMS_OP.REQUEST_CONTROL));
      await writeWith(cp, Uint8Array.of(FTMS_OP.START_OR_RESUME));
      let range = [0, 100];
      try {
        const r = await (await getCharacteristic(ftms, UUID.SUPPORTED_RESISTANCE_RANGE)).readValue();
        range = [r.getInt16(0, true), r.getInt16(2, true)];
      } catch {
        /* range not published: assume 0-100 */
      }
      this.#resist = (pct) => writeWith(cp, encodeResistance(pct, range));
      return (params) => writeWith(cp, encodeSimulation(params));
    } catch (err) {
      console.warn('FTMS control unavailable', err);
      return null;
    }
  }

  async #setupFec(fec, { data }) {
    try {
      if (data) {
        const rx = await getCharacteristic(fec, FEC_BLE.RX);
        rx.addEventListener('characteristicvaluechanged', (e) => {
          const m = parseFecMessage(e.target.value);
          if (m.power !== undefined) this.#fecDataAt = performance.now();
          if (Object.keys(m).length) this.#emit(m);
        });
        await rx.startNotifications();
      }
      const tx = await getCharacteristic(fec, FEC_BLE.TX);
      const write = (bytes) =>
        tx.properties.writeWithoutResponse ? writeWithout(tx, bytes) : writeWith(tx, bytes);
      this.#resist = (pct) => write(encodeFecBasicResistance(pct));
      return async ({ grade, crr, cw }) => {
        if (!this.#fecWindSent) {
          await write(encodeFecWindResistance(cw));
          this.#fecWindSent = true;
        }
        await write(encodeFecTrackResistance(grade, crr));
      };
    } catch (err) {
      console.warn('FE-C unavailable', err);
      return null;
    }
  }

  /** Sends a simulated grade. Writes are serialized because GATT allows one operation at a time. */
  setSimulation(params) {
    return this.#enqueue(this.#control, params, 'setSimulation');
  }

  /** Switches the trainer to a fixed resistance, 0-100 %. Sending a grade switches back. */
  setResistance(pct) {
    return this.#enqueue(this.#resist, pct, 'setResistance');
  }

  #enqueue(fn, arg, name) {
    if (!fn) return Promise.resolve();
    this.#queue = this.#queue.then(() => fn(arg)).catch((err) => console.warn(`${name} failed`, err));
    return this.#queue;
  }

  disconnect() {
    this.device?.gatt?.disconnect();
  }

  #emit(detail) {
    this.dispatchEvent(new CustomEvent('data', { detail }));
  }
}

export class HeartRateMonitor extends EventTarget {
  device = null;

  async connect() {
    this.device = await requestDevice([UUID.HEART_RATE]);
    this.device.addEventListener('gattserverdisconnected', () => this.dispatchEvent(new Event('disconnected')));
    const server = await this.device.gatt.connect();
    const svc = await getService(server, UUID.HEART_RATE);
    const ch = await getCharacteristic(svc, UUID.HEART_RATE_MEASUREMENT);
    ch.addEventListener('characteristicvaluechanged', (e) =>
      this.dispatchEvent(new CustomEvent('data', { detail: { hr: parseHeartRate(e.target.value) } })),
    );
    await ch.startNotifications();
    return this.device.name ?? 'Heart rate';
  }

  disconnect() {
    this.device?.gatt?.disconnect();
  }
}
