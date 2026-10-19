import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const coreEntry: string = fileURLToPath(
  new URL('./src/index.ts', import.meta.url)
);
const kitEntry: string = fileURLToPath(
  new URL('./src/kit.ts', import.meta.url)
);

// Adapter packages under packages/ import the core by its published name; in
// the workspace that name points at the source, so tests need no build first.
export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@richardmcquiston01/error-log-adapter/kit',
        replacement: kitEntry,
      },
      { find: '@richardmcquiston01/error-log-adapter', replacement: coreEntry },
    ],
  },
});
