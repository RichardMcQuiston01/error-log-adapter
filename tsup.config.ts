import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/kit.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  outExtension({ format }) {
    return { js: format === 'esm' ? '.mjs' : '.cjs' };
  },
});
