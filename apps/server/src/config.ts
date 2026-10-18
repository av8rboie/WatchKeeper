import { join, resolve } from 'node:path';

export interface Config {
  signalkUrl: string;
  host: string;
  port: number;
  dataDir: string;
  configDir: string;
  dbFile: string;
  /** Built PWA to serve; null to skip static serving (dev uses Vite). */
  webDist: string | null;
  cookieSecure: boolean;
  logLevel: string;
  version: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = resolve(env.DATA_DIR ?? '/var/lib/data-hub');
  return {
    signalkUrl: (env.SIGNALK_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
    host: env.HOST ?? '0.0.0.0',
    port: Number(env.PORT ?? 8080),
    dataDir,
    configDir: resolve(env.CONFIG_DIR ?? join(dataDir, 'config')),
    dbFile: env.DB_FILE ?? join(dataDir, 'data-hub.db'),
    webDist: env.WEB_DIST ? resolve(env.WEB_DIST) : null,
    cookieSecure: env.COOKIE_SECURE !== 'false',
    logLevel: env.LOG_LEVEL ?? 'info',
    version: env.APP_VERSION ?? '0.1.0',
  };
}
