import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    extends: [...tseslint.configs.recommendedTypeChecked, prettier],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/return-await': ['error', 'error-handling-correctness-only'],
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Test files: each package has a sibling tsconfig.test.json that
    // includes test files (the main tsconfig excludes them so the build
    // never emits test artifacts). The default `projectService: true`
    // resolves the closest tsconfig.json, which excludes test files; we
    // override with the legacy `project` glob to pick up tsconfig.test.json
    // directly. node:test's test() returns a Promise that doesn't need
    // awaiting, so disable no-floating-promises here.
    files: ['**/*.test.{ts,tsx,mts,cts}'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ['**/tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
  {
    // Agent eval drivers live outside `src/` so the package's main
    // tsconfig (which has `include: ["src/**/*"]`) does not cover them.
    // Resolve them through the dedicated `tsconfig.eval.json` instead;
    // otherwise the project service errors with "not found by the
    // project service" when lint runs from the workspace root. The
    // tests-glob block above already handles eval/**/*.test.ts via
    // tsconfig.test.json, so this override is for the non-test
    // entrypoints (run.ts, scoring.ts, run.ts in each per-agent dir).
    files: ['packages/agents/eval/**/*.ts'],
    ignores: ['packages/agents/eval/**/*.test.ts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ['packages/agents/tsconfig.eval.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/.expo/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/*.tsbuildinfo',
      // Playwright e2e specs run via Playwright's own ts loader, outside
      // the Next/tsconfig.test.json project service — type-checked rules
      // can't resolve them and lint-staged invocations from the workspace
      // root would otherwise fail with a "not found by the project service"
      // parsing error. apps/web/eslint.config.mjs already ignores e2e/**
      // when eslint runs from there; this entry keeps the root invocation
      // consistent.
      '**/e2e/**',
    ],
  },
);
