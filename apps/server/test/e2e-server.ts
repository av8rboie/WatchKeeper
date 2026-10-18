// End-to-end test server: a fake Signal K publishing live generated data,
// the real backend with seeded users, and the built PWA. Test-only control
// routes stop and restart the fake Signal K. Never used in production.
//
//   tsx test/e2e-server.ts   (PORT, default 8090)

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DERIVED_PATHS, expandCatalog } from '@watchkeeper/shared';
import { buildApp } from '../src/app.js';
import { EventHub } from '../src/api/events.js';
import { systemStatus } from '../src/api/system.js';
import { systemClock } from '../src/clock.js';
import { loadConfig } from '../src/config.js';
import { ConnectionGaps } from '../src/db/gaps.js';
import { openDb } from '../src/db/index.js';
import { Recorder } from '../src/recorder/recorder.js';
import { SignalKClient } from '../src/signalk/client.js';
import { LiveStore } from '../src/signalk/store.js';
import { FakeSignalK } from './helpers/fakeSignalK.js';
import { generate } from './helpers/fixtures.js';

const port = Number(process.env.PORT ?? 8090);
const dataDir = mkdtempSync(join(tmpdir(), 'dh-e2e-'));
const sk = await FakeSignalK.start();

// Publish one generated delta per second with a live timestamp.
let publish: NodeJS.Timeout | null = null;
const startPublishing = () => {
  publish = setInterval(() => sk.send(generate({ seconds: 1, start: Date.now() }).next().value!.delta), 1000);
};
startPublishing();

const config = {
  ...loadConfig({ DATA_DIR: dataDir, COOKIE_SECURE: 'false', SIGNALK_URL: sk.url }),
  webDist: resolve(import.meta.dirname, '../../web/dist'),
};
const db = openDb(config.dbFile);
const store = new LiveStore(systemClock);
const hub = new EventHub();
const catalogPaths = () => [...expandCatalog().map((d) => d.path), ...DERIVED_PATHS.map((d) => d.path)];
const signalk = new SignalKClient({ url: sk.url, store, clock: systemClock, gaps: new ConnectionGaps(db), initialBackoffMs: 200, maxBackoffMs: 1000 });

const app = await buildApp({ db, config, clock: systemClock, store, hub, signalk, catalogPaths });
await app.ctx.users.create('Skipper', 'skipper', '1111');
await app.ctx.users.create('Crew', 'crew', '2222');
await app.ctx.users.create('Guest', 'guest', '3333');

app.post('/__test/signalk/stop', async () => {
  if (publish) clearInterval(publish);
  await sk.stop();
  return { ok: true };
});
app.post('/__test/signalk/start', async () => {
  await sk.restart();
  startPublishing();
  return { ok: true };
});

signalk.setSubscriptions(catalogPaths());
signalk.on('status', () => void systemStatus(app.ctx).then((s) => hub.broadcast('system.status', s)));
signalk.start();
new Recorder(db, store, systemClock).start();

await app.listen({ host: '127.0.0.1', port });
console.log(`e2e server on http://127.0.0.1:${port} (fake Signal K ${sk.url}, data ${dataDir})`);
