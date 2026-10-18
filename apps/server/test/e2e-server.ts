// End-to-end test server: a fake Signal K publishing live generated data, the
// real backend (via createRuntime) with seeded HA users, the built web app,
// and an ingress proxy in front that mounts it all under a random
// /api/hassio_ingress/<token> prefix. Never used in production.
//
//   PORT=8090 INGRESS_PREFIX=/api/hassio_ingress/abc tsx test/e2e-server.ts

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { FakeHaClient } from '../src/ha/client.js';
import { createRuntime } from '../src/runtime.js';
import { FakeSignalK } from './helpers/fakeSignalK.js';
import { generate } from './helpers/fixtures.js';
import { startIngressProxy } from './helpers/ingressProxy.js';

const port = Number(process.env.PORT ?? 8090);
const prefix = process.env.INGRESS_PREFIX ?? `/api/hassio_ingress/${Math.random().toString(36).slice(2, 12)}`;
const backendPort = port + 1;
const dataDir = mkdtempSync(join(tmpdir(), 'dh-e2e-'));
const sk = await FakeSignalK.start();

// Publish one generated delta per second with a live timestamp, plus GPS time.
// SOG varies so tests can see values arrive.
let publish: NodeJS.Timeout | null = null;
let tick = 0;
const startPublishing = () => {
  publish = setInterval(() => {
    const delta = generate({ seconds: 1, start: Date.now() }).next().value!.delta;
    const values = delta.updates[0]!.values;
    const sog = values.find((v: { path: string }) => v.path === 'navigation.speedOverGround');
    if (sog) sog.value = (7 + 0.6 * Math.sin(tick++ / 2)) * (1852 / 3600);
    values.push({ path: 'navigation.datetime', value: new Date().toISOString() });
    sk.send(delta);
  }, 1000);
};
startPublishing();

const config = {
  ...loadConfig({ DATA_DIR: dataDir, SIGNALK_URL: sk.url, PORT: String(backendPort), TRUSTED_PROXIES: '127.0.0.1' }),
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

rt.app.post('/__test/signalk/stop', async () => {
  if (publish) clearInterval(publish);
  await sk.stop();
  return { ok: true };
});
rt.app.post('/__test/signalk/start', async () => {
  await sk.restart();
  startPublishing();
  return { ok: true };
});

rt.start();
await rt.app.listen({ host: '127.0.0.1', port: backendPort });
await startIngressProxy({ target: `http://127.0.0.1:${backendPort}`, port, prefix, defaultUser: { id: 'ha-skipper', name: 'Skipper' } });
console.log(`e2e: http://127.0.0.1:${port}${prefix}/ (backend :${backendPort}, fake Signal K ${sk.url})`);
