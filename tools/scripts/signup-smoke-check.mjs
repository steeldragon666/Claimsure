#!/usr/bin/env node

const DEFAULT_BASE_URL = 'https://archiveone.com.au';

function normalizeBaseUrl(raw) {
  return raw.replace(/\/+$/, '');
}

function parseArgs(argv) {
  const args = {
    baseUrl: process.env.ARCHIVEONE_BASE_URL ?? DEFAULT_BASE_URL,
    timeoutMs: Number(process.env.SMOKE_TIMEOUT_MS ?? 10_000),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base-url') {
      args.baseUrl = argv[i + 1] ?? args.baseUrl;
      i += 1;
    } else if (arg === '--timeout-ms') {
      args.timeoutMs = Number(argv[i + 1] ?? args.timeoutMs);
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
  }

  args.baseUrl = normalizeBaseUrl(args.baseUrl);
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number');
  }
  return args;
}

function printUsage() {
  console.log(`ArchiveOne signup smoke check

Usage:
  node tools/scripts/signup-smoke-check.mjs [--base-url https://archiveone.com.au]

Environment:
  ARCHIVEONE_BASE_URL   Base site URL. Defaults to ${DEFAULT_BASE_URL}
  SMOKE_TIMEOUT_MS      Per-request timeout. Defaults to 10000
`);
}

async function request(baseUrl, path, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
        ...(options?.headers ?? {}),
      },
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text.slice(0, 200);
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

function expectStatus(actual, expected) {
  return Array.isArray(expected) ? expected.includes(actual) : actual === expected;
}

async function runProbe(args, probe) {
  const result = await request(args.baseUrl, probe.path, probe.options, args.timeoutMs);
  const passed = expectStatus(result.status, probe.expectedStatus);
  return {
    ...probe,
    passed,
    actualStatus: result.status,
    body: result.body,
  };
}

const probes = [
  {
    name: 'web home loads',
    path: '/',
    expectedStatus: 200,
  },
  {
    name: 'signup page loads',
    path: '/signup',
    expectedStatus: 200,
  },
  {
    name: 'api health responds',
    path: '/healthz',
    expectedStatus: 200,
  },
  {
    name: 'signup endpoint validates empty body',
    path: '/v1/auth/signup',
    expectedStatus: 422,
    options: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    },
  },
  {
    // The legacy verify-email endpoint now returns 410 Gone since the
    // autonomous AI-gated signup pipeline (feat/auto-approve-signup) issues
    // session cookies directly on POST /v1/auth/signup. The probe is kept so
    // we can detect a regression if someone re-enables verification.
    name: 'verify-email endpoint reports legacy/gone',
    path: '/v1/auth/verify-email',
    expectedStatus: 410,
    options: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'not-a-real-token' }),
    },
  },
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`ArchiveOne signup smoke check: ${args.baseUrl}`);

  let failed = false;
  for (const probe of probes) {
    try {
      const result = await runProbe(args, probe);
      const icon = result.passed ? 'PASS' : 'FAIL';
      console.log(`${icon} ${result.name}: HTTP ${result.actualStatus}`);
      if (!result.passed) {
        failed = true;
        console.log(`  expected: ${JSON.stringify(result.expectedStatus)}`);
        console.log(`  body: ${JSON.stringify(result.body)}`);
      }
    } catch (err) {
      failed = true;
      const message = err instanceof Error ? err.message : String(err);
      console.log(`FAIL ${probe.name}: ${message}`);
    }
  }

  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
