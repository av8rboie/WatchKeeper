import { loadConfig } from './config.js';
import { FakeHaClient, SupervisorHaClient } from './ha/client.js';
import { createRuntime } from './runtime.js';

const config = loadConfig();
// Inside HA the Supervisor provides a token; outside it (dev) HA calls go to a fake.
const ha = process.env.SUPERVISOR_TOKEN ? new SupervisorHaClient(process.env.SUPERVISOR_TOKEN) : new FakeHaClient();

const rt = await createRuntime({ config, ha, logger: { level: config.logLevel } });
rt.start();
await rt.app.listen({ host: config.host, port: config.port });

async function shutdown(signal: string): Promise<void> {
  rt.app.log.info(`${signal}: shutting down`);
  await rt.stop();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
