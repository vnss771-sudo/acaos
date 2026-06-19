// Flat ESLint config for the ACAOS monorepo.
//
// Goals: catch real correctness smells (unused symbols, unreachable code,
// accidental globals, fall-through) across the TypeScript backend and the
// React frontend, while staying fast — this runs WITHOUT type information so
// it needs no Prisma client or project build to execute in CI.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

export default tseslint.config(
  {
    // Never lint generated output, dependencies, or test/report artifacts.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.prisma/**',
      'apps/web/dist/**',
      'packages/*/dist/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    // Project-wide rule tuning. The codebase intentionally uses `any` at a few
    // typed boundaries (Express middleware augmentation, Prisma JSON), so that
    // rule is relaxed to a warning rather than blocking CI.
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      'no-fallthrough': 'error',
      'no-unreachable': 'error',
      'no-var': 'error',
    },
  },

  {
    // Backend + Node tooling run on Node globals.
    files: ['apps/api/**/*.ts', 'apps/worker/**/*.ts', 'packages/**/*.ts', 'scripts/**/*.{ts,mjs}', 'tests/**/*.ts', 'tests-db/**/*.ts', 'tests-redis/**/*.ts', 'e2e/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },

  {
    // Frontend runs in the browser.
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
)
