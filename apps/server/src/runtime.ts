import { DEFAULT_INSTANCE_IDS, DERIVED_PATHS, describePath, expandCatalog, type InstanceIds } from '@watchkeeper/shared';
import { buildApp } from './app.js';
import { EventHub } from './api/events.js';
import { systemStatus } from './api/system.js';
import { systemClock, type Clock } from './clock.js';
import type { Config } from './config.js';
import { ConnectionGaps } from './db/gaps.js';
import { getSetting, openDb } from './db/index.js';
import { DerivedEngine } from './derived/engine.js';
import { restoreIfMissing } from './db/snapshot.js';
import type { HaClient } from './ha/client.js';
import { Recorder } from './recorder/recorder.js';
import { SignalKClient, subscriptionsFor } from './signalk/client.js';
import { DEVICE_TOKEN, readToken, stepAccessRequest, type AccessState } from './signalk/deviceAuth.js';
import { LiveStore } from './signalk/store.js';
import { TimeSource } from './signalk/time.js';

export interface RuntimeOptions {
  config: Config;
  ha: HaClient;
  clock?: Clock;
  logger?: boolean | object;
  /** Reconnect backoff, shortened in tests. */
  backoff?: { initialMs: number; maxMs: number };
}

/** Wires the whole backend. Used by main.ts and the end-to-end test server. */
export async function createRuntime(opts: RuntimeOptions) {
  const { config, ha } = opts;
  const clock = opts.clock ?? systemClock;

  const restored = restoreIfMissing(config.dbFile, config.snapshotFile);
  const db = openDb(config.dbFile);
  const store = new LiveStore(clock);
  const hub = new EventHub(store, () => clock.now());
  const gaps = new ConnectionGaps(db);
  const time = new TimeSource(store, clock);
  let accessState: AccessState | 'unknown' = 'unknown';

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
    token: () => readToken(config.dataDir, DEVICE_TOKEN),
    initialBackoffMs: opts.backoff?.initialMs,
    maxBackoffMs: opts.backoff?.maxMs,
  });

  const app = await buildApp(
    {
      db,
      config,
      clock,
      store,
      hub,
      signalk,
      time,
      ha,
      catalogPaths,
      accessState: () => accessState,
      fetchSelf: async () => {
        const token = readToken(config.dataDir, DEVICE_TOKEN);
        const res = await fetch(`${config.signalkUrl}/signalk/v1/api/vessels/self`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        return res.ok ? res.json() : null;
      },
    },
    { logger: opts.logger ?? false },
  );
  if (restored) app.log.warn(`Database restored from snapshot ${config.snapshotFile}`);

  signalk.log = app.log;
  // The backend subscribes to device paths at their rate classes; derived paths are its own output.
  signalk.setSubscriptions(subscriptionsFor(catalogPaths().filter((p) => !p.startsWith('dataHub.')), describePath));
  signalk.on('status', () => {
    void systemStatus(app.ctx).then((s) => hub.broadcast('system.status', s));
  });

  const recorder = new Recorder(db, store, clock);
  const derived = new DerivedEngine(db, store, clock, (values) => signalk.send(values));
  let regTimer: NodeJS.Timeout | null = null;
  let regAttempts = 0;

  // Device registration: request the token until approved (or not needed).
  const registerDevice = async (): Promise<void> => {
    accessState = await stepAccessRequest(config.signalkUrl, config.dataDir, DEVICE_TOKEN);
    // A connection made before approval gets no data; reconnect with the new token.
    if (accessState === 'approved' && !signalk.usingToken) signalk.reconnect();
    if (accessState === 'pending') app.log.warn('Waiting for Signal K to approve the Data Hub device. Approve it in the Signal K admin UI.');
    // Poll quickly while someone is likely at the Signal K admin UI approving it, then back off.
    if (accessState === 'pending' || accessState === 'error') regTimer = setTimeout(() => void registerDevice(), ++regAttempts <= 30 ? 2_000 : 10_000);
  };

  return {
    app,
    db,
    store,
    hub,
    signalk,
    recorder,
    derived,
    time,
    start() {
      signalk.start();
      void registerDevice();
      recorder.start();
      derived.start();
      app.ctx.alarms.start();
    },
    async stop() {
      if (regTimer) clearTimeout(regTimer);
      app.ctx.alarms.stop();
      derived.stop();
      recorder.stop();
      recorder.finish(clock.now(), { partial: true });
      signalk.stop();
      hub.closeAll();
      await app.close();
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
    },
  };
}
