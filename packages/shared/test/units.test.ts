import { describe, expect, it } from 'vitest';
import {
  CURRENT,
  DEFAULT_UNIT_PREFS,
  DEPTH,
  DISTANCE,
  ENGINE_PRESSURE,
  FLOW,
  HOURS,
  PERCENT,
  PRESSURE,
  RPM,
  SPEED,
  TEMPERATURE,
  VOLTAGE,
  VOLUME,
  converterFor,
  degToRad,
  formatCoordinate,
  formatValue,
  parseCoordinate,
  radToDeg360,
  sidedToWindAngle,
  windAngleToSided,
  type Converter,
} from '../src/index.js';

// [name, converter, SI value, expected display value]
const KNOWN: [string, Converter, number, number][] = [
  ['kn', SPEED.kn, 1852 / 3600, 1],
  ['km/h', SPEED['km/h'], 10, 36],
  ['m/s', SPEED['m/s'], 3.2, 3.2],
  ['ft', DEPTH.ft, 0.3048, 1],
  ['m', DEPTH.m, 12.5, 12.5],
  ['fathoms', DEPTH.fathoms, 1.8288, 1],
  ['nm', DISTANCE.nm, 1852, 1],
  ['km', DISTANCE.km, 2500, 2.5],
  ['°F', TEMPERATURE['°F'], 373.15, 212],
  ['°F freezing', TEMPERATURE['°F'], 273.15, 32],
  ['°C', TEMPERATURE['°C'], 300, 26.85],
  ['hPa', PRESSURE.hPa, 101_325, 1013.25],
  ['inHg', PRESSURE.inHg, 3386.389 * 29.92, 29.92],
  ['mbar', PRESSURE.mbar, 101_200, 1012],
  ['psi', ENGINE_PRESSURE.psi, 6894.757293168, 1],
  ['bar', ENGINE_PRESSURE.bar, 250_000, 2.5],
  ['kPa', ENGINE_PRESSURE.kPa, 310_000, 310],
  ['gal', VOLUME.gal, 0.003785411784, 1],
  ['L', VOLUME.L, 0.2, 200],
  ['gal/h', FLOW['gal/h'], 0.003785411784 / 3600, 1],
  ['L/h', FLOW['L/h'], 1 / 3_600_000, 1],
  ['rpm', RPM, 36.3, 2178],
  ['hours', HOURS, 4_494_960, 1248.6],
  ['percent', PERCENT, 0.87, 87],
  ['voltage', VOLTAGE, 13.2, 13.2],
  ['current', CURRENT, -6.4, -6.4],
];

describe('linear converters', () => {
  it.each(KNOWN)('%s: SI -> display -> SI', (_name, c, si, display) => {
    expect(c.toDisplay(si)).toBeCloseTo(display, 2);
    expect(c.toSI(display)).toBeCloseTo(si, 6);
    expect(c.toSI(c.toDisplay(si))).toBeCloseTo(si, 9);
  });
});

describe('angles', () => {
  it('radians to 0..360 degrees and back', () => {
    expect(radToDeg360(Math.PI)).toBeCloseTo(180);
    expect(radToDeg360(-Math.PI / 2)).toBeCloseTo(270);
    expect(radToDeg360(2 * Math.PI)).toBeCloseTo(0);
    expect(degToRad(90)).toBeCloseTo(Math.PI / 2);
    for (const deg of [0, 1, 45, 146, 266, 359.5]) {
      expect(radToDeg360(degToRad(deg))).toBeCloseTo(deg, 9);
    }
  });

  it('heading unit follows the true/magnetic preference', () => {
    expect(converterFor('angle', DEFAULT_UNIT_PREFS).unit).toBe('°T');
    expect(converterFor('angle', { ...DEFAULT_UNIT_PREFS, heading: 'magnetic' }).unit).toBe('°M');
  });

  it('signed wind angle to sided and back', () => {
    expect(windAngleToSided(degToRad(38))).toEqual({ deg: expect.closeTo(38, 9), side: 'STBD' });
    expect(windAngleToSided(degToRad(-120))).toEqual({ deg: expect.closeTo(120, 9), side: 'PORT' });
    expect(windAngleToSided(0)).toEqual({ deg: 0, side: null });
    expect(windAngleToSided(Math.PI).side).toBeNull();
    for (const deg of [-179, -90, -38, 0, 52, 150]) {
      const { deg: d, side } = windAngleToSided(degToRad(deg));
      expect(sidedToWindAngle(d, side)).toBeCloseTo(degToRad(deg), 9);
    }
  });
});

describe('positions', () => {
  const lat = 32 + 41.2 / 60; // 32°41.200′N
  const lon = -(70 + 18.9 / 60); // 070°18.900′W

  it('formats degrees and decimal minutes', () => {
    expect(formatCoordinate(lat, 'lat', 'ddm')).toBe('32°41.200′N');
    expect(formatCoordinate(lon, 'lon', 'ddm')).toBe('070°18.900′W');
  });

  it('formats DMS and decimal degrees', () => {
    expect(formatCoordinate(lat, 'lat', 'dms')).toBe('32°41′12.0″N');
    expect(formatCoordinate(lon, 'lon', 'dd')).toBe('70.31500° W');
  });

  it.each(['ddm', 'dms', 'dd'] as const)('%s round-trips within format precision', (fmt) => {
    for (const v of [lat, lon, 0.5, -0.0001, 59.99999, -179.5]) {
      const axis = Math.abs(v) > 90 ? 'lon' : 'lat';
      expect(parseCoordinate(formatCoordinate(v, axis, fmt))).toBeCloseTo(v, 4);
    }
  });
});

describe('formatValue', () => {
  it('formats with user units', () => {
    expect(formatValue('speed', 7.4 * (1852 / 3600), DEFAULT_UNIT_PREFS)).toEqual({ text: '7.4', unit: 'kn' });
    expect(formatValue('rpm', 36.3, DEFAULT_UNIT_PREFS)).toEqual({ text: '2,178', unit: 'rpm' });
  });

  it('shows missing values as -- with the unit kept', () => {
    expect(formatValue('depth', null, DEFAULT_UNIT_PREFS)).toEqual({ text: '--', unit: 'ft' });
  });

  it('labels sided wind angles', () => {
    expect(formatValue('windAngle', degToRad(-38), DEFAULT_UNIT_PREFS)).toEqual({ text: '38', unit: '°', side: 'PORT' });
  });
});
