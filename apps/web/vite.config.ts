import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const backend = process.env.BACKEND_URL ?? 'http://localhost:8080';
const signalk = process.env.SIGNALK_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png'],
      manifest: {
        name: 'Data Hub',
        short_name: 'Data Hub',
        description: 'Instruments, logbook and maintenance for the boat.',
        theme_color: '#0E1A22',
        background_color: '#EEF2F3',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // App shell and fonts are precached; the app never fetches from the internet.
        globPatterns: ['**/*.{js,css,html,woff2,png,svg}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/signalk\//],
        runtimeCaching: [
          {
            // Last-loaded dashboard definitions stay available offline.
            urlPattern: ({ url }) => url.pathname.startsWith('/api/v1/dashboards'),
            handler: 'NetworkFirst',
            options: { cacheName: 'dashboards', networkTimeoutSeconds: 3 },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: backend, ws: true, changeOrigin: true },
      '/signalk': { target: signalk, ws: true, changeOrigin: true },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': { target: backend, ws: true, changeOrigin: true },
      '/signalk': { target: signalk, ws: true, changeOrigin: true },
    },
  },
});
