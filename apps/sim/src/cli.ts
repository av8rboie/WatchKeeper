// pnpm --filter @watchkeeper/sim start -- [--port 3000] [--scenario mixed]
//   [--speed 1] [--seed 1] [--no-auth] [--manual-approve] [--host 127.0.0.1]

import { parseArgs } from 'node:util';
import { SCENARIOS } from './model.js';
import { SimServer } from './server.js';

const { values } = parseArgs({
  // Tolerate a stray `--` from `pnpm start -- ...`.
  allowPositionals: true,
  options: {
    port: { type: 'string', default: process.env.SIM_PORT ?? '3000' },
    host: { type: 'string', default: '127.0.0.1' },
    scenario: { type: 'string', default: 'mixed' },
    speed: { type: 'string', default: '1' },
    seed: { type: 'string', default: '1' },
    'no-auth': { type: 'boolean', default: false },
    'manual-approve': { type: 'boolean', default: false },
  },
});

if (!SCENARIOS[values.scenario]) {
  console.error(`Unknown scenario "${values.scenario}". One of: ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(2);
}

const sim = await SimServer.start({
  port: Number(values.port),
  host: values.host,
  speed: Number(values.speed),
  requireAuth: !values['no-auth'],
  autoApprove: !values['manual-approve'],
  model: { scenario: values.scenario, seed: Number(values.seed), start: Date.now() },
});

console.log(`Signal K simulator on ${sim.url} (scenario ${values.scenario}, ${sim.speed}x, auth ${sim.requireAuth ? 'on' : 'off'})`);
console.log(`Controls: GET ${sim.url}/sim/state, POST ${sim.url}/sim/control {"scenario":"sailing","overrides":{"environment.depth.belowKeel":1.2}}`);

const shutdown = () => void sim.stop().then(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
