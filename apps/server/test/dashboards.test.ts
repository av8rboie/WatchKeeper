import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dashboard, DashboardExport, DashboardSummary, LayoutItem } from '@watchkeeper/shared';
import { BoatModel } from '@watchkeeper/sim';
import { CREW, GUEST, ingress, makeApp, seedUsers, SKIPPER } from './helpers/app.js';
import { T0 } from './helpers/fixtures.js';

type Ctx = Awaited<ReturnType<typeof makeApp>>;

const helm = {
  name: 'Helm',
  widgets: [
    { id: 'w-sog', type: 'numeric', label: 'SOG', path: 'navigation.speedOverGround', config: { decimals: 1 } },
    { id: 'w-wind', type: 'wind', label: 'Wind', path: null, config: {} },
    { id: 'w-depth', type: 'depth', label: 'Depth', path: 'environment.depth.belowKeel', config: {} },
  ],
};

describe('dashboards', () => {
  let t: Ctx;
  beforeEach(async () => {
    t = await makeApp();
    await seedUsers(t.app);
  });

  const create = async (body: unknown = helm) => {
    const res = await ingress(t.app, SKIPPER, { method: 'POST', url: '/api/v1/dashboards', payload: body as object });
    expect(res.statusCode).toBe(201);
    return res.json<Dashboard>();
  };

  it('skipper creates; everyone reads; crew and guest cannot edit', async () => {
    const d = await create();
    expect(d.widgets.map((w) => w.id)).toHaveLength(3);
    for (const user of [GUEST, CREW]) {
      expect((await ingress(t.app, user, { method: 'GET', url: `/api/v1/dashboards/${d.id}` })).statusCode).toBe(200);
      expect((await ingress(t.app, user, { method: 'PUT', url: `/api/v1/dashboards/${d.id}`, payload: helm })).statusCode).toBe(403);
      expect((await ingress(t.app, user, { method: 'PUT', url: `/api/v1/dashboards/${d.id}/layouts`, payload: { layouts: {} } })).statusCode).toBe(403);
    }
    const list = (await ingress(t.app, GUEST, { method: 'GET', url: '/api/v1/dashboards' })).json<DashboardSummary[]>();
    expect(list.map((x) => x.name)).toEqual(['Helm']);
  });

  it('stores a complete layout for every breakpoint', async () => {
    const d = await create();
    expect(d.layouts.phone.map((l) => l.i).sort()).toEqual(d.widgets.map((w) => w.id).sort());
    expect(d.layouts.tablet).toHaveLength(3);
    expect(d.layouts.desktop).toHaveLength(3);
    expect(Math.max(...d.layouts.phone.map((l) => l.x + l.w))).toBeLessThanOrEqual(2);
  });

  it('a layout edited on desktop does not change the phone layout', async () => {
    const d = await create();
    const desktop: LayoutItem[] = d.layouts.desktop.map((l, i) => ({ ...l, x: i * 4, y: 0, w: 4, h: 2 }));
    const res = await ingress(t.app, SKIPPER, { method: 'PUT', url: `/api/v1/dashboards/${d.id}/layouts`, payload: { layouts: { desktop } } });
    expect(res.statusCode).toBe(200);
    const after = res.json<Dashboard>();
    expect(after.layouts.desktop).toEqual(desktop);
    expect(after.layouts.phone).toEqual(d.layouts.phone);
    expect(after.layouts.tablet).toEqual(d.layouts.tablet);
  });

  it('places a widget added later at the bottom of each existing layout', async () => {
    const d = await create();
    const body = { name: d.name, widgets: [...d.widgets, { id: 'w-new', type: 'numeric', label: 'STW', path: 'navigation.speedThroughWater', config: {} }] };
    const after = (await ingress(t.app, SKIPPER, { method: 'PUT', url: `/api/v1/dashboards/${d.id}`, payload: body })).json<Dashboard>();
    for (const bp of ['phone', 'tablet', 'desktop'] as const) {
      const bottom = Math.max(...d.layouts[bp].map((l) => l.y + l.h));
      expect(after.layouts[bp].find((l) => l.i === 'w-new')!.y).toBe(bottom);
      for (const l of d.layouts[bp]) expect(after.layouts[bp]).toContainEqual(l);
    }
  });

  it('tells other clients when a dashboard changes', async () => {
    const spy = vi.spyOn(t.app.ctx.hub, 'broadcast');
    const d = await create();
    await ingress(t.app, SKIPPER, { method: 'PUT', url: `/api/v1/dashboards/${d.id}/layouts`, payload: { layouts: { phone: d.layouts.phone } } });
    await ingress(t.app, SKIPPER, { method: 'DELETE', url: `/api/v1/dashboards/${d.id}` });
    expect(spy.mock.calls.filter(([type]) => type === 'dashboard.updated')).toHaveLength(3);
    expect(spy).toHaveBeenLastCalledWith('dashboard.updated', { id: d.id });
  });

  it('exports and imports, giving the copy fresh widget ids with layouts intact', async () => {
    const d = await create();
    const exp = (await ingress(t.app, GUEST, { method: 'GET', url: `/api/v1/dashboards/${d.id}/export` })).json<DashboardExport>();
    expect(exp.format).toBe('data-hub-dashboard');
    const res = await ingress(t.app, SKIPPER, { method: 'POST', url: '/api/v1/dashboards/import', payload: exp });
    expect(res.statusCode).toBe(201);
    const copy = res.json<Dashboard>();
    expect(copy.id).not.toBe(d.id);
    const oldToNew = new Map(d.widgets.map((w, i) => [w.id, copy.widgets[i]!.id]));
    for (const id of oldToNew.values()) expect(d.widgets.map((w) => w.id)).not.toContain(id);
    expect(copy.layouts.desktop).toEqual(d.layouts.desktop.map((l) => ({ ...l, i: oldToNew.get(l.i) })));
    // The original is untouched.
    expect((await ingress(t.app, GUEST, { method: 'GET', url: `/api/v1/dashboards/${d.id}` })).json<Dashboard>().widgets).toEqual(d.widgets);
  });

  it('rejects widgets bound to something that is not a Signal K path', async () => {
    const bad = { name: 'x', widgets: [{ type: 'numeric', label: 'x', path: 'navigation speed; drop', config: {} }] };
    expect((await ingress(t.app, SKIPPER, { method: 'POST', url: '/api/v1/dashboards', payload: bad })).statusCode).toBe(400);
  });
});

describe('starter dashboards', () => {
  it('uses only the paths Signal K is publishing', async () => {
    const t = await makeApp();
    await seedUsers(t.app);
    // A motoring catamaran from the simulator, minus its depth sounder and tank senders.
    const m = new BoatModel({ start: T0, scenario: 'motoring' });
    m.advanceTo(T0 + 600_000);
    for (const [path, value] of Object.entries(m.values())) {
      if (path.startsWith('tanks.') || path === 'environment.depth.belowKeel') continue;
      t.store.update(path, value, t.clock.now());
    }
    const res = await ingress(t.app, SKIPPER, { method: 'POST', url: '/api/v1/dashboards/starter' });
    expect(res.statusCode).toBe(201);
    expect(res.json<DashboardSummary[]>().map((d) => d.name)).toEqual(['Helm', 'Engines', 'Energy', 'Anchor']);

    const all = t.app.ctx.dashboards.list().map((s) => t.app.ctx.dashboards.get(s.id)!);
    const types = (name: string) => all.find((d) => d.name === name)!.widgets.map((w) => w.type);
    expect(types('Helm')).toEqual(['wind', 'numeric', 'heading', 'numeric', 'battery', 'numeric']);
    expect(types('Engines')).toEqual(['gauge', 'twin', 'numeric', 'trend', 'gauge']);
    expect(types('Energy')).not.toContain('tank');
    expect(all.flatMap((d) => d.widgets).some((w) => w.type === 'depth')).toBe(false);
  });

  it('creates nothing for a dashboard with no data', async () => {
    const t = await makeApp();
    await seedUsers(t.app);
    t.store.update('navigation.speedOverGround', 3, t.clock.now());
    await ingress(t.app, SKIPPER, { method: 'POST', url: '/api/v1/dashboards/starter' });
    expect(t.app.ctx.dashboards.list().map((d) => d.name)).toEqual(['Helm', 'Anchor']);
  });
});
