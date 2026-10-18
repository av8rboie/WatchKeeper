import { afterEach, describe, expect, it } from 'vitest';
import { systemClock } from '../src/clock.js';
import { ConnectionGaps } from '../src/db/gaps.js';
import { openDb } from '../src/db/index.js';
import { SignalKClient } from '../src/signalk/client.js';
import { LiveStore } from '../src/signalk/store.js';
import { FakeSignalK } from './helpers/fakeSignalK.js';
import { generate } from './helpers/fixtures.js';

const until = async (cond: () => boolean, timeoutMs = 5000) => {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('Signal K connection', () => {
  let client: SignalKClient | null = null;
  let server: FakeSignalK | null = null;

  afterEach(async () => {
    client?.stop();
    await server?.stop();
    client = null;
    server = null;
  });

  it('records one connection gap across an outage and marks every path stale', async () => {
    server = await FakeSignalK.start();
    const db = openDb(':memory:');
    const gaps = new ConnectionGaps(db);
    const store = new LiveStore(systemClock);
    client = new SignalKClient({ url: server.url, store, clock: systemClock, gaps, initialBackoffMs: 50, maxBackoffMs: 200 });
    client.setSubscriptions(['navigation.speedOverGround', 'navigation.position']);
    client.start();
    await until(() => client!.connected);

    // Subscribed with the spec's message shape.
    await until(() => server!.subscriptions.length > 0);
    expect(server.subscriptions[0]).toMatchObject({
      context: 'vessels.self',
      subscribe: [{ path: 'navigation.speedOverGround', period: 1000, policy: 'instant' }, { path: 'navigation.position' }],
    });

    server.send(generate({ seconds: 1, start: Date.now() }).next().value!.delta);
    await until(() => !store.read('navigation.speedOverGround').stale);
    expect(store.read('navigation.position').stale).toBe(false);

    // Kill the server. The spec's 60 s outage is scaled down to 1.5 s here;
    // the code path does not depend on the duration.
    await server.stop();
    await until(() => !client!.connected);
    for (const p of store.paths()) expect(store.read(p).stale, p).toBe(true);
    await new Promise((r) => setTimeout(r, 1500));
    expect(gaps.list()).toHaveLength(1);
    expect(gaps.list()[0]!.ended_at).toBeNull();

    await server.restart();
    await until(() => client!.connected, 5000);
    const list = gaps.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.ended_at).not.toBeNull();
    expect(Date.parse(list[0]!.ended_at!) - Date.parse(list[0]!.started_at)).toBeGreaterThanOrEqual(1400);

    // Still stale until fresh data arrives, then fresh again.
    expect(store.read('navigation.speedOverGround').stale).toBe(true);
    server.send(generate({ seconds: 1, start: Date.now() }).next().value!.delta);
    await until(() => !store.read('navigation.speedOverGround').stale);
  });

  it('ignores deltas for other vessels (AIS targets)', async () => {
    server = await FakeSignalK.start();
    const store = new LiveStore(systemClock);
    client = new SignalKClient({ url: server.url, store, clock: systemClock, gaps: new ConnectionGaps(openDb(':memory:')) });
    client.start();
    await until(() => client!.connected);
    const ts = new Date().toISOString();
    // Another vessel's SOG, then our own (by the self URN from the hello message).
    server.send({ context: 'vessels.urn:mrn:imo:mmsi:999999999', updates: [{ timestamp: ts, values: [{ path: 'navigation.speedOverGround', value: 9.9 }] }] });
    server.send({ context: 'vessels.urn:mrn:imo:mmsi:000000000', updates: [{ timestamp: ts, values: [{ path: 'navigation.speedThroughWater', value: 3.1 }] }] });
    await until(() => !store.read('navigation.speedThroughWater').stale);
    expect(store.read('navigation.speedThroughWater').value).toBe(3.1);
    expect(store.read('navigation.speedOverGround').updatedAt).toBeNull();
  });

  it('backs off exponentially, capped at the maximum', async () => {
    const store = new LiveStore(systemClock);
    const db = openDb(':memory:');
    const attempts: number[] = [];
    // Nothing listens on port 9; every attempt fails fast.
    client = new SignalKClient({
      url: 'http://127.0.0.1:9',
      store,
      clock: systemClock,
      gaps: new ConnectionGaps(db),
      initialBackoffMs: 40,
      maxBackoffMs: 160,
    });
    // Wrap the private connect() to observe attempt timing; the cast is deliberate.
    const target = client as unknown as { connect: () => void };
    const origConnect = target.connect.bind(client);
    target.connect = () => {
      attempts.push(Date.now());
      origConnect();
    };
    client.start();
    await until(() => attempts.length >= 6, 5000);
    const intervals = attempts.slice(1).map((t, i) => t - attempts[i]!);
    // 40, 80, 160, 160, 160 (plus connection-failure latency)
    expect(intervals[0]).toBeGreaterThanOrEqual(35);
    expect(intervals[1]).toBeGreaterThanOrEqual(75);
    expect(intervals[2]).toBeGreaterThanOrEqual(150);
    expect(intervals[4]).toBeLessThan(400);
    expect(new ConnectionGaps(db).list()).toHaveLength(1);
  });
});
