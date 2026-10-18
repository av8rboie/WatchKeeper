import { describe, expect, it } from 'vitest';
import {
  autoPlace,
  bearingRad,
  breakpointFor,
  completeLayouts,
  destination,
  distanceM,
  ThresholdInputSchema,
  thresholdLevel,
  widgetPaths,
  type LayoutItem,
} from '../src/index.js';

const W = (id: string, type: 'numeric' | 'wind' | 'trend' = 'numeric') => ({ id, type });

describe('breakpoints', () => {
  it('maps widths to phone, tablet and desktop', () => {
    expect(breakpointFor(390)).toBe('phone');
    expect(breakpointFor(599)).toBe('phone');
    expect(breakpointFor(600)).toBe('tablet');
    expect(breakpointFor(1023)).toBe('tablet');
    expect(breakpointFor(1024)).toBe('desktop');
    expect(breakpointFor(1440)).toBe('desktop');
  });
});

describe('autoPlace', () => {
  it('keeps placed widgets where they are', () => {
    const layout: LayoutItem[] = [{ i: 'a', x: 1, y: 3, w: 1, h: 1 }];
    expect(autoPlace(layout, [W('a')], 'phone')).toEqual(layout);
  });

  it('places a widget missing from the layout at the bottom', () => {
    const layout: LayoutItem[] = [
      { i: 'a', x: 0, y: 0, w: 2, h: 2 },
      { i: 'b', x: 0, y: 2, w: 1, h: 1 },
    ];
    const out = autoPlace(layout, [W('a', 'wind'), W('b'), W('c')], 'phone');
    expect(out.find((l) => l.i === 'c')).toEqual({ i: 'c', x: 0, y: 3, w: 1, h: 1 });
  });

  it('fills a row left to right, then wraps', () => {
    const out = autoPlace([], [W('a'), W('b'), W('c')], 'phone');
    expect(out.map((l) => [l.x, l.y])).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
    ]);
  });

  it('drops items for removed widgets and clamps to the column count', () => {
    const layout: LayoutItem[] = [
      { i: 'gone', x: 0, y: 0, w: 1, h: 1 },
      { i: 'wide', x: 8, y: 0, w: 12, h: 1 },
    ];
    expect(autoPlace(layout, [W('wide')], 'phone')).toEqual([{ i: 'wide', x: 0, y: 0, w: 2, h: 1 }]);
  });

  it('completes each breakpoint independently', () => {
    const phone: LayoutItem[] = [{ i: 'a', x: 1, y: 5, w: 1, h: 1 }];
    const out = completeLayouts({ phone }, [W('a'), W('b', 'trend')]);
    expect(out.phone[0]).toEqual(phone[0]);
    expect(out.desktop.map((l) => l.i)).toEqual(['a', 'b']);
    expect(out.desktop[1]!.w).toBe(6);
  });
});

describe('widgetPaths', () => {
  it('collects the main path and every path in the config', () => {
    const paths = widgetPaths({
      path: 'navigation.speedOverGround',
      config: {
        pairs: [{ portPath: 'propulsion.port.revolutions', stbdPath: 'propulsion.starboard.revolutions' }],
        paths: ['environment.outside.pressure'],
        url: 'http://example.invalid/a.b',
        decimals: 1,
      },
    });
    expect(paths.sort()).toEqual(
      ['environment.outside.pressure', 'navigation.speedOverGround', 'propulsion.port.revolutions', 'propulsion.starboard.revolutions'].sort(),
    );
  });
});

describe('thresholds', () => {
  const t = { warnLow: 2, alarmLow: 1, warnHigh: 8, alarmHigh: 9 };
  it('classifies values into bands', () => {
    expect(thresholdLevel(t, 5)).toBe('normal');
    expect(thresholdLevel(t, 2)).toBe('warn');
    expect(thresholdLevel(t, 0.5)).toBe('alarm');
    expect(thresholdLevel(t, 8.5)).toBe('warn');
    expect(thresholdLevel(t, 9)).toBe('alarm');
  });

  it('rejects limits in the wrong order', () => {
    expect(ThresholdInputSchema.safeParse({ path: 'a.b', label: 'x', warnLow: 1, alarmLow: 2 }).success).toBe(false);
    expect(ThresholdInputSchema.safeParse({ path: 'a.b', label: 'x', warnLow: 5, warnHigh: 4 }).success).toBe(false);
    expect(ThresholdInputSchema.safeParse({ path: 'a.b', label: 'x' }).success).toBe(false);
    expect(ThresholdInputSchema.safeParse({ path: 'a.b', label: 'x', alarmHigh: 3 }).success).toBe(true);
  });
});

describe('geo', () => {
  it('one minute of latitude is one nautical mile', () => {
    expect(distanceM({ latitude: 0, longitude: 0 }, { latitude: 1 / 60, longitude: 0 })).toBeCloseTo(1853.2, 0);
  });

  it('destination and bearing invert each other', () => {
    const from = { latitude: 36.9, longitude: -76.2 };
    const to = destination(from, Math.PI / 4, 10_000);
    expect(distanceM(from, to)).toBeCloseTo(10_000, 3);
    expect(bearingRad(from, to)).toBeCloseTo(Math.PI / 4, 3);
  });
});
