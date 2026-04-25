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
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/.expo/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/*.tsbuildinfo',
    ],
  },
);
