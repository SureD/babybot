import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['apps/*/src/**/*.ts', 'packages/*/src/**/*.ts'],
      reporter: ['text', 'html'],
    },
  },
});

