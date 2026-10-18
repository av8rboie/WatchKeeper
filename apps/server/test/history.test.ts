import { beforeEach, describe, expect, it } from 'vitest';
import type { HistorySeries } from '@watchkeeper/shared';
import { iso } from '../src/clock.js';
import { GUEST, ingress, makeApp, seedUsers } from './helpers/app.js';

const SOG = 'navigation.speedOverGround';
const BARO = 'environment.outside.pressure';

describe('GET /history', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let now: number;

  beforeEach(async () => {
    t = await makeApp();
    await seedUsers(t.app);
    now = t.clock.now();
    const s1 = t.db.prepare('INSERT INTO sample_1s (path, ts, value) VALUES (?, ?, ?)');
    const m1 = t.db.prepare('INSERT INTO sample_1m (path, ts, avg, min, max) VALUES (?, ?, ?, ?, ?)');
    const m10 = t.db.prepare('INSERT INTO sample_10m (path, ts, avg, min, max) VALUES (?, ?, ?, ?, ?)');
    // 10 minutes of SOG at 1 s, with one spike.
    for (let i = 0; i < 600; i++) s1.run(SOG, now - 600_000 + i * 1000, i === 300 ? 9 : 3);
    for (let i = 0; i < 360; i++) m1.run(SOG, now - 360 * 60_000 + i * 60_000, 3, 2, 4);
    // 6 hours of barometer at 1 min.
    for (let i = 0; i < 360; i++) m1.run(BARO, now - 360 * 60_000 + i * 60_000, 101_000 + i, 101_000 + i - 5, 101_000 + i + 5);
    m10.run(BARO, now - 100 * 86_400_000, 100_000, 99_000, 101_000);
  });

  const get = async (paths: string, fromMs: number, maxPoints = 500) => {
    const res = await ingress(t.app, GUEST, { method: 'GET', url: `/api/v1/history?paths=${paths}&from=${iso(now - fromMs)}&to=${iso(now)}&maxPoints=${maxPoints}` });
    expect(res.statusCode).toBe(200);
    return res.json<HistorySeries[]>();
  };

  it('uses 1 s data for a recent fast path, bucketed to maxPoints, keeping the spike', async () => {
    const [s] = await get(SOG, 600_000, 100);
    expect(s!.resolution).toBe('1s');
    expect(s!.points.length).toBeLessThanOrEqual(100);
    expect(Math.max(...s!.points.map((p) => p[3]!))).toBe(9);
    expect(Math.min(...s!.points.map((p) => p[2]!))).toBe(3);
  });

  it('uses 1 min data for slower paths and older ranges', async () => {
    const [baro, sog] = await get(`${BARO},${SOG}`, 25 * 3600_000);
    expect(baro!.resolution).toBe('1m');
    // 25 h in 500 points: 3-minute buckets over the 6 h recorded.
    expect(baro!.points).toHaveLength(120);
    expect(sog!.resolution).toBe('1m');
  });

  it('uses 10 min data beyond 90 days', async () => {
    const [s] = await get(BARO, 120 * 86_400_000);
    expect(s!.resolution).toBe('10m');
    expect(s!.points[0]![1]).toBe(100_000);
  });

  it('rejects an empty or backwards range', async () => {
    const res = await ingress(t.app, GUEST, { method: 'GET', url: `/api/v1/history?paths=${SOG}&from=${iso(now)}&to=${iso(now - 1000)}` });
    expect(res.statusCode).toBe(400);
  });
});
