// End-to-end test server: the Signal K simulator (auth on, approval
// automatic), the real backend (via createRuntime) with seeded HA users, the
// built web app, and an ingress proxy in front that mounts it all under a
// random /api/hassio_ingress/<token> prefix. Never used in production.
//
//   PORT=8090 INGRESS_PREFIX=/api/hassio_ingress/abc tsx test/e2e-server.ts

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SimServer } from '@watchkeeper/sim';
import { loadConfig } from '../src/config.js';
import { FakeHaClient } from '../src/ha/client.js';
import { createRuntime } from '../src/runtime.js';
import { startIngressProxy } from './helpers/ingressProxy.js';

const port = Number(process.env.PORT ?? 8090);
const prefix = process.env.INGRESS_PREFIX ?? `/api/hassio_ingress/${Math.random().toString(36).slice(2, 12)}`;
const backendPort = port + 1;
const dataDir = mkdtempSync(join(tmpdir(), 'dh-e2e-'));

// A sailing catamaran in live time, fixed seed so screenshots look alike run to run.
const sim = await SimServer.start({ model: { scenario: 'sailing', seed: 1, start: Date.now() } });

const config = {
  ...loadConfig({ DATA_DIR: dataDir, SIGNALK_URL: sim.url, PORT: String(backendPort), TRUSTED_PROXIES: '127.0.0.1' }),
  webDist: resolve(import.meta.dirname, '../../web/dist'),
};
const rt = await createRuntime({ config, ha: new FakeHaClient(), backoff: { initialMs: 200, maxMs: 1000 } });

// HA users: a skipper, crew with helm PIN 2222, and an unmapped guest.
const { users } = rt.app.ctx;
users.seen('ha-skipper', 'Skipper');
users.seen('ha-crew', 'Crew');
users.seen('ha-guest', 'Helm phone');
await users.setMapping('ha-skipper', 'skipper', '1111');
await users.setMapping('ha-crew', 'crew', '2222');

// Test controls, on the backend port only: the ingress proxy only forwards the prefix.
rt.app.post('/__test/signalk/stop', async () => {
  await sim.stop();
  return { ok: true };
});
rt.app.post('/__test/signalk/start', async () => {
  await sim.restart();
  return { ok: true };
});
rt.app.post('/__test/sim/control', async (req) => {
  sim.control(req.body as Parameters<SimServer['control']>[0]);
  return sim.state();
});
// The logbook runs on the hour; tests can't wait for one. Writes an entry as the scheduler or a trigger would.
rt.app.post('/__test/log/entry', async (req) => {
  const b = req.body as { kind: 'hourly' | 'event'; eventType?: string; remarks?: string; minutesAgo?: number };
  const now = rt.time.read().now;
  const back = (b.minutesAgo ?? 0) * 60_000;
  const ts = b.kind === 'hourly' ? Math.floor((now - back) / 3_600_000) * 3_600_000 : now - back;
  return rt.app.ctx.logbook.write({ kind: b.kind, eventType: b.eventType ?? null, remarks: b.remarks ?? null, ts });
});
rt.app.post('/__test/log/suggest', async (req) => {
  const b = req.body as { kind: 'start' | 'end'; reason: string };
  rt.triggers.suggest(b.kind, b.reason);
  return { ok: true };
});

rt.start();
await rt.app.listen({ host: '127.0.0.1', port: backendPort });
await startIngressProxy({ target: `http://127.0.0.1:${backendPort}`, port, prefix, defaultUser: { id: 'ha-skipper', name: 'Skipper' } });
console.log(`e2e: http://127.0.0.1:${port}${prefix}/ (backend :${backendPort}, Signal K simulator ${sim.url})`);
