import { cpSync } from 'node:fs';
import { defineConfig } from 'tsup';

export default defineConfig({
  // main: the add-on process. snapshot: the backup_pre hook (/usr/bin/data-hub-snapshot).
  entry: { main: 'src/main.ts', snapshot: 'src/snapshot-cli.ts' },
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
