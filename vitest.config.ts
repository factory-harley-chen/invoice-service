import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'monitor/**/*.test.ts', 'demo/**/*.test.ts'],
    exclude: ['node_modules/**', 'demo/state/**'],
  },
});
