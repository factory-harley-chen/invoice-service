import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  // Without this, vite puts its cache in demo/loop/node_modules.
  cacheDir: resolve(import.meta.dirname, '../../node_modules/.vite'),
  test: {
    include: ['**/*.test.ts'],
    env: { TZ: 'UTC' },
  },
});
