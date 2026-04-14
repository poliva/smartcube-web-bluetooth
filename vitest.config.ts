import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
    reporters: ['default'],
    restoreMocks: true,
    clearMocks: true,
    mockReset: true,
  },
});

