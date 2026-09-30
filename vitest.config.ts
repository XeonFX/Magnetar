import { defineConfig } from 'vitest/config'

// The Worker's tests run in workerd (apps/worker/vitest.config.ts); everything else in Node.
// Playwright's specs end in .e2e.ts, so neither picks them up.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['packages/*/src/**/*.test.ts', 'apps/web/src/**/*.test.ts'],
        },
      },
      'apps/worker/vitest.config.ts',
    ],
  },
})
