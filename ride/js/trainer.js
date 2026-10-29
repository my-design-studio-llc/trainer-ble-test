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
    this.device = await navigator.bluetooth.requestDevice({
      filters: [
        { services: [UUID.FTMS] },
        { services: [UUID.CYCLING_POWER] },
        { services: [FEC_BLE.SERVICE] },
      ],
      optionalServices: [UUID.FTMS, UUID.CYCLING_POWER, FEC_BLE.SERVICE],
    });
    this.device.addEventListener('gattserverdisconnected', () => {
      this.#control = null;
      this.#resist = null;
      this.dispatchEvent(new Event('disconnected'));
    });
    const server = await this.device.gatt.connect();
    const [ftms, fec] = await Promise.all([
      server.getPrimaryService(UUID.FTMS).catch(() => null),
      server.getPrimaryService(FEC_BLE.SERVICE).catch(() => null),
    ]);

    if (ftms) {
      const data = await ftms.getCharacteristic(UUID.INDOOR_BIKE_DATA);
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
    const cps = await server.getPrimaryService(UUID.CYCLING_POWER);
    const meas = await cps.getCharacteristic(UUID.CYCLING_POWER_MEASUREMENT);
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
      const cp = await ftms.getCharacteristic(UUID.FTMS_CONTROL_POINT);
      await cp.startNotifications(); // responses arrive as indications
      await cp.writeValueWithResponse(Uint8Array.of(FTMS_OP.REQUEST_CONTROL));
      await cp.writeValueWithResponse(Uint8Array.of(FTMS_OP.START_OR_RESUME));
      let range = [0, 100];
      try {
        const r = await (await ftms.getCharacteristic(UUID.SUPPORTED_RESISTANCE_RANGE)).readValue();
        range = [r.getInt16(0, true), r.getInt16(2, true)];
      } catch {
        /* range not published: assume 0-100 */
      }
      this.#resist = (pct) => cp.writeValueWithResponse(encodeResistance(pct, range));
      return (params) => cp.writeValueWithResponse(encodeSimulation(params));
    } catch (err) {
      console.warn('FTMS control unavailable', err);
      return null;
    }
  }

  async #setupFec(fec, { data }) {
    try {
      if (data) {
        const rx = await fec.getCharacteristic(FEC_BLE.RX);
        rx.addEventListener('characteristicvaluechanged', (e) => {
          const m = parseFecMessage(e.target.value);
          if (m.power !== undefined) this.#fecDataAt = performance.now();
          if (Object.keys(m).length) this.#emit(m);
        });
        await rx.startNotifications();
      }
      const tx = await fec.getCharacteristic(FEC_BLE.TX);
      const write = (bytes) =>
        tx.properties.writeWithoutResponse ? tx.writeValueWithoutResponse(bytes) : tx.writeValueWithResponse(bytes);
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
    this.device = await navigator.bluetooth.requestDevice({ filters: [{ services: [UUID.HEART_RATE] }] });
    this.device.addEventListener('gattserverdisconnected', () => this.dispatchEvent(new Event('disconnected')));
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService(UUID.HEART_RATE);
    const ch = await svc.getCharacteristic(UUID.HEART_RATE_MEASUREMENT);
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
