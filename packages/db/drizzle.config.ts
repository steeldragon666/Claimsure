import { defineConfig } from 'drizzle-kit';

// Glob picks up every src/schema/*.ts file (excluding index.ts and tests).
// Add new tables by creating a new file in src/schema/ — drizzle-kit will
// auto-discover it on the next `pnpm --filter @cpa/db generate`.
//
// Why the exclusions: drizzle-kit (CJS loader) cannot resolve the `.js`
// extension that our `module: NodeNext` + `verbatimModuleSyntax: true`
// setup requires in source-side relative imports, so it can't load
// `index.ts` (which re-exports `./system.js`). Test files are excluded
// because they import from the runtime client and aren't schema sources.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/!(*.test|index).ts',
  out: './migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://cpa:cpa@localhost:5433/cpa_dev',
  },
  verbose: true,
  strict: true,
});
