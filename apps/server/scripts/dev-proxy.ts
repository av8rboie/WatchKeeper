// Dev ingress: http://localhost:5180/api/hassio_ingress/dev/ behaves like HA
// ingress. API calls go to the backend with the prefix stripped and HA user
// headers added; everything else goes to Vite, whose dev base is the prefix.
// Switch users with a `ha_user=id|Name` cookie.

import { startIngressProxy } from '../test/helpers/ingressProxy.js';

const port = Number(process.env.PROXY_PORT ?? 5180);
await startIngressProxy({
  port,
  prefix: '/api/hassio_ingress/dev',
  target: process.env.BACKEND_URL ?? 'http://127.0.0.1:8099',
  webTarget: process.env.VITE_URL ?? 'http://127.0.0.1:5173',
  defaultUser: { id: process.env.DEV_HA_USER_ID ?? 'dev-skipper', name: process.env.DEV_HA_USER_NAME ?? 'Dev Skipper' },
});
console.log(`Data Hub (dev ingress): http://localhost:${port}/api/hassio_ingress/dev/`);
