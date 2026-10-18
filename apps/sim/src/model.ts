// A deterministic catamaran: wind, sailing and motoring physics, engines,
// batteries, tanks and depth, stepped one simulated second at a time. Same
// seed and start time, same numbers, so tests can rely on it.

import { bearingRad, destination, distanceM, normalizeRad, signedRad, type LatLon } from '@watchkeeper/shared';

export type Phase = 'anchored' | 'motoring' | 'sailing';

export interface PhaseSpec {
  phase: Phase;
  /** Duration; Infinity for a scenario that never changes. */
  minutes: number;
  /** True course in degrees while under way. */
  courseDeg?: number;
}

/**
 * Named scenarios. `mixed`, the dev default, repeats every 6 hours: at anchor,
 * motor out, a long sail, motor in, anchor again wherever the boat is.
 */
export const SCENARIOS: Record<string, PhaseSpec[]> = {
  mixed: [
    { phase: 'anchored', minutes: 20 },
    { phase: 'motoring', minutes: 25, courseDeg: 100 },
    { phase: 'sailing', minutes: 240, courseDeg: 142 },
    { phase: 'motoring', minutes: 20, courseDeg: 142 },
    { phase: 'anchored', minutes: 55 },
  ],
  sailing: [{ phase: 'sailing', minutes: Infinity, courseDeg: 142 }],
  motoring: [{ phase: 'motoring', minutes: Infinity, courseDeg: 100 }],
  anchored: [{ phase: 'anchored', minutes: Infinity }],
};

/** An override value that makes the path stop publishing: a dead sensor. */
export const DEAD = 'dead';
export type Override = number | string | boolean | null | Record<string, unknown>;

export interface ModelOptions {
  /** Simulated start time, epoch ms. */
  start?: number;
  seed?: number;
  scenario?: string | PhaseSpec[];
  position?: LatLon;
}

/** Instance ids, matching the app's placeholder defaults. */
export const ENGINES = ['port', 'starboard'] as const;
type EngineId = (typeof ENGINES)[number];

const KN = 1852 / 3600;
const DEG = Math.PI / 180;
const C = 273.15;
const GAL = 0.003785411784;
const LITRE = 0.001;

/** Fictional but plausible numbers for a 45 ft cruising catamaran. */
export const BOAT = {
  houseAh: 600,
  fuelTankL: 300,
  waterTankL: 400,
  cruiseRpm: 2200,
  cruiseKn: 7.2,
  /** Fuel burn per engine at cruise rpm, gal/h. */
  cruiseBurnGph: 0.95,
  variationDeg: -10.6,
  current: { setDeg: 30, driftKn: 0.4 },
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface EngineState {
  rpmHz: number;
  coolantK: number;
  runTimeS: number;
  fuelRate: number;
}

export class BoatModel {
  /** Simulated time, epoch ms. */
  t: number;
  readonly start: number;
  private phases: PhaseSpec[];
  private phaseIndex = 0;
  private phaseStart: number;
  private readonly seeds: number[];

  pos: LatLon;
  anchor: LatLon | null = null;
  /** Where the boat last anchored; depth shelves away from it. */
  private lastAnchor: LatLon;
  heading = 142 * DEG;
  stw = 0;
  sog = 0;
  cog = 0;
  tws = 0;
  twd = 0;
  readonly engines: Record<EngineId, EngineState>;
  soc = 0.87;
  houseCurrent = 0;
  solarCurrent = 0;
  fuelL: Record<EngineId, number> = { port: 212, starboard: 205 };
  waterL = 310;
  private pressurePa = 101_200;
  /** Path overrides: a fixed value, or DEAD to stop publishing the path. */
  readonly overrides = new Map<string, Override>();

  constructor(opts: ModelOptions = {}) {
    this.start = opts.start ?? Date.now();
    this.t = this.start;
    this.phaseStart = this.start;
    this.phases = typeof opts.scenario === 'object' ? opts.scenario : (SCENARIOS[opts.scenario ?? 'mixed'] ?? SCENARIOS.mixed!);
    const rand = mulberry32(opts.seed ?? 1);
    this.seeds = Array.from({ length: 64 }, () => rand() * 2 * Math.PI);
    this.pos = opts.position ?? { latitude: 36.93, longitude: -76.02 };
    this.lastAnchor = this.pos;
    const water = this.waterTempK();
    this.engines = {
      port: { rpmHz: 0, coolantK: water, runTimeS: 4_494_960, fuelRate: 0 },
      starboard: { rpmHz: 0, coolantK: water, runTimeS: 4_480_200, fuelRate: 0 },
    };
    this.enterPhase(this.start);
    this.computeWind();
  }

  get phase(): PhaseSpec {
    return this.phases[this.phaseIndex]!;
  }

  setScenario(scenario: string | PhaseSpec[]): void {
    this.phases = typeof scenario === 'object' ? scenario : (SCENARIOS[scenario] ?? this.phases);
    this.phaseIndex = 0;
    this.enterPhase(this.t);
  }

  /** Smooth noise in [-1, 1]: three incommensurate sines with seeded phases. */
  private noise(k: number, periodS: number): number {
    const s = (this.t - this.start) / 1000;
    const p = this.seeds;
    const w = (2 * Math.PI) / periodS;
    return (Math.sin(w * s + p[k % 64]!) + 0.5 * Math.sin(2.7 * w * s + p[(k + 21) % 64]!) + 0.25 * Math.sin(6.1 * w * s + p[(k + 42) % 64]!)) / 1.75;
  }

  private enterPhase(at: number): void {
    this.phaseStart = at;
    if (this.phase.phase === 'anchored') {
      this.anchor = this.pos;
      this.lastAnchor = this.pos;
    } else {
      this.anchor = null;
    }
  }

  /** Step whole simulated seconds up to `t`. */
  advanceTo(t: number): void {
    while (this.t + 1000 <= t) this.step();
  }

  step(): void {
    const dt = 1;
    this.t += 1000;
    const current = this.phase;
    if (Number.isFinite(current.minutes) && this.t - this.phaseStart >= current.minutes * 60_000) {
      this.phaseIndex = (this.phaseIndex + 1) % this.phases.length;
      this.enterPhase(this.t);
    }
    this.computeWind();
    const phase = this.phase;
    const course = (phase.courseDeg ?? 142) * DEG;

    // Engines
    const running = phase.phase === 'motoring';
    for (const id of ENGINES) {
      const e = this.engines[id];
      const target = running ? (BOAT.cruiseRpm - (id === 'starboard' ? 30 : 0) + 15 * this.noise(id === 'port' ? 7 : 8, 25)) / 60 : 0;
      e.rpmHz += (target - e.rpmHz) * Math.min(1, dt / (running ? 6 : 2));
      if (e.rpmHz < 0.5 && !running) e.rpmHz = 0;
      const coolantTarget = running ? C + 82 + (id === 'port' ? 0.6 : -0.6) + 0.4 * this.noise(9, 120) : this.waterTempK();
      e.coolantK += (coolantTarget - e.coolantK) * (dt / (running ? 240 : 900));
      if (e.rpmHz > 0) e.runTimeS += dt;
      const load = e.rpmHz / (BOAT.cruiseRpm / 60);
      e.fuelRate = e.rpmHz > 0 ? ((BOAT.cruiseBurnGph * GAL) / 3600) * load * load : 0;
      this.fuelL[id] = Math.max(0, this.fuelL[id] - (e.fuelRate * dt) / LITRE);
    }

    // Heading and speed through the water
    if (phase.phase === 'sailing') {
      this.heading = normalizeRad(course + 2 * DEG * this.noise(4, 30));
      const twa = Math.abs(signedRad(this.twd - this.heading));
      const polar = twa < 30 * DEG ? 0.1 : 0.62 * Math.sin(Math.min(twa, 110 * DEG));
      this.approachStw(Math.min(11 * KN, this.tws * polar), 20, dt);
    } else if (phase.phase === 'motoring') {
      this.heading = normalizeRad(course + 1.5 * DEG * this.noise(4, 30));
      const load = (this.engines.port.rpmHz + this.engines.starboard.rpmHz) / 2 / (BOAT.cruiseRpm / 60);
      this.approachStw(BOAT.cruiseKn * KN * load, 15, dt);
    } else {
      // Lying to the anchor: bow into the wind, swinging on the rode.
      this.heading = normalizeRad(this.twd + 8 * DEG * this.noise(5, 240));
      this.approachStw(0, 5, dt);
    }

    // Over the ground
    if (this.anchor) {
      const swing = normalizeRad(this.twd + Math.PI + 25 * DEG * this.noise(6, 600));
      const next = destination(this.anchor, swing, 25 + 3 * this.noise(10, 300));
      this.sog = distanceM(this.pos, next) / dt;
      if (this.sog > 0.001) this.cog = bearingRad(this.pos, next);
      this.pos = next;
    } else {
      const set = (BOAT.current.setDeg + 5 * this.noise(11, 3600)) * DEG;
      const drift = BOAT.current.driftKn * KN;
      const ve = this.stw * Math.sin(this.heading) + drift * Math.sin(set);
      const vn = this.stw * Math.cos(this.heading) + drift * Math.cos(set);
      this.sog = Math.hypot(ve, vn);
      this.cog = normalizeRad(Math.atan2(ve, vn));
      this.pos = destination(this.pos, this.cog, this.sog * dt);
    }

    // Electrical
    this.solarCurrent = Math.max(0, 32 * this.sunElevationSin() * (0.85 + 0.15 * this.noise(12, 900)));
    const loads = 6 + (phase.phase === 'anchored' ? 0 : 2.5) + 1.5 * this.noise(13, 300);
    const alt = ENGINES.reduce((sum, id) => sum + (this.engines[id].rpmHz > 10 ? 35 * (1 - this.soc ** 6) : 0), 0);
    this.houseCurrent = this.solarCurrent + alt - loads;
    this.soc = Math.min(1, Math.max(0.15, this.soc + (this.houseCurrent * dt) / 3600 / BOAT.houseAh));
    this.waterL = Math.max(0, this.waterL - 0.0015 * dt);

    // Weather: the barometer falls while on passage and recovers at anchor.
    this.pressurePa += (phase.phase === 'sailing' ? -80 : phase.phase === 'anchored' ? 30 : 0) * (dt / 3600);
  }

  private approachStw(target: number, tauS: number, dt: number): void {
    this.stw += (target - this.stw) * Math.min(1, dt / tauS);
    if (this.stw < 0.01) this.stw = 0;
  }

  private computeWind(): void {
    this.twd = normalizeRad((266 + 12 * this.noise(1, 3600)) * DEG);
    this.tws = Math.max(2 * KN, (14 + 3 * this.noise(2, 1800) + 1.2 * this.noise(3, 45)) * KN);
  }

  private waterTempK(): number {
    return C + 26.2 + 0.2 * Math.sin((this.t - this.start) / 3_600_000);
  }

  /** Rough sun elevation (equinox declination), enough to shape solar output. */
  private sunElevationSin(): number {
    const d = new Date(this.t);
    const solarHour = d.getUTCHours() + d.getUTCMinutes() / 60 + this.pos.longitude / 15;
    const h = (solarHour - 12) * 15 * DEG;
    return Math.max(0, Math.cos(this.pos.latitude * DEG) * Math.cos(h));
  }

  private depthM(): number | null {
    if (this.anchor) return 6 + 0.6 * Math.sin((2 * Math.PI * (this.t - this.start)) / (12.42 * 3_600_000)) + 0.05 * this.noise(14, 20);
    // The bottom shelves away from the anchorage; past the sounder's range there is no reading.
    const nm = distanceM(this.lastAnchor, this.pos) / 1852;
    const d = 6 + nm * 12 + 0.5 * this.noise(14, 20);
    return d > 180 ? null : d;
  }

  /** Every path's current SI value, with overrides applied and dead sensors left out. */
  values(): Record<string, unknown> {
    const phase = this.phase.phase;
    const twa = signedRad(this.twd - this.heading);
    const tws = this.tws;
    const stw = this.stw;
    const aws = Math.sqrt(tws * tws + stw * stw + 2 * tws * stw * Math.cos(twa));
    const awa = Math.atan2(tws * Math.sin(twa), tws * Math.cos(twa) + stw);
    const voltage = 12.9 + 0.5 * this.soc + 0.004 * this.houseCurrent;
    const v: Record<string, unknown> = {
      'navigation.datetime': new Date(this.t).toISOString(),
      'navigation.position': { latitude: this.pos.latitude, longitude: this.pos.longitude },
      'navigation.speedOverGround': this.sog,
      'navigation.speedThroughWater': this.stw,
      'navigation.courseOverGroundTrue': this.cog,
      'navigation.headingTrue': this.heading,
      'navigation.headingMagnetic': normalizeRad(this.heading - BOAT.variationDeg * DEG),
      'environment.wind.angleApparent': awa,
      'environment.wind.speedApparent': aws,
      'environment.wind.angleTrueWater': twa,
      'environment.wind.speedTrue': tws,
      'environment.wind.directionTrue': this.twd,
      'environment.outside.pressure': this.pressurePa + 60 * this.noise(15, 7200),
      'environment.outside.temperature': C + 24 + 2.5 * Math.sin(((new Date(this.t).getUTCHours() - 19) / 24) * 2 * Math.PI),
      'environment.water.temperature': this.waterTempK(),
      'environment.depth.belowKeel': this.depthM(),
      'electrical.batteries.house.voltage': voltage,
      'electrical.batteries.house.current': this.houseCurrent,
      'electrical.batteries.house.capacity.stateOfCharge': this.soc,
      'electrical.solar.main.current': this.solarCurrent,
      'tanks.fuel.port.currentLevel': this.fuelL.port / BOAT.fuelTankL,
      'tanks.fuel.port.capacity': BOAT.fuelTankL * LITRE,
      'tanks.fuel.starboard.currentLevel': this.fuelL.starboard / BOAT.fuelTankL,
      'tanks.fuel.starboard.capacity': BOAT.fuelTankL * LITRE,
      'tanks.freshWater.main.currentLevel': this.waterL / BOAT.waterTankL,
      'tanks.freshWater.main.capacity': BOAT.waterTankL * LITRE,
      'steering.autopilot.state': phase === 'sailing' ? 'wind' : phase === 'motoring' ? 'auto' : 'standby',
    };
    for (const id of ENGINES) {
      const e = this.engines[id];
      const on = e.rpmHz > 0;
      v[`propulsion.${id}.revolutions`] = e.rpmHz;
      v[`propulsion.${id}.state`] = on ? 'started' : 'stopped';
      v[`propulsion.${id}.temperature`] = e.coolantK;
      v[`propulsion.${id}.oilPressure`] = on ? 310_000 * Math.pow(e.rpmHz / (BOAT.cruiseRpm / 60), 0.3) : 0;
      v[`propulsion.${id}.runTime`] = Math.floor(e.runTimeS);
      v[`propulsion.${id}.fuel.rate`] = e.fuelRate;
      v[`electrical.alternators.${id}.voltage`] = on ? 14.1 - (id === 'starboard' ? 0.1 : 0) : voltage;
    }
    if (this.anchor) v['navigation.anchor.position'] = { latitude: this.anchor.latitude, longitude: this.anchor.longitude };
    for (const [path, o] of this.overrides) {
      if (o === DEAD) delete v[path];
      else v[path] = o;
    }
    return v;
  }
}
