import { describe, expect, it } from 'vitest';
import { DERIVED_PATHS, PATH_TEMPLATES, expandCatalog } from '@watchkeeper/shared';
import { systemClock } from '../src/clock.js';
import { buildDelta, isAllowedOutbound, OutboundPathError } from '../src/signalk/outbound.js';
import { SignalKClient } from '../src/signalk/client.js';
import { LiveStore } from '../src/signalk/store.js';

describe('outbound Signal K allowlist', () => {
  it('allows app notifications and derived values', () => {
    expect(isAllowedOutbound('notifications.app.anchorDrag')).toBe(true);
    expect(isAllowedOutbound('notifications.app.threshold.01HXYZ')).toBe(true);
    for (const d of DERIVED_PATHS) expect(isAllowedOutbound(d.path), d.path).toBe(true);
  });

  it('refuses every device path in the catalog', () => {
    for (const d of expandCatalog()) expect(isAllowedOutbound(d.path), d.path).toBe(false);
    for (const d of PATH_TEMPLATES) expect(isAllowedOutbound(d.path), d.path).toBe(false);
  });

  it('refuses autopilot commands, other notifications and lookalikes', () => {
    for (const p of [
      'steering.autopilot.target.headingTrue',
      'steering.autopilot.state',
      'notifications.mob',
      'notifications.app',
      'notifications.app.',
      'notifications.application.x',
      'dataHub.fuel.totalRateX',
      'dataHub.anything',
      'electrical.switches.bank.0.state',
    ]) {
      expect(isAllowedOutbound(p), p).toBe(false);
    }
  });

  it('buildDelta throws on any disallowed path in a batch', () => {
    expect(() =>
      buildDelta(
        [
          { path: 'notifications.app.x', value: {} },
          { path: 'propulsion.port.revolutions', value: 0 },
        ],
        't',
      ),
    ).toThrow(OutboundPathError);
    expect(buildDelta([{ path: 'notifications.app.x', value: { state: 'alarm' } }], 't').updates[0]!.values).toHaveLength(1);
  });

  it('the client refuses to send outside the allowlist', () => {
    const client = new SignalKClient({
      url: 'http://127.0.0.1:9',
      store: new LiveStore(systemClock),
      clock: systemClock,
      gaps: { open() {}, close() {} },
    });
    expect(() => client.send([{ path: 'steering.autopilot.target.headingTrue', value: 1 }])).toThrow(OutboundPathError);
    expect(() => client.send([{ path: 'notifications.app.depth', value: { state: 'normal' } }])).not.toThrow();
  });
});
