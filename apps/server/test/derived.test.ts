import { beforeEach, describe, expect, it } from 'vitest';
import { destination, KNOT_MPS, NM_M, US_GALLON_M3 } from '@watchkeeper/shared';
import { iso } from '../src/clock.js';
import { setSetting } from '../src/db/index.js';
import { DERIVED, DerivedEngine } from '../src/derived/engine.js';
import { buildDelta, type OutboundValue } from '../src/signalk/outbound.js';
import { makeApp } from './helpers/app.js';

const DEG = Math.PI / 180;
const GPH = US_GALLON_M3 / 3600;

describe('derived values', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let sent: OutboundValue[][];
  let engine: DerivedEngine;
  const set = (values: Record<string, unknown>) => {
    for (const [p, v] of Object.entries(values)) t.store.update(p, v, t.clock.now());
  };

  beforeEach(async () => {
    t = await makeApp();
    sent = [];
    engine = new DerivedEngine(t.db, t.store, t.clock, (v) => {
      buildDelta(v, iso(0));
      sent.push(v);
    });
  });

  it('total fuel rate and fuel range', () => {
    set({
      'propulsion.port.fuel.rate': 1.0 * GPH,
      'propulsion.starboard.fuel.rate': 0.8 * GPH,
      'tanks.fuel.port.currentLevel': 0.5,
      'tanks.fuel.port.capacity': 0.3,
      'tanks.fuel.starboard.currentVolume': 0.1,
      'navigation.speedOverGround': 6 * KNOT_MPS,
    });
    const out = engine.tick();
    // 1.0 + 0.8 gal/h
    expect(out[DERIVED.totalFuelRate]! / GPH).toBeCloseTo(1.8, 9);
    // 0.15 + 0.10 m³ = 66.04 gal; at 1.8 gal/h that's 36.69 h; at 6 kn, 220.14 nm.
    expect(out[DERIVED.fuelRange]! / NM_M).toBeCloseTo(220.14, 1);
  });

  it('no fuel range while sailing (no burn) or without SOG', () => {
    set({ 'propulsion.port.fuel.rate': 0, 'tanks.fuel.port.currentLevel': 0.5, 'tanks.fuel.port.capacity': 0.3, 'navigation.speedOverGround': 3 });
    expect(engine.tick()[DERIVED.fuelRange]).toBeNull();
    t.clock.advance(60_000); // SOG goes stale; the fuel rate is fresh again below
    set({ 'propulsion.port.fuel.rate': GPH });
    expect(engine.tick()[DERIVED.fuelRange]).toBeNull();
  });

  it('net current and time to empty, only while discharging', () => {
    setSetting(t.db, 'derived', { houseCapacityAh: 400, floorSoc: 0.5, confirmed: true });
    set({ 'electrical.batteries.house.current': -20, 'electrical.batteries.house.capacity.stateOfCharge': 0.8 });
    let out = engine.tick();
    expect(out[DERIVED.netCurrent]).toBe(-20);
    // (0.8 − 0.5) × 400 Ah ÷ 20 A = 6 h
    expect(out[DERIVED.timeToEmpty]).toBeCloseTo(6 * 3600, 6);
    set({ 'electrical.batteries.house.current': 5 });
    out = engine.tick();
    expect(out[DERIVED.timeToEmpty]).toBeNull();
  });

  it('set and drift from COG/SOG minus heading/STW', () => {
    // Steering 090° at 6 kn through the water; 1 kn of current setting 045°.
    const ve = 6 + Math.sin(45 * DEG);
    const vn = 0 + Math.cos(45 * DEG);
    set({
      'navigation.headingTrue': 90 * DEG,
      'navigation.speedThroughWater': 6 * KNOT_MPS,
      'navigation.courseOverGroundTrue': Math.atan2(ve, vn),
      'navigation.speedOverGround': Math.hypot(ve, vn) * KNOT_MPS,
    });
    const out = engine.tick();
    expect(out[DERIVED.setTrue]! / DEG).toBeCloseTo(45, 6);
    expect(out[DERIVED.drift]! / KNOT_MPS).toBeCloseTo(1, 6);
  });

  it('distance run ignores jumps over 1 nm in 1 s and survives a restart', () => {
    let p = { latitude: 36.9, longitude: -76.1 };
    const step = (metres: number) => {
      t.clock.advance(1000);
      p = destination(p, 0, metres);
      set({ 'navigation.position': p });
      return engine.tick()[DERIVED.distanceRun]!;
    };
    set({ 'navigation.position': p });
    engine.tick();
    for (let i = 0; i < 10; i++) step(3);
    expect(step(2 * NM_M)).toBeCloseTo(30, 6); // the glitch adds nothing
    for (let i = 0; i < 10; i++) step(3);
    expect(engine.tick()[DERIVED.distanceRun]).toBeCloseTo(60, 6);
    engine.stop();
    const again = new DerivedEngine(t.db, t.store, t.clock);
    expect(again.tick()[DERIVED.distanceRun]).toBeCloseTo(60, 6);
  });

  it('pressure tendency over 3 h from recorded history', () => {
    const now = t.clock.now();
    set({ 'environment.outside.pressure': 101_200 });
    expect(engine.tick()[DERIVED.pressureTendency]).toBeNull(); // no history yet
    t.db
      .prepare('INSERT INTO sample_1m (path, ts, avg, min, max) VALUES (?, ?, ?, ?, ?)')
      .run('environment.outside.pressure', now - 3 * 3600_000 + 60_000, 101_440, 0, 0);
    t.clock.advance(30_000);
    set({ 'environment.outside.pressure': 101_200 });
    expect(engine.tick()[DERIVED.pressureTendency]).toBeCloseTo(-240, 6); // falling 2.4 hPa
  });

  it('24-hour run from the recorded distance run', () => {
    setSetting(t.db, 'distanceRun', { m: 50_000, last: null });
    const insert = t.db.prepare('INSERT INTO sample_1m (path, ts, avg, min, max) VALUES (?, ?, ?, ?, ?)');
    insert.run(DERIVED.distanceRun, t.clock.now() - 23 * 3600_000, 20_000, 0, 0);
    insert.run(DERIVED.distanceRun, t.clock.now() - 30 * 3600_000, 1_000, 0, 0);
    const fresh = new DerivedEngine(t.db, t.store, t.clock);
    expect(fresh.tick()[DERIVED.run24h]).toBe(30_000);
  });

  it('stores computed values like any path and publishes only allowlisted paths', () => {
    set({ 'electrical.batteries.house.current': -3 });
    engine.tick();
    expect(t.store.read(DERIVED.netCurrent).value).toBe(-3);
    expect(t.store.read(DERIVED.fuelRange).updatedAt).toBeNull();
    expect(sent.flat().every((v) => v.path.startsWith('dataHub.'))).toBe(true);
  });
});
