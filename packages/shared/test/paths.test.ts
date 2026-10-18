import { describe, expect, it } from 'vitest';
import { describePath, effectiveStaleMs, expandCatalog, PATH_TEMPLATES, RATE_PERIOD_MS, UNKNOWN_PATH_STALE_MS } from '../src/index.js';

describe('rate classes', () => {
  it('follows the spec table', () => {
    const cls = (p: string) => describePath(p).rateClass;
    expect(cls('navigation.speedOverGround')).toBe('fast');
    expect(cls('environment.wind.angleApparent')).toBe('fast');
    expect(cls('navigation.position')).toBe('fast');
    expect(cls('environment.depth.belowKeel')).toBe('medium');
    expect(cls('propulsion.port.revolutions')).toBe('medium');
    expect(cls('electrical.batteries.house.current')).toBe('medium');
    expect(cls('steering.autopilot.state')).toBe('medium');
    expect(cls('environment.outside.pressure')).toBe('slow');
    expect(cls('electrical.batteries.house.voltage')).toBe('slow');
    expect(cls('propulsion.starboard.fuel.rate')).toBe('slow');
    expect(cls('tanks.fuel.port.currentLevel')).toBe('verySlow');
    expect(cls('propulsion.port.runTime')).toBe('verySlow');
    expect(cls('propulsion.port.state')).toBe('verySlow');
  });

  it('periods are 1, 5, 30 and 60 s', () => {
    expect(RATE_PERIOD_MS).toEqual({ fast: 1000, medium: 5000, slow: 30_000, verySlow: 60_000 });
  });

  it('every catalog path has a rate class', () => {
    for (const d of [...PATH_TEMPLATES, ...expandCatalog()]) expect(RATE_PERIOD_MS[d.rateClass], d.path).toBeGreaterThan(0);
  });
});

describe('effective stale timeout', () => {
  it('is the larger of the catalog value and three periods', () => {
    expect(effectiveStaleMs(describePath('navigation.speedOverGround'))).toBe(5_000); // max(5, 3)
    expect(effectiveStaleMs(describePath('environment.depth.belowKeel'))).toBe(15_000); // max(10, 15)
    expect(effectiveStaleMs(describePath('electrical.batteries.house.voltage'))).toBe(90_000); // max(30, 90)
    expect(effectiveStaleMs(describePath('tanks.fuel.port.currentLevel'))).toBe(300_000); // max(300, 180)
    expect(effectiveStaleMs(describePath('navigation.anchor.position'))).toBeNull();
  });

  it('uncatalogued paths stay at 30 s', () => {
    expect(effectiveStaleMs(describePath('environment.inside.humidity', 0.6))).toBe(UNKNOWN_PATH_STALE_MS);
  });
});
