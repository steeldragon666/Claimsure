import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  ...tseslint.configs.recommendedTypeChecked,
  prettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/.turbo/**'],
  },
);
