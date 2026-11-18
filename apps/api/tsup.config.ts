import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { server: 'src/server.ts', migrate: 'src/db/migrate.ts' },
  format: ['esm'],
  target: 'node20',
  clean: true,
  noExternal: ['@petxport/shared'],
});
