import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/** Dev only: the prefix the dev ingress proxy mounts the app under. */
export const DEV_INGRESS_PREFIX = '/api/hassio_ingress/dev';

/**
 * In production the backend injects <base href> from HA's X-Ingress-Path.
 * The Vite dev server does the same for the fixed dev prefix, so the app
 * resolves every URL the same way in both.
 */
const devBase = (): Plugin => ({
  name: 'data-hub-dev-base',
  apply: 'serve',
  transformIndexHtml: (html) => html.replace('<head>', `<head><base href="${DEV_INGRESS_PREFIX}/">`),
});

export default defineConfig(({ command }) => ({
  // Ingress mounts the app at a path HA chooses: nothing may be absolute.
  base: command === 'build' ? './' : `${DEV_INGRESS_PREFIX}/`,
  plugins: [react(), devBase()],
  build: { assetsDir: 'assets' },
  // 127.0.0.1, not localhost: Node resolves localhost to ::1 on some systems and the dev proxy dials IPv4.
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
}));
