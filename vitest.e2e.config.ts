import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@team-wiki/platform': fileURLToPath(
        new URL('./packages/platform/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['**/*.e2e.spec.ts'],
    testTimeout: 20_000,
  },
});
