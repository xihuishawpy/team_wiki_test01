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
    include: ['**/*.unit.spec.ts', '**/*.component.spec.tsx'],
    environmentMatchGlobs: [['apps/web/**/*.spec.tsx', 'jsdom']],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
    },
  },
});
