import { execFile } from 'node:child_process';
import { DERIVED_PATHS, DEFAULT_INSTANCE_IDS, expandCatalog, type InstanceIds } from '@watchkeeper/shared';
import { buildApp } from './app.js';
import { EventHub } from './api/events.js';
import { systemStatus } from './api/system.js';
import { systemClock } from './clock.js';
import { loadConfig } from './config.js';
import { ConnectionGaps } from './db/gaps.js';
import { getSetting, openDb } from './db/index.js';
import { Recorder } from './recorder/recorder.js';
import { SignalKClient } from './signalk/client.js';
import { BROWSER_TOKEN, DEVICE_TOKEN, readToken, stepAccessRequest } from './signalk/deviceAuth.js';
import { LiveStore } from './signalk/store.js';

const config = loadConfig();
const db = openDb(config.dbFile);
const clock = systemClock;
const store = new LiveStore(clock);
const hub = new EventHub();
const gaps = new ConnectionGaps(db);

// A gap left open by a crash ends when we come back up.
gaps.close(clock.now());

const catalogPaths = () => {
  const ids = getSetting<InstanceIds>(db, 'instanceIds', DEFAULT_INSTANCE_IDS);
  return [...expandCatalog(ids).map((d) => d.path), ...DERIVED_PATHS.map((d) => d.path)];
};

const signalk = new SignalKClient({
  url: config.signalkUrl,
  store,
  clock,
  gaps,
  token: () => readToken(config.configDir, DEVICE_TOKEN),
});

const app = await buildApp(
  {
    db,
    config,
    clock,
    store,
    hub,
    signalk,
    catalogPaths,
    fetchSelf: async () => {
      const token = readToken(config.configDir, DEVICE_TOKEN);
      const res = await fetch(`${config.signalkUrl}/signalk/v1/api/vessels/self`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      return res.ok ? res.json() : null;
    },
  },
  { logger: { level: config.logLevel } },
);

signalk.log = app.log;
// The backend subscribes to device paths; derived paths are its own output.
signalk.setSubscriptions(catalogPaths().filter((p) => !p.startsWith('dataHub.')));
signalk.on('status', () => {
  void systemStatus(app.ctx).then((s) => hub.broadcast('system.status', s));
});
signalk.start();

// Device registration: request the write token and the browser read token until each is settled.
async function registerDevice(): Promise<void> {
  const device = await stepAccessRequest(config.signalkUrl, config.configDir, DEVICE_TOKEN);
  const browser = await stepAccessRequest(config.signalkUrl, config.configDir, BROWSER_TOKEN);
  // A connection made before approval gets no data; reconnect with the new token.
  if (device === 'approved' && !signalk.usingToken) signalk.reconnect();
  if (device === 'pending') app.log.warn('Waiting for Signal K to approve the Data Hub device. Approve it in the Signal K admin UI.');
  const settled = (s: string) => s === 'approved' || s === 'not-required' || s === 'denied';
  if (!settled(device) || !settled(browser)) setTimeout(() => void registerDevice(), 10_000);
}
void registerDevice();

const recorder = new Recorder(db, store, clock);
recorder.start();

await app.listen({ host: config.host, port: config.port });

// systemd (Type=notify): ready once listening, then a watchdog heartbeat
// while the event loop is alive. WatchdogSec=30 in the unit.
if (process.env.NOTIFY_SOCKET) {
  const notify = (...args: string[]) => execFile('systemd-notify', args, () => undefined);
  notify('--ready');
  setInterval(() => notify('WATCHDOG=1'), 10_000).unref();
}

async function shutdown(signal: string): Promise<void> {
  app.log.info(`${signal}: shutting down`);
  recorder.stop();
  recorder.flush();
  signalk.stop();
  hub.closeAll();
  await app.close();
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
