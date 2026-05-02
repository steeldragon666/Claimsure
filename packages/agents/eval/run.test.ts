import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runEval } from './run.js';

let tmpDir: string;
let stdoutCapture: string[];
let stderrCapture: string[];
let originalStdoutWrite: typeof process.stdout.write;
let originalStderrWrite: typeof process.stderr.write;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'eval-runner-'));
  stdoutCapture = [];
  stderrCapture = [];
  originalStdoutWrite = process.stdout.write.bind(process.stdout);
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  // Hijack stdout/stderr so the JSON lines + summary table don't pollute
  // the test runner's own output. We assert against the captured strings.
  const writeImpl: typeof process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdoutCapture.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  };
  const errImpl: typeof process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderrCapture.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  };
  process.stdout.write = writeImpl;
  process.stderr.write = errImpl;
});

afterEach(async () => {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  await rm(tmpDir, { recursive: true, force: true });
});

test('runEval: aggregates 2 fake cases and emits stdout JSON + stderr table', async () => {
  const goldenPath = join(tmpDir, 'golden.ndjson');
  await writeFile(
    goldenPath,
    [
      JSON.stringify({ id: 'c1', description: 'pass', input: { v: 1 }, expected: 1 }),
      JSON.stringify({ id: 'c2', description: 'fail', input: { v: 2 }, expected: 99 }),
    ].join('\n'),
  );

  const summary = await runEval<{ v: number }, number, number>({
    agentName: 'fake-agent',
    goldenPath,
    runOne: async (input) => Promise.resolve(input.v),
    score: async (output, expected) => {
      const correct = output === expected;
      return Promise.resolve({
        score: correct ? 1 : 0,
        passed: correct,
        details: { matched: correct },
      });
    },
  });

  assert.equal(summary.totalCases, 2);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.meanScore, 0.5);

  const stdoutJoined = stdoutCapture.join('');
  // Two JSON lines on stdout, one per case.
  const stdoutLines = stdoutJoined.split('\n').filter((l) => l.length > 0);
  assert.equal(stdoutLines.length, 2);
  const parsed1 = JSON.parse(stdoutLines[0] ?? '{}') as Record<string, unknown>;
  assert.equal(parsed1.case_id, 'c1');
  assert.equal(parsed1.passed, true);
  const parsed2 = JSON.parse(stdoutLines[1] ?? '{}') as Record<string, unknown>;
  assert.equal(parsed2.case_id, 'c2');
  assert.equal(parsed2.passed, false);

  const stderrJoined = stderrCapture.join('');
  // Markdown summary table on stderr.
  assert.ok(stderrJoined.includes('Eval results — fake-agent'));
  assert.ok(stderrJoined.includes('| c1 |'));
  assert.ok(stderrJoined.includes('| c2 |'));
  assert.ok(stderrJoined.includes('Mean score:'));
});

test('runEval: runOne throwing is captured as failure, not aborting the run', async () => {
  const goldenPath = join(tmpDir, 'golden.ndjson');
  await writeFile(
    goldenPath,
    [
      JSON.stringify({ id: 'c1', description: 'throws', input: 'boom', expected: null }),
      JSON.stringify({ id: 'c2', description: 'ok', input: 'ok', expected: null }),
    ].join('\n'),
  );

  const summary = await runEval<string, string, null>({
    agentName: 'fake-agent',
    goldenPath,
    runOne: async (input) => {
      if (input === 'boom') throw new Error('simulated failure');
      return Promise.resolve(input);
    },
    score: async () => Promise.resolve({ score: 1, passed: true, details: {} }),
  });

  assert.equal(summary.totalCases, 2);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 1);

  const stdoutLines = stdoutCapture
    .join('')
    .split('\n')
    .filter((l) => l.length > 0);
  const errCase = JSON.parse(stdoutLines[0] ?? '{}') as Record<string, unknown>;
  assert.equal(errCase.passed, false);
  assert.equal(errCase.score, 0);
  const details = errCase.details as Record<string, unknown>;
  assert.equal(details.stage, 'runOne');
  assert.match(String(details.error), /simulated failure/);
});

test('runEval: ignores blank lines and `//` comment lines in golden file', async () => {
  const goldenPath = join(tmpDir, 'golden.ndjson');
  await writeFile(
    goldenPath,
    [
      '// header comment',
      '',
      JSON.stringify({ id: 'c1', description: 'real', input: 1, expected: 1 }),
      '',
    ].join('\n'),
  );

  const summary = await runEval<number, number, number>({
    agentName: 'fake-agent',
    goldenPath,
    runOne: async (input) => Promise.resolve(input),
    score: async (output, expected) =>
      Promise.resolve({ score: output === expected ? 1 : 0, passed: true, details: {} }),
  });

  assert.equal(summary.totalCases, 1);
});
