/**
 * ESLint flat config — used ONLY in CI for architectural-boundary enforcement.
 * Day-to-day linting and formatting are handled by Biome.
 *
 * The boundary rules below codify the table in section 2 of the design doc.
 * If a future contributor tries to do `import { db } from '@gcr/storage'`
 * inside `@gcr/core`, this lint job fails CI — the architecture defends itself.
 *
 * Why a separate config: Biome (our day-to-day linter) doesn't know about
 * package boundaries. We don't want full ESLint in the dev loop, so we pin
 * a minimal config for CI only.
 */

import boundaries from 'eslint-plugin-boundaries';
import tsParser from '@typescript-eslint/parser';

export default [
  {
    files: ['packages/**/src/**/*.ts', 'apps/**/src/**/*.ts'],
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.test.ts',
      '**/*.d.ts',
    ],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    plugins: { boundaries },
    settings: {
      'boundaries/elements': [
        { type: 'core', pattern: 'packages/core/src/**' },
        { type: 'github', pattern: 'packages/github/src/**' },
        { type: 'reviewer', pattern: 'packages/reviewer/src/**' },
        { type: 'storage', pattern: 'packages/storage/src/**' },
        { type: 'queue', pattern: 'packages/queue/src/**' },
        { type: 'config', pattern: 'packages/config/src/**' },
        { type: 'observability', pattern: 'packages/observability/src/**' },
        { type: 'web', pattern: 'packages/web/src/**' },
        { type: 'app', pattern: 'apps/*/src/**' },
      ],
    },
    rules: {
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            // core is pure; it can only import config and observability for types
            { from: 'core', allow: ['core', 'config', 'observability'] },
            // adapters may use core's port types, plus config/observability
            { from: 'github', allow: ['github', 'core', 'config', 'observability'] },
            { from: 'reviewer', allow: ['reviewer', 'core', 'config', 'observability'] },
            { from: 'storage', allow: ['storage', 'core', 'config', 'observability'] },
            { from: 'queue', allow: ['queue', 'core', 'config', 'observability', 'storage'] },
            // utility packages
            { from: 'config', allow: ['config'] },
            { from: 'observability', allow: ['observability', 'config'] },
            { from: 'web', allow: ['web', 'core', 'observability'] },
            // composition root: apps may import everything
            {
              from: 'app',
              allow: [
                'app',
                'core',
                'github',
                'reviewer',
                'storage',
                'queue',
                'config',
                'observability',
                'web',
              ],
            },
          ],
        },
      ],
    },
  },
];
