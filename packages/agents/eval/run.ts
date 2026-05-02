/**
 * Shared eval runner used by every per-agent `run.ts`.
 *
 * Reads NDJSON from `goldenPath`, calls `runOne(input)` for each case,
 * scores each result via `score(output, expected, input)`, and emits:
 *
 *   - one JSON line per case to stdout (machine-readable; pipe to `jq`
 *     or capture for offline diffing); and
 *   - a Markdown summary table to stderr (human-readable; renders cleanly
 *     in CI logs without polluting the structured stdout stream).
 *
 * Failure isolation: if `runOne` or `score` throws (e.g., transient
 * Anthropic 5xx, schema-violation), the case is recorded as failed with
 * `score: 0` and the error captured in `details.error`. The whole run
 * is NEVER aborted by a single bad case — eval suites are expected to
 * surface flaky cases without losing the rest of the report.
 *
 * The runner is deliberately I/O-isolated (only reads the golden file
 * + writes to stdout/stderr): persistence to a database, dashboard,
 * or comparison-against-baseline is the caller's job. This keeps the
 * smoke test (`run.test.ts`) trivial — fake `runOne` + a tmp NDJSON
 * file is enough.
 */

import { readFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One row in a golden NDJSON file. The shape is generic: each agent's
 * eval defines its own `<I, E>` and the framework only cares about
 * `id` and `description` for reporting.
 */
export type EvalCase<I, E> = {
  id: string;
  description: string;
  input: I;
  expected: E;
};

/** One row in the summary report. */
export type EvalResult<O, E> = {
  case_id: string;
  description: string;
  output: O | null;
  expected: E;
  score: number; // 0..1
  passed: boolean;
  details: Record<string, unknown>;
};

/**
 * Runner options.
 *
 * `passThreshold` defaults to 0.7 — empirically the right cutoff for
 * mixed-confidence enum classifiers and set-overlap scorers. Per-agent
 * runners are free to override this when their score function has
 * different semantics (e.g., the expenditure classifier sets 1.0
 * because both decision + anchor must match).
 */
export type RunEvalOpts<I, O, E> = {
  agentName: string;
  goldenPath: string;
  runOne: (input: I) => Promise<O>;
  score: (
    output: O,
    expected: E,
    input: I,
  ) => Promise<{ score: number; passed: boolean; details: Record<string, unknown> }>;
  passThreshold?: number;
};

/** Aggregate summary returned to the caller for assertion / exit-code logic. */
export type EvalSummary = {
  agentName: string;
  totalCases: number;
  passed: number;
  failed: number;
  meanScore: number;
};

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Stream-evaluate every case in `goldenPath` against `runOne` + `score`
 * and emit the structured + human-readable reports.
 */
export async function runEval<I, O, E>(opts: RunEvalOpts<I, O, E>): Promise<EvalSummary> {
  const passThreshold = opts.passThreshold ?? 0.7;
  const cases = await loadGolden<I, E>(opts.goldenPath);

  const results: EvalResult<O, E>[] = [];

  for (const c of cases) {
    const result = await runOneCase(c, opts.runOne, opts.score, passThreshold);
    results.push(result);
    process.stdout.write(JSON.stringify({ agent: opts.agentName, ...result }) + '\n');
  }

  const summary = summarise(opts.agentName, results);
  process.stderr.write(renderSummaryTable(opts.agentName, results, summary) + '\n');
  return summary;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function loadGolden<I, E>(path: string): Promise<EvalCase<I, E>[]> {
  const raw = await readFile(path, 'utf8');
  const cases: EvalCase<I, E>[] = [];
  let lineNo = 0;
  for (const line of raw.split('\n')) {
    lineNo += 1;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('//')) continue; // permit `// comment` lines
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(
        `golden file ${path} line ${lineNo}: malformed JSON (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    cases.push(parsed as EvalCase<I, E>);
  }
  return cases;
}

async function runOneCase<I, O, E>(
  c: EvalCase<I, E>,
  runOne: (input: I) => Promise<O>,
  score: (
    output: O,
    expected: E,
    input: I,
  ) => Promise<{ score: number; passed: boolean; details: Record<string, unknown> }>,
  passThreshold: number,
): Promise<EvalResult<O, E>> {
  let output: O;
  try {
    output = await runOne(c.input);
  } catch (err) {
    return {
      case_id: c.id,
      description: c.description,
      output: null,
      expected: c.expected,
      score: 0,
      passed: false,
      details: {
        error: err instanceof Error ? err.message : String(err),
        stage: 'runOne',
      },
    };
  }

  try {
    const scored = await score(output, c.expected, c.input);
    return {
      case_id: c.id,
      description: c.description,
      output,
      expected: c.expected,
      score: scored.score,
      // Honor the score function's `passed` if explicitly false; otherwise
      // fall back to the threshold convention.
      passed: scored.passed && scored.score >= passThreshold,
      details: scored.details,
    };
  } catch (err) {
    return {
      case_id: c.id,
      description: c.description,
      output,
      expected: c.expected,
      score: 0,
      passed: false,
      details: {
        error: err instanceof Error ? err.message : String(err),
        stage: 'score',
      },
    };
  }
}

function summarise<O, E>(agentName: string, results: EvalResult<O, E>[]): EvalSummary {
  const totalCases = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = totalCases - passed;
  const meanScore =
    totalCases === 0 ? 0 : results.reduce((acc, r) => acc + r.score, 0) / totalCases;
  return { agentName, totalCases, passed, failed, meanScore };
}

function renderSummaryTable<O, E>(
  agentName: string,
  results: EvalResult<O, E>[],
  summary: EvalSummary,
): string {
  // Two-line header + per-case rows + aggregate footer. Markdown table
  // renders cleanly in GitHub Actions logs and PR descriptions.
  const lines: string[] = [];
  lines.push('');
  lines.push(`### Eval results — ${agentName}`);
  lines.push('');
  lines.push('| Case | Description | Score | Passed |');
  lines.push('|------|-------------|-------|--------|');
  for (const r of results) {
    lines.push(
      `| ${r.case_id} | ${truncate(r.description, 60)} | ${r.score.toFixed(2)} | ${r.passed ? 'YES' : 'NO'} |`,
    );
  }
  lines.push('');
  lines.push(
    `**Total:** ${summary.totalCases} | **Passed:** ${summary.passed} | **Failed:** ${summary.failed} | **Mean score:** ${summary.meanScore.toFixed(2)}`,
  );
  return lines.join('\n');
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
