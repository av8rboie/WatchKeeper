import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  signalkUrl: string;
  host: string;
  /** Ingress port; the add-on exposes nothing else. */
  port: number;
  /** The add-on's persistent volume (/data in HA). */
  dataDir: string;
  dbFile: string;
  snapshotFile: string;
  filesDir: string;
  /** Built web app to serve; null to skip (dev uses Vite). */
  webDist: string | null;
  /** Addresses allowed to send ingress user headers (the Supervisor's proxy). */
  trustedProxies: string[];
  sounderGpio: number | null;
  upsGpio: number | null;
  logLevel: string;
  version: string;
}

interface AddonOptions {
  signalk_url?: string;
  sounder_gpio?: number | null;
  ups_gpio?: number | null;
  log_level?: string;
}

/** HA's ingress proxy on the hassio network. */
export const SUPERVISOR_INGRESS_PROXY = '172.30.32.2';

const DEFAULT_WEB_DIST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

/**
 * Add-on options come from /data/options.json (written by the Supervisor from
 * the add-on configuration). Environment variables override them for dev and
 * tests.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = resolve(env.DATA_DIR ?? '/data');
  const optionsFile = env.OPTIONS_FILE ?? join(dataDir, 'options.json');
  const opts: AddonOptions = existsSync(optionsFile) ? (JSON.parse(readFileSync(optionsFile, 'utf8')) as AddonOptions) : {};
  const int = (v: string | undefined, fallback: number | null | undefined) => (v !== undefined && v !== '' ? Number(v) : (fallback ?? null));
  // The built app sits beside the server in the image (/app/web). In dev the
  // same relative path is the web source folder, which has no assets/: skip it.
  const isBuilt = existsSync(join(DEFAULT_WEB_DIST, 'index.html')) && existsSync(join(DEFAULT_WEB_DIST, 'assets'));
  const webDist = env.WEB_DIST ?? (isBuilt ? DEFAULT_WEB_DIST : '');
  return {
    signalkUrl: (env.SIGNALK_URL ?? opts.signalk_url ?? 'http://localhost:3000').replace(/\/$/, ''),
    host: env.HOST ?? '0.0.0.0',
    port: Number(env.PORT ?? 8099),
    dataDir,
    dbFile: env.DB_FILE ?? join(dataDir, 'data-hub.db'),
    snapshotFile: join(dataDir, 'snapshot', 'data-hub.db'),
    filesDir: join(dataDir, 'files'),
    webDist: webDist ? resolve(webDist) : null,
    trustedProxies: (env.TRUSTED_PROXIES ?? SUPERVISOR_INGRESS_PROXY).split(',').map((s) => s.trim()).filter(Boolean),
    sounderGpio: int(env.SOUNDER_GPIO, opts.sounder_gpio),
    upsGpio: int(env.UPS_GPIO, opts.ups_gpio),
    logLevel: env.LOG_LEVEL ?? opts.log_level ?? 'info',
    version: env.APP_VERSION ?? '0.1.0',
  };
}
