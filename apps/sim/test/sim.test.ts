import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { distanceM, KNOT_MPS } from '@watchkeeper/shared';
import { BoatModel, DEAD, SimServer } from '../src/index.js';

const T0 = Date.UTC(2026, 9, 18, 14, 0, 0);

describe('BoatModel', () => {
  it('is deterministic for a seed and start time', () => {
    const a = new BoatModel({ start: T0, seed: 7, scenario: 'sailing' });
    const b = new BoatModel({ start: T0, seed: 7, scenario: 'sailing' });
    a.advanceTo(T0 + 600_000);
    b.advanceTo(T0 + 600_000);
    expect(a.values()).toEqual(b.values());
  });

  it('motors at cruise with both engines running and burning fuel', () => {
    const m = new BoatModel({ start: T0, scenario: 'motoring' });
    m.advanceTo(T0 + 20 * 60_000);
    const v = m.values();
    expect((v['propulsion.port.revolutions'] as number) * 60).toBeGreaterThan(2100);
    expect(v['propulsion.port.state']).toBe('started');
    expect((v['navigation.speedThroughWater'] as number) / KNOT_MPS).toBeCloseTo(7.2, 0);
    expect(v['propulsion.port.fuel.rate'] as number).toBeGreaterThan(0);
    expect(v['propulsion.port.temperature'] as number).toBeGreaterThan(273.15 + 70);
    expect(v['steering.autopilot.state']).toBe('auto');
  });

  it('sails with engines off and the wind on the starboard bow', () => {
    const m = new BoatModel({ start: T0, scenario: 'sailing' });
    m.advanceTo(T0 + 10 * 60_000);
    const v = m.values();
    expect(v['propulsion.port.revolutions']).toBe(0);
    expect(v['propulsion.port.state']).toBe('stopped');
    const stwKn = (v['navigation.speedThroughWater'] as number) / KNOT_MPS;
    expect(stwKn).toBeGreaterThan(4);
    expect(stwKn).toBeLessThan(11);
    expect(v['environment.wind.angleApparent'] as number).toBeGreaterThan(0);
  });

  it('swings on the anchor without leaving the swing circle', () => {
    const m = new BoatModel({ start: T0, scenario: 'anchored' });
    const anchor = m.anchor!;
    for (let i = 0; i < 1800; i++) {
      m.step();
      expect(distanceM(anchor, m.pos)).toBeLessThan(30);
    }
    expect(m.values()['navigation.anchor.position']).toEqual(anchor);
    expect(m.values()['environment.depth.belowKeel']).toBeGreaterThan(4);
  });

  it('runs out of sounder range offshore', () => {
    const m = new BoatModel({ start: T0, scenario: 'sailing' });
    m.advanceTo(T0 + 3 * 3600_000);
    expect(m.values()['environment.depth.belowKeel']).toBeNull();
  });

  it('overrides fix a value; DEAD stops a path', () => {
    const m = new BoatModel({ start: T0 });
    m.overrides.set('environment.depth.belowKeel', 1.2);
    m.overrides.set('environment.water.temperature', DEAD);
    const v = m.values();
    expect(v['environment.depth.belowKeel']).toBe(1.2);
    expect('environment.water.temperature' in v).toBe(false);
  });

  it('cycles through the mixed scenario', () => {
    const m = new BoatModel({ start: T0 });
    expect(m.phase.phase).toBe('anchored');
    m.advanceTo(T0 + 30 * 60_000);
    expect(m.phase.phase).toBe('motoring');
    m.advanceTo(T0 + 60 * 60_000);
    expect(m.phase.phase).toBe('sailing');
  });
});

describe('SimServer', () => {
  let sim: SimServer | null = null;
  afterEach(async () => {
    await sim?.stop();
    sim = null;
  });

  const connect = (url: string, token?: string) =>
    new Promise<{ ws: WebSocket; messages: Record<string, unknown>[] }>((resolve, reject) => {
      const ws = new WebSocket(url.replace('http', 'ws') + '/signalk/v1/stream?subscribe=none', token ? { headers: { Authorization: `Bearer ${token}` } } : {});
      const messages: Record<string, unknown>[] = [];
      ws.on('message', (d) => messages.push(JSON.parse(d.toString())));
      ws.on('open', () => resolve({ ws, messages }));
      ws.on('error', reject);
    });

  const getToken = async (url: string) => {
    const req = await fetch(`${url}/signalk/v1/access/requests`, { method: 'POST', body: JSON.stringify({ clientId: 'test', description: 'Data Hub', permissions: 'readwrite' }) });
    const { href } = (await req.json()) as { href: string };
    const done = (await (await fetch(url + href)).json()) as { accessRequest: { token: string } };
    return done.accessRequest.token;
  };

  it('sends nothing but the hello to an unauthenticated stream', async () => {
    sim = await SimServer.start({ tickMs: 20, model: { start: T0 } });
    const { ws, messages } = await connect(sim.url);
    ws.send(JSON.stringify({ context: 'vessels.self', subscribe: [{ path: '*', period: 100 }] }));
    await new Promise((r) => setTimeout(r, 300));
    ws.close();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.self).toMatch(/^vessels\./);
    expect((await fetch(`${sim.url}/signalk/v1/api/vessels/self`)).status).toBe(401);
  });

  it('streams subscribed paths at their periods after the access request is approved', async () => {
    sim = await SimServer.start({ tickMs: 20, model: { start: T0 } });
    const token = await getToken(sim.url);
    const { ws, messages } = await connect(sim.url, token);
    ws.send(
      JSON.stringify({
        context: 'vessels.self',
        subscribe: [
          { path: 'navigation.speedOverGround', period: 100 },
          { path: 'tanks.*', period: 60_000 },
        ],
      }),
    );
    await new Promise((r) => setTimeout(r, 650));
    ws.close();
    const values = messages.flatMap((m) => ((m.updates as { values: { path: string }[] }[] | undefined) ?? []).flatMap((u) => u.values.map((v) => v.path)));
    const sog = values.filter((p) => p === 'navigation.speedOverGround').length;
    expect(sog).toBeGreaterThanOrEqual(4);
    expect(sog).toBeLessThanOrEqual(8);
    // Slow paths go out once on subscribe, then wait for their period.
    expect(values.filter((p) => p === 'tanks.fuel.port.currentLevel')).toHaveLength(1);
    expect(values).not.toContain('navigation.position');
    const tree = (await (await fetch(`${sim.url}/signalk/v1/api/vessels/self`, { headers: { Authorization: `Bearer ${token}` } })).json()) as {
      navigation: { speedOverGround: { value: unknown } };
    };
    expect(typeof tree.navigation.speedOverGround.value).toBe('number');
  });

  it('keeps values a client writes', async () => {
    sim = await SimServer.start({ tickMs: 20, model: { start: T0 } });
    const { ws } = await connect(sim.url, await getToken(sim.url));
    ws.send(JSON.stringify({ context: 'vessels.self', updates: [{ timestamp: new Date(T0).toISOString(), values: [{ path: 'dataHub.fuel.totalRate', value: 1e-6 }] }] }));
    await new Promise((r) => setTimeout(r, 100));
    ws.close();
    expect(sim.written.get('dataHub.fuel.totalRate')?.value).toBe(1e-6);
  });

  it('applies control changes over HTTP', async () => {
    sim = await SimServer.start({ tickMs: 20, model: { start: T0 } });
    const res = await fetch(`${sim.url}/sim/control`, { method: 'POST', body: JSON.stringify({ scenario: 'motoring', overrides: { 'environment.depth.belowKeel': 1.5 } }) });
    const state = (await res.json()) as { phase: string };
    expect(state.phase).toBe('motoring');
    expect(sim.model.values()['environment.depth.belowKeel']).toBe(1.5);
  });
});
