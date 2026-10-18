import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { ActiveAlarm, Threshold } from '@watchkeeper/shared';
import { CLEAR_HOLD_MS, notificationPath } from '../src/alarms/engine.js';
import { iso } from '../src/clock.js';
import { buildDelta, type OutboundValue } from '../src/signalk/outbound.js';
import { CREW, GUEST, ingress, makeApp, seedUsers, SKIPPER } from './helpers/app.js';

const DEPTH = 'environment.depth.belowKeel';

describe('threshold alarms', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let sent: OutboundValue[];
  let broadcast: MockInstance;
  let threshold: Threshold;

  const set = (v: number) => t.store.update(DEPTH, v, t.clock.now());
  /** Advance in 1 s steps, publishing `v` each second like a 1 Hz sensor. */
  const hold = (v: number, seconds: number) => {
    for (let i = 0; i < seconds; i++) {
      t.clock.advance(1000);
      set(v);
      t.app.ctx.alarms.tick();
    }
  };
  const events = (type: string) => broadcast.mock.calls.filter(([ty]) => ty === type).map(([, p]) => p as ActiveAlarm);
  const logRows = () =>
    t.db.prepare("SELECT event_type, remarks, created_by, snapshot FROM log_entry WHERE kind = 'event' ORDER BY rowid").all() as {
      event_type: string;
      remarks: string;
      created_by: string | null;
      snapshot: string;
    }[];

  beforeEach(async () => {
    sent = [];
    // The real client builds the delta (which enforces the allowlist) before sending.
    t = await makeApp(undefined, {
      signalk: {
        send: (values: OutboundValue[]) => {
          buildDelta(values, iso(0));
          sent.push(...values);
        },
      },
    });
    await seedUsers(t.app);
    t.app.ctx.alarms.start();
    broadcast = vi.spyOn(t.app.ctx.hub, 'broadcast');
    // Placeholder limits for the test only; real depth limits are the skipper's to set.
    const res = await ingress(t.app, SKIPPER, {
      method: 'POST',
      url: '/api/v1/thresholds',
      payload: { path: DEPTH, label: 'Depth below keel', warnLow: 3, alarmLow: 2 },
    });
    expect(res.statusCode).toBe(201);
    threshold = res.json<Threshold>();
    set(10);
  });

  afterEach(() => t.app.ctx.alarms.stop());

  it('raises once, writes the log, notifies Signal K, and escalates warn to alarm', () => {
    set(2.9);
    expect(events('alarm.raised')).toHaveLength(1);
    expect(events('alarm.raised')[0]).toMatchObject({ id: threshold.id, state: 'warn', acked: false });
    hold(2.9, 30);
    expect(events('alarm.raised')).toHaveLength(1);

    set(1.8);
    const raised = events('alarm.raised');
    expect(raised).toHaveLength(2);
    expect(raised[1]).toMatchObject({ state: 'alarm', message: expect.stringContaining('below alarm limit') });

    expect(logRows().map((r) => r.event_type)).toEqual(['alarm_raised', 'alarm_raised']);
    expect(JSON.parse(logRows()[1]!.snapshot)).toMatchObject({ [DEPTH]: 1.8 });
    expect(sent.filter((v) => v.path === notificationPath(threshold.id)).map((v) => (v.value as { state: string }).state)).toEqual(['warn', 'alarm']);
    // A phone notification for alarm-class only, not the warning.
    expect(t.ha.calls.filter((c) => c.method === 'notify')).toHaveLength(1);
    expect(t.ha.calls.find((c) => c.method === 'notify')!.args[2]).toEqual({ critical: true });
  });

  it('hysteresis prevents flapping around the limit', () => {
    set(1.9);
    // Wobbling across the 2 m limit, never 2% of the range (2 cm) past it.
    for (let i = 0; i < 120; i++) hold(i % 2 ? 2.015 : 1.99, 1);
    expect(events('alarm.raised')).toHaveLength(1);
    expect(events('alarm.cleared')).toHaveLength(0);
    expect(t.app.ctx.alarms.list()).toHaveLength(1);
  });

  it('clears only after 10 s back past the limit by the margin', () => {
    set(1.9);
    hold(3.5, CLEAR_HOLD_MS / 1000 - 1);
    expect(t.app.ctx.alarms.list()).toHaveLength(1);
    // A dip resets the hold.
    hold(1.95, 1);
    hold(3.5, CLEAR_HOLD_MS / 1000 - 1);
    expect(t.app.ctx.alarms.list()).toHaveLength(1);
    hold(3.5, 2);
    expect(t.app.ctx.alarms.list()).toHaveLength(0);
    expect(events('alarm.cleared')).toEqual([{ id: threshold.id }]);
    expect((sent.at(-1)!.value as { state: string }).state).toBe('normal');
  });

  it('acknowledge silences sound but keeps the alarm until it clears', async () => {
    set(1.9);
    expect((await ingress(t.app, GUEST, { method: 'POST', url: `/api/v1/alarms/${threshold.id}/ack` })).statusCode).toBe(403);
    const res = await ingress(t.app, CREW, { method: 'POST', url: `/api/v1/alarms/${threshold.id}/ack` });
    expect(res.statusCode).toBe(200);
    expect(res.json<ActiveAlarm>().acked).toBe(true);
    expect(events('alarm.acked')).toHaveLength(1);
    const active = (await ingress(t.app, GUEST, { method: 'GET', url: '/api/v1/alarms/active' })).json<ActiveAlarm[]>();
    expect(active).toEqual([expect.objectContaining({ id: threshold.id, acked: true })]);
    expect((sent.at(-1)!.value as { method: string[] }).method).toEqual(['visual']);
    const ack = logRows().at(-1)!;
    expect(ack.event_type).toBe('alarm_acked');
    expect(ack.created_by).toBe(CREW.id);
    // Still in alarm: no re-raise while acknowledged.
    hold(1.9, 60);
    expect(events('alarm.raised')).toHaveLength(1);
  });

  it('snooze silences for N minutes, then re-raises if the condition still holds', async () => {
    set(1.9);
    await ingress(t.app, CREW, { method: 'POST', url: `/api/v1/alarms/${threshold.id}/ack` });
    const res = await ingress(t.app, CREW, { method: 'POST', url: `/api/v1/alarms/${threshold.id}/snooze`, payload: { minutes: 2 } });
    expect(res.json<ActiveAlarm>().snoozedUntil).not.toBeNull();
    hold(1.9, 119);
    expect(events('alarm.raised')).toHaveLength(1);
    hold(1.9, 1);
    const raised = events('alarm.raised');
    expect(raised).toHaveLength(2);
    expect(raised[1]).toMatchObject({ acked: false, snoozedUntil: null });
    expect(logRows().map((r) => r.event_type)).toEqual(['alarm_raised', 'alarm_acked', 'alarm_snoozed', 'alarm_raised']);
  });

  it('a snoozed alarm that clears does not come back', async () => {
    set(1.9);
    await ingress(t.app, CREW, { method: 'POST', url: `/api/v1/alarms/${threshold.id}/snooze`, payload: { minutes: 1 } });
    hold(5, 15);
    hold(5, 60);
    expect(events('alarm.raised')).toHaveLength(1);
    expect(t.app.ctx.alarms.list()).toHaveLength(0);
  });

  it('a stale value leaves the alarm as it is', () => {
    set(1.9);
    t.clock.advance(10 * 60_000);
    t.app.ctx.alarms.tick();
    expect(t.app.ctx.alarms.list()).toHaveLength(1);
  });

  it('removing or disabling the threshold clears its alarm', async () => {
    set(1.9);
    const res = await ingress(t.app, SKIPPER, { method: 'PUT', url: `/api/v1/thresholds/${threshold.id}`, payload: { ...threshold, enabled: false } });
    expect(res.statusCode).toBe(200);
    expect(t.app.ctx.alarms.list()).toHaveLength(0);
  });

  it('only the skipper changes thresholds; one per path', async () => {
    const body = { path: DEPTH, label: 'Again', alarmLow: 1 };
    expect((await ingress(t.app, CREW, { method: 'POST', url: '/api/v1/thresholds', payload: body })).statusCode).toBe(403);
    expect((await ingress(t.app, SKIPPER, { method: 'POST', url: '/api/v1/thresholds', payload: body })).statusCode).toBe(409);
    expect((await ingress(t.app, GUEST, { method: 'GET', url: '/api/v1/thresholds' })).json<Threshold[]>()).toHaveLength(1);
  });
});
