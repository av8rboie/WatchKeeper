import { cpSync } from 'node:fs';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  // The shared package ships TypeScript source; bundle it in.
  noExternal: ['@watchkeeper/shared'],
  onSuccess: async () => {
    cpSync('src/db/migrations', 'dist/migrations', { recursive: true });
  },
});
