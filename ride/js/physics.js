// Converts trainer power into virtual road speed.

export const DEFAULT_RIDER = {
  mass: 82, // rider + bike, kg
  cda: 0.32, // m², hoods position
  crr: 0.004,
  rho: 1.225, // air density, kg/m³
  efficiency: 0.975, // drivetrain
};

const G = 9.80665;
const MAX_SPEED = 30; // m/s

/** Resisting force (N) at speed v (m/s) on a slope (rise/run). */
export function resistiveForce(v, grade, p = DEFAULT_RIDER) {
  const θ = Math.atan(grade);
  return p.mass * G * (p.crr * Math.cos(θ) + Math.sin(θ)) + 0.5 * p.rho * p.cda * v * Math.abs(v);
}

/** Integrates speed forward by dt seconds given rider power (W). */
export function stepSpeed(v, power, grade, dt, p = DEFAULT_RIDER) {
  const steps = Math.max(1, Math.ceil(dt / 0.05));
  const h = dt / steps;
  for (let s = 0; s < steps; s++) {
    // Below 1 m/s cap the drive force so standing starts don't divide by ~0.
    const drive = (power * p.efficiency) / Math.max(v, 1);
    let a = (drive - resistiveForce(v, grade, p)) / p.mass;
    // Rolling resistance can't push you backwards on the flat.
    if (v <= 0 && a < 0 && grade >= 0) a = 0;
    v = Math.min(MAX_SPEED, Math.max(0, v + a * h));
  }
  return v;
}

/** Steady-state speed for a constant power, by bisection. */
export function steadySpeed(power, grade, p = DEFAULT_RIDER) {
  let lo = 0;
  let hi = MAX_SPEED;
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2;
    if (power * p.efficiency > resistiveForce(mid, grade, p) * mid) lo = mid;
    else hi = mid;
  }
  return lo;
}
