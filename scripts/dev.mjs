// pnpm dev: a Signal K source, the backend with watch, Vite, and a dev
// ingress proxy that mounts the app under /api/hassio_ingress/dev like HA.
//
// By default the Signal K source is the simulator (apps/sim): a catamaran
// that anchors, motors and sails, with security on and device approval
// automatic. Options:
//   pnpm dev -- --scenario sailing|motoring|anchored|mixed   (default mixed)
//   pnpm dev -- --speed 10        simulated seconds per real second
//   pnpm dev -- --real-signalk    Signal K in Docker instead (docker-compose.yml)
// SIGNALK_URL=... points the backend at any other server and starts neither.

import { spawn, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({
  options: {
    'real-signalk': { type: 'boolean', default: false },
    scenario: { type: 'string', default: 'mixed' },
    speed: { type: 'string', default: '1' },
  },
  strict: false,
});

const external = process.env.SIGNALK_URL;
const useSim = !external && !opts['real-signalk'];
// Not 3000, so the simulator never collides with a real Signal K left running.
const SIM_PORT = '3100';

if (opts['real-signalk'] && !external) {
  const docker = spawnSync('docker', ['compose', 'up', '-d', 'signalk'], { stdio: 'inherit', shell: true });
  if (docker.status !== 0) console.warn('Could not start Signal K in Docker; the backend will keep retrying.');
}

const env = {
  ...process.env,
  // Separate data per source: a token from a real Signal K means nothing to the simulator.
  DATA_DIR: process.env.DATA_DIR ?? (useSim ? '.data/dev-sim' : '.data/dev'),
  SIGNALK_URL: external ?? (useSim ? `http://127.0.0.1:${SIM_PORT}` : 'http://127.0.0.1:3000'),
  PORT: '8099',
  HOST: '127.0.0.1',
  // The dev proxy plays the Supervisor's ingress proxy.
  TRUSTED_PROXIES: '127.0.0.1',
};

const sim = ['signalk-sim', 'pnpm', ['--filter', '@watchkeeper/sim', 'start', '--port', SIM_PORT, '--scenario', String(opts.scenario), '--speed', String(opts.speed)]];
const commands = [
  ...(useSim ? [sim] : []),
  ['server', 'pnpm', ['--filter', '@watchkeeper/server', 'dev']],
  ['web', 'pnpm', ['--filter', '@watchkeeper/web', 'dev']],
  ['ingress', 'pnpm', ['--filter', '@watchkeeper/server', 'exec', 'tsx', 'scripts/dev-proxy.ts']],
];

const procs = commands.map(([name, cmd, args]) => {
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

console.log('Open http://localhost:5180/api/hassio_ingress/dev/');

function shutdown() {
  for (const p of procs) {
    if (p.exitCode !== null) continue;
    // With shell: true, kill() stops only the shell on Windows; take the whole tree.
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
    else p.kill();
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
