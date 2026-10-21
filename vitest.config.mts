import { baseVitestConfig } from '@jabraf/dev/vitest';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  baseVitestConfig({ coverage: true }),
  defineConfig({
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
      coverage: {
        include: ['src/**/*.ts'],
        exclude: [
          'src/**/*.d.ts',
          'src/**/*.test.ts',
          'src/**/__tests__/**',
          'src/cli.ts',
          'src/index.ts'
        ],
        thresholds: {
          branches: 65,
          functions: 80,
          lines: 80,
          statements: 80
        }
      }
    }
  })
);
