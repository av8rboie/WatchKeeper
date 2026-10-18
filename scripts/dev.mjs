// pnpm dev: Signal K in Docker, the backend with watch, Vite, and a dev
// ingress proxy that mounts the app under /api/hassio_ingress/dev like HA.

import { spawn, spawnSync } from 'node:child_process';

const docker = spawnSync('docker', ['compose', 'up', '-d', 'signalk'], { stdio: 'inherit', shell: true });
if (docker.status !== 0) console.warn('Could not start Signal K in Docker; the backend will keep retrying.');

const env = {
  ...process.env,
  DATA_DIR: process.env.DATA_DIR ?? '.data/dev',
  SIGNALK_URL: process.env.SIGNALK_URL ?? 'http://localhost:3000',
  PORT: '8099',
  HOST: '127.0.0.1',
  // The dev proxy plays the Supervisor's ingress proxy.
  TRUSTED_PROXIES: '127.0.0.1',
};

const procs = [
  ['server', 'pnpm', ['--filter', '@watchkeeper/server', 'dev']],
  ['web', 'pnpm', ['--filter', '@watchkeeper/web', 'dev']],
  ['ingress', 'pnpm', ['--filter', '@watchkeeper/server', 'exec', 'tsx', 'scripts/dev-proxy.ts']],
].map(([name, cmd, args]) => {
  const p = spawn(cmd, args, { env, shell: true });
  const prefix = (chunk) =>
    chunk
      .toString()
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => console.log(`[${name}] ${line}`));
  p.stdout.on('data', prefix);
  p.stderr.on('data', prefix);
  p.on('exit', (code) => {
    console.log(`[${name}] exited with ${code}`);
    shutdown();
  });
  return p;
});

function shutdown() {
  for (const p of procs) if (p.exitCode === null) p.kill();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
