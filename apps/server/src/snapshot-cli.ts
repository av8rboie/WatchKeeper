// /usr/bin/data-hub-snapshot: HA runs this as the add-on's backup_pre hook.

import { loadConfig } from './config.js';
import { takeSnapshot } from './db/snapshot.js';

const config = loadConfig();
try {
  await takeSnapshot(config.dbFile, config.snapshotFile);
  console.log(`snapshot written to ${config.snapshotFile}`);
} catch (e) {
  console.error(`snapshot failed: ${(e as Error).message}`);
  process.exit(1);
}
