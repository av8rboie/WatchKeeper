// The whole backend against the Signal K simulator: device approval, rate
// classes, live values to a browser socket, and derived values written back.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { LIVE_MAX_HZ, RATE_PERIOD_MS, type LiveMessage } from '@watchkeeper/shared';
import { SimServer } from '@watchkeeper/sim';
import { loadConfig } from '../src/config.js';
import { FakeHaClient } from '../src/ha/client.js';
import { createRuntime } from '../src/runtime.js';

const until = async (cond: () => boolean, timeoutMs = 10_000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('backend against the Signal K simulator', { timeout: 20_000 }, () => {
  let sim: SimServer;
  let rt: Awaited<ReturnType<typeof createRuntime>>;
  let base: string;

  beforeAll(async () => {
    sim = await SimServer.start({ tickMs: 10, model: { scenario: 'motoring', start: Date.now() } });
    const config = loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), 'dh-sim-')), SIGNALK_URL: sim.url, TRUSTED_PROXIES: '127.0.0.1' });
    rt = await createRuntime({ config, ha: new FakeHaClient(), backoff: { initialMs: 50, maxMs: 200 } });
    rt.start();
    await rt.app.listen({ host: '127.0.0.1', port: 0 });
    base = `127.0.0.1:${(rt.app.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await rt.stop();
    await sim.stop();
  });

  const browser = (paths: string[]) =>
    new Promise<{ ws: WebSocket; batches: { at: number; msg: LiveMessage }[] }>((resolve, reject) => {
      const ws = new WebSocket(`ws://${base}/api/v1/events`, { headers: { 'x-remote-user-id': 'ha-1', 'x-remote-user-name': 'helm' } });
      const batches: { at: number; msg: LiveMessage }[] = [];
      ws.on('message', (d) => {
        const msg = JSON.parse(d.toString()) as LiveMessage;
        if (msg.type === 'live') batches.push({ at: Date.now(), msg });
      });
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'live.subscribe', paths }));
        resolve({ ws, batches });
      });
      ws.on('error', reject);
    });

  it('gets its device token approved and streams at each path’s rate class', async () => {
    await until(() => rt.signalk.connected && rt.signalk.usingToken && rt.store.read('navigation.speedOverGround').updatedAt !== null);
    const sub = sim.subscribeMessages.at(-1) as { subscribe: { path: string; period: number }[] };
    const period = (p: string) => sub.subscribe.find((s) => s.path === p)?.period;
    expect(period('navigation.speedOverGround')).toBe(RATE_PERIOD_MS.fast);
    expect(period('environment.depth.belowKeel')).toBe(RATE_PERIOD_MS.medium);
    expect(period('environment.outside.pressure')).toBe(RATE_PERIOD_MS.slow);
    expect(period('tanks.fuel.port.currentLevel')).toBe(RATE_PERIOD_MS.verySlow);
    // The backend never subscribes to its own derived values.
    expect(sub.subscribe.some((s) => s.path.startsWith('dataHub.'))).toBe(false);
  });

  it('a live value reaches the browser within 500 ms of the delta', async () => {
    const { ws, batches } = await browser(['navigation.speedOverGround']);
    const target = 4.321;
    let sentAt: number | null = null;
    sim.onSent = (values, at) => {
      if (sentAt === null && values.some((v) => v.path === 'navigation.speedOverGround' && v.value === target)) sentAt = at;
    };
    sim.control({ overrides: { 'navigation.speedOverGround': target } });
    await until(() => batches.some((b) => b.msg.values['navigation.speedOverGround']?.[0] === target), 5000);
    const arrived = batches.find((b) => b.msg.values['navigation.speedOverGround']?.[0] === target)!.at;
    sim.onSent = null;
    sim.control({ clear: ['navigation.speedOverGround'] });
    ws.close();
    expect(sentAt).not.toBeNull();
    expect(arrived - sentAt!).toBeLessThan(500);
  });

  it('caps live batches at 4 per second per client', async () => {
    const { ws, batches } = await browser(['navigation.speedOverGround', 'navigation.headingTrue', 'environment.wind.angleApparent', 'navigation.position']);
    await new Promise((r) => setTimeout(r, 3000));
    ws.close();
    const window = batches.filter((b) => b.at >= batches[0]!.at + 500);
    const span = (window.at(-1)!.at - window[0]!.at) / 1000;
    expect(window.length / Math.max(span, 1)).toBeLessThanOrEqual(LIVE_MAX_HZ + 0.5);
    for (let i = 1; i < batches.length; i++) expect(batches[i]!.at - batches[i - 1]!.at).toBeGreaterThanOrEqual(1000 / LIVE_MAX_HZ - 60);
  });

  it('publishes derived values to Signal K', async () => {
    await until(() => sim.written.has('dataHub.fuel.totalRate') && sim.written.has('dataHub.navigation.distanceRun'), 5000);
    expect(sim.written.get('dataHub.fuel.totalRate')!.value as number).toBeGreaterThan(0);
    expect([...sim.written.keys()].every((p) => p.startsWith('dataHub.') || p.startsWith('notifications.app.'))).toBe(true);
  });
});
