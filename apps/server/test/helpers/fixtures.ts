// Replay fixtures: recorded (or generated) Signal K deltas with timestamps,
// one JSON object per line: {"t": <epoch ms>, "delta": <Signal K delta>}.

import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

export interface Delta {
  context: string;
  updates: { timestamp: string; values: { path: string; value: unknown }[] }[];
}

export interface FixtureLine {
  t: number;
  delta: Delta;
}

/** Start of every generated fixture: 2026-10-18 12:00:00 UTC, on the hour. */
export const T0 = Date.UTC(2026, 9, 18, 12, 0, 0);

const KN = 1852 / 3600;
const DEG = Math.PI / 180;

/** Numeric paths the generator publishes (position is extra, recorded as lat + lon). */
export const NUMERIC_PATHS = [
  'navigation.speedOverGround',
  'navigation.speedThroughWater',
  'navigation.courseOverGroundTrue',
  'navigation.headingTrue',
  'environment.wind.angleApparent',
  'environment.wind.speedApparent',
  'environment.wind.speedTrue',
  'environment.wind.directionTrue',
  'environment.outside.pressure',
  'environment.water.temperature',
  'environment.depth.belowKeel',
  'propulsion.port.revolutions',
  'propulsion.starboard.revolutions',
  'propulsion.port.runTime',
  'electrical.batteries.house.voltage',
  'electrical.batteries.house.capacity.stateOfCharge',
] as const;

export const STRING_PATHS = ['propulsion.port.state', 'steering.autopilot.state'] as const;

/** sample_1s rows written per second when every path is publishing. */
export const RECORDED_COLUMNS = NUMERIC_PATHS.length + 2;

export interface GenerateOptions {
  start?: number;
  seconds: number;
  /** Paths that stop publishing after `deadAfterS` seconds (a dead sensor). */
  dead?: string[];
  deadAfterS?: number;
}

/**
 * Deterministic passage: 7 kn on 146°T, steady breeze, both engines at
 * cruise. One delta per second carrying every path.
 */
export function* generate(opts: GenerateOptions): Generator<FixtureLine> {
  const start = opts.start ?? T0;
  const dead = new Set(opts.dead ?? []);
  let lat = 32.9;
  let lon = -70.5;
  for (let i = 0; i < opts.seconds; i++) {
    const t = start + i * 1000;
    const wobble = Math.sin(i / 30);
    const sog = (7 + 0.3 * wobble) * KN;
    const cog = 146 * DEG;
    lat += (sog * Math.cos(cog)) / 111_120;
    lon += (sog * Math.sin(cog)) / (111_120 * Math.cos(lat * DEG));
    const values: Record<string, unknown> = {
      'navigation.position': { latitude: lat, longitude: lon },
      'navigation.speedOverGround': sog,
      'navigation.speedThroughWater': sog - 0.15,
      'navigation.courseOverGroundTrue': cog,
      'navigation.headingTrue': cog - 4 * DEG,
      'environment.wind.angleApparent': 38 * DEG + 0.05 * wobble,
      'environment.wind.speedApparent': (18.4 + wobble) * KN,
      'environment.wind.speedTrue': (14.2 + wobble) * KN,
      'environment.wind.directionTrue': 266 * DEG,
      'environment.outside.pressure': 101_200 - i * 0.02,
      'environment.water.temperature': 299.3,
      'environment.depth.belowKeel': 40 + 5 * wobble,
      'propulsion.port.revolutions': 36.3,
      'propulsion.starboard.revolutions': 35.8,
      'propulsion.port.runTime': 4_494_960 + i,
      'electrical.batteries.house.voltage': 13.2,
      'electrical.batteries.house.capacity.stateOfCharge': 0.87,
      'propulsion.port.state': 'started',
      'steering.autopilot.state': 'wind',
    };
    const pathValues = Object.entries(values)
      .filter(([path]) => !(dead.has(path) && i >= (opts.deadAfterS ?? 0)))
      .map(([path, value]) => ({ path, value }));
    yield {
      t,
      delta: { context: 'vessels.self', updates: [{ timestamp: new Date(t).toISOString(), values: pathValues }] },
    };
  }
}

export function writeFixture(file: string, lines: Iterable<FixtureLine>): void {
  const out: string[] = [];
  for (const l of lines) out.push(JSON.stringify(l));
  writeFileSync(file, out.join('\n') + '\n');
}

export async function* readFixture(file: string): AsyncGenerator<FixtureLine> {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) yield JSON.parse(line) as FixtureLine;
  }
}
