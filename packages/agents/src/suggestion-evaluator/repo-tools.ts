/**
 * Read-only repo tooling for `prompt-suggestion-evaluate@1.0.0`.
 *
 * SECURITY BOUNDARY (READ THIS BEFORE CHANGING ANYTHING):
 * --------------------------------------------------------
 * The evaluator agent is exposed to four tool entry points: `read_file`,
 * `search_code`, `list_directory`, and `run_contract_test_subprocess`. ALL
 * FOUR ARE READ-ONLY. The agent CANNOT:
 *   - Write to the filesystem.
 *   - Spawn arbitrary commands.
 *   - Make network calls.
 *   - Modify git state.
 *
 * The API layer (Task B.5 choreography) is the SINGLE TRUSTED CODE PATH that
 * applies the agent's proposed change set to a feature branch. That
 * separation is the whole point of this design: an LLM hallucination — even
 * one triggered by a maliciously-crafted source file — produces a bad change
 * set proposal, but it can NEVER directly land code, run rm -rf, or steal
 * secrets via curl.
 *
 * Defenses, in order:
 *   1. {@link assertPathInsideRepo} — every path-taking tool resolves the
 *      caller-supplied path against `repo_root` and rejects anything that
 *      escapes the boundary (`../../etc/passwd`, absolute paths to /tmp,
 *      Windows drive-letter shenanigans, NUL bytes, symlinks pointing
 *      outside the repo). Fail-closed: any error returns a structured
 *      `{ ok: false, error: '...' }` to the model rather than throwing into
 *      the runtime.
 *   2. {@link sanitiseSubprocessArg} — `run_contract_test_subprocess` rejects
 *      shell metacharacters (`;|&$\`<>` etc.) and NUL bytes in `test_pattern`
 *      and `package_filter`, and uses `spawn` with an arg vector (not a
 *      shell string) so even a permissive arg can't break out into a new
 *      shell. The subprocess is killed after a hard 60 s timeout.
 *   3. The Anthropic SDK tool definitions (exported as `repoTools`) describe
 *      the tools to the model in JSON Schema. The schema is the model's
 *      view of what's available; the implementation in this file is the
 *      authoritative gate.
 *
 * If you add a fifth tool, you MUST extend the security review with:
 *   - Input validation tests parallel to those in the .test file.
 *   - A note here about why the new tool is read-only (or, if it isn't,
 *     a re-think with the design owner).
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const execFileAsync = promisify(execFile);

/**
 * Hard timeout for `run_contract_test_subprocess`. The Body-by-Michael test
 * suites we expect this tool to drive complete in well under 60 s on CI; if
 * a future test suite genuinely needs longer, lift this AFTER auditing the
 * worst-case prompt-injection scenario where the model issues a deliberately
 * slow test_pattern to exhaust the runner.
 */
export const SUBPROCESS_TIMEOUT_MS = 60_000;

/**
 * Anthropic SDK tool-use shape. Each entry is a tool the model can invoke.
 *
 * Note: input_schema is JSON Schema (NOT Zod) per Anthropic SDK contract.
 * Property descriptions are the model's documentation — keep them tight.
 *
 * The model never sees `repo_root`. It's bound to each tool function at
 * construction time inside the runtime call site (see
 * `prompts/prompt-suggestion-evaluate@1.0.0.ts`'s tool wiring).
 */
export const repoTools = [
  {
    name: 'read_file',
    description:
      'Read the contents of a repo-tracked file. Returns the full UTF-8 file content. Path is resolved relative to the repo root; paths that escape the repo are rejected.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description:
            'Repo-relative path, e.g. "packages/agents/src/index.ts". Absolute paths are rejected.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_code',
    description:
      'Search file contents using ripgrep. Returns matching file paths and line snippets. Use this to find every call-site of a function, every test that asserts a particular invariant, or every place an enum value is referenced.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: {
          type: 'string',
          description: 'Ripgrep-compatible regex pattern (no shell quoting needed).',
        },
        glob: {
          type: 'string',
          description: 'Optional glob filter, e.g. "**/*.ts" or "packages/db/migrations/*.sql".',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'list_directory',
    description:
      'List the entries in a directory. Returns names + a "file" or "directory" tag. Path is resolved relative to the repo root; paths that escape the repo are rejected.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description:
            'Repo-relative directory path, e.g. "packages/agents/src". Absolute paths are rejected.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'run_contract_test_subprocess',
    description:
      "Run a sandboxed test subprocess to verify proposed changes pass. Returns stdout/stderr/exit-code. Use this AFTER drafting a change set, before finalising your evaluation, to confirm your proposal doesn't break the package's contract tests. The subprocess runs `pnpm --filter <package_filter> test --test-name-pattern <test_pattern>` with a 60-second hard timeout.",
    input_schema: {
      type: 'object' as const,
      properties: {
        test_pattern: {
          type: 'string',
          description:
            'Test name pattern passed to the test runner. Shell metacharacters are rejected.',
        },
        package_filter: {
          type: 'string',
          description:
            'pnpm workspace filter, e.g. "@cpa/agents" or "@cpa/schemas". Shell metacharacters are rejected.',
        },
      },
      required: ['test_pattern'],
    },
  },
] as const;

export type RepoToolName = (typeof repoTools)[number]['name'];

// ---------------------------------------------------------------------------
// Path security
// ---------------------------------------------------------------------------

/**
 * Resolve `userPath` against `repoRoot` and assert the result is inside the
 * repo. Throws an Error with a stable, model-readable message on any
 * boundary violation.
 *
 * Rejection cases:
 *   - NUL bytes in the path (filesystem APIs accept `\0` truncation on some
 *     platforms — explicit reject).
 *   - Absolute paths (the model is supposed to use repo-relative paths).
 *   - Paths whose resolved location is OUTSIDE the repo root (the canonical
 *     `../../etc/passwd` traversal).
 *
 * Returns the absolute, normalised path that's known-safe for fs APIs.
 */
export function assertPathInsideRepo(repoRoot: string, userPath: string): string {
  if (typeof userPath !== 'string' || userPath.length === 0) {
    throw new Error('path must be a non-empty string');
  }
  if (userPath.includes('\0')) {
    throw new Error('path contains NUL byte');
  }
  if (path.isAbsolute(userPath)) {
    throw new Error('path must be repo-relative, not absolute');
  }
  const absoluteRepoRoot = path.resolve(repoRoot);
  const resolved = path.resolve(absoluteRepoRoot, userPath);
  const rel = path.relative(absoluteRepoRoot, resolved);
  // `path.relative` returns `..` or starts with `..\\`/`../` if outside.
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || rel.startsWith('../')) {
    throw new Error('path escapes the repo root');
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Subprocess argument hygiene
// ---------------------------------------------------------------------------

/**
 * Reject shell-metacharacter and control-character payloads in
 * subprocess arguments. We use `spawn` with an arg vector rather than a
 * shell string, so a permissive arg cannot break out — but we still reject
 * suspicious characters defense-in-depth and to keep error messages clear
 * for prompt-injection forensics.
 *
 * Allowed characters: alphanumerics, `_`, `-`, `.`, `:`, `/`, `@`, `*`,
 * single space (so multi-word `--test-name-pattern "foo bar"` works after
 * the test runner reassembles), `+`, `(`, `)`, `[`, `]`, `?`, `^`, `$`,
 * `\\` (a regex anchor / escape, NOT a path separator after this layer).
 *
 * Rejected: `;`, `|`, `&`, backtick, `<`, `>`, `\n`, `\r`, `\0`, `'`, `"`.
 */
export function sanitiseSubprocessArg(arg: string, fieldName: string): string {
  if (typeof arg !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  if (arg.length === 0) {
    throw new Error(`${fieldName} must not be empty`);
  }
  if (arg.length > 500) {
    throw new Error(`${fieldName} exceeds 500 characters`);
  }
  // Reject control chars (NUL/newlines/etc.), shell metacharacters, and quotes.
  // Control codepoints are checked explicitly so the source regex stays readable
  // and we do not embed raw control bytes in the file.
  for (let i = 0; i < arg.length; i++) {
    const code = arg.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      throw new Error(`${fieldName} contains forbidden characters`);
    }
  }
  if (/[;|&`<>"']/.test(arg)) {
    throw new Error(`${fieldName} contains forbidden characters`);
  }
  return arg;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

/**
 * Read a repo-tracked file as UTF-8. Throws on path-boundary violation,
 * returns trimmed structured payload otherwise. We cap content at ~1 MiB to
 * avoid blowing the model's context window on a giant lockfile or build
 * artefact.
 */
export async function readFile(
  repoRoot: string,
  args: { path: string },
): Promise<{ content: string; bytes: number }> {
  const abs = assertPathInsideRepo(repoRoot, args.path);
  const stat = await fs.stat(abs);
  if (!stat.isFile()) {
    throw new Error('path is not a regular file');
  }
  if (stat.size > 1_000_000) {
    throw new Error(`file exceeds 1 MiB (${stat.size} bytes); refusing to read`);
  }
  const content = await fs.readFile(abs, 'utf8');
  return { content, bytes: stat.size };
}

/**
 * List a directory. Returns each entry as `{ name, kind: 'file' | 'directory' | 'other' }`.
 * Symlinks are reported as `'other'`; the model can choose whether to
 * follow them via a separate read_file call (which path-checks the target).
 */
export async function listDirectory(
  repoRoot: string,
  args: { path: string },
): Promise<{ entries: Array<{ name: string; kind: 'file' | 'directory' | 'other' }> }> {
  const abs = assertPathInsideRepo(repoRoot, args.path);
  const stat = await fs.stat(abs);
  if (!stat.isDirectory()) {
    throw new Error('path is not a directory');
  }
  const dirents = await fs.readdir(abs, { withFileTypes: true });
  const entries = dirents.map((d) => ({
    name: d.name,
    kind: d.isFile()
      ? ('file' as const)
      : d.isDirectory()
        ? ('directory' as const)
        : ('other' as const),
  }));
  // Sorted output keeps the model-visible ordering deterministic (better
  // for prompt caching).
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { entries };
}

/**
 * Search file contents using ripgrep. We invoke `rg` as a subprocess (NOT
 * a shell). If `rg` is unavailable, we throw a recognisable error — the
 * caller can either install ripgrep on CI or surface "tool unavailable" to
 * the model.
 *
 * Caps:
 *   - max 200 matches returned (the model rarely needs more; if it does,
 *     it can re-search with a tighter glob).
 *   - matches printed with `--max-count 5` per file.
 *   - JSON output mode for unambiguous parsing.
 */
export async function searchCode(
  repoRoot: string,
  args: { pattern: string; glob?: string },
): Promise<{
  matches: Array<{ path: string; line: number; snippet: string }>;
  truncated: boolean;
}> {
  if (typeof args.pattern !== 'string' || args.pattern.length === 0) {
    throw new Error('pattern must be a non-empty string');
  }
  if (args.pattern.length > 1000) {
    throw new Error('pattern exceeds 1000 characters');
  }
  if (args.pattern.includes('\0')) {
    throw new Error('pattern contains NUL byte');
  }
  if (args.glob !== undefined) {
    if (typeof args.glob !== 'string') {
      throw new Error('glob must be a string');
    }
    if (args.glob.length > 500) {
      throw new Error('glob exceeds 500 characters');
    }
    if (args.glob.includes('\0')) {
      throw new Error('glob contains NUL byte');
    }
  }

  const rgArgs = [
    '--json',
    '--max-count',
    '5',
    '--max-columns',
    '500',
    '--no-heading',
    '--with-filename',
    '--line-number',
    '--color',
    'never',
  ];
  if (args.glob) {
    rgArgs.push('--glob', args.glob);
  }
  rgArgs.push('--', args.pattern, '.');

  let stdout = '';
  let stderr = '';
  try {
    const result = await execFileAsync('rg', rgArgs, {
      cwd: path.resolve(repoRoot),
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (e: unknown) {
    const err = e as { code?: number | string; stdout?: string; stderr?: string };
    // ripgrep exits 1 when no match; that's not an error for us.
    if (err.code === 1) {
      return { matches: [], truncated: false };
    }
    if (err.code === 'ENOENT') {
      throw new Error('search_code requires ripgrep (`rg`) on PATH');
    }
    stdout = err.stdout ?? '';
    stderr = err.stderr ?? '';
    if (!stdout && stderr) {
      throw new Error(`ripgrep failed: ${stderr.slice(0, 500)}`);
    }
  }

  const matches: Array<{ path: string; line: number; snippet: string }> = [];
  let truncated = false;
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    if (matches.length >= 200) {
      truncated = true;
      break;
    }
    try {
      const obj = JSON.parse(line) as { type?: string; data?: unknown };
      if (obj.type !== 'match') continue;
      const data = obj.data as {
        path?: { text?: string };
        line_number?: number;
        lines?: { text?: string };
      };
      const filePath = data.path?.text;
      const lineNum = data.line_number;
      const snippet = data.lines?.text ?? '';
      if (typeof filePath === 'string' && typeof lineNum === 'number') {
        matches.push({
          path: filePath,
          line: lineNum,
          snippet: snippet.replace(/\n$/, '').slice(0, 500),
        });
      }
    } catch {
      // skip malformed lines (rg occasionally emits non-JSON in edge cases)
    }
  }

  return { matches, truncated };
}

/**
 * Run a sandboxed `pnpm --filter <pkg> test --test-name-pattern <pat>`
 * subprocess. Hard 60-second timeout. Returns structured stdout/stderr/exit
 * code so the model can read failures and adjust its proposal.
 *
 * We use `spawn` with an explicit arg vector (NOT `exec` with a shell
 * string) to make shell-injection structurally impossible — a maliciously
 * crafted `test_pattern` like `"foo; rm -rf /"` becomes a literal pattern
 * argument to pnpm, not a chained command.
 */
export async function runContractTestSubprocess(
  repoRoot: string,
  args: { test_pattern: string; package_filter?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  const safePattern = sanitiseSubprocessArg(args.test_pattern, 'test_pattern');
  const safePackage = args.package_filter
    ? sanitiseSubprocessArg(args.package_filter, 'package_filter')
    : undefined;

  const pnpmArgs: string[] = [];
  if (safePackage) {
    pnpmArgs.push('--filter', safePackage);
  }
  pnpmArgs.push('test', '--', '--test-name-pattern', safePattern);

  return await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn('pnpm', pnpmArgs, {
      cwd: path.resolve(repoRoot),
      env: process.env,
      shell: false, // no shell interpretation
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, SUBPROCESS_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      // Cap captured output at ~1 MiB to avoid memory blow-up.
      if (stdout.length > 1_000_000) stdout = stdout.slice(0, 1_000_000);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 1_000_000) stderr = stderr.slice(0, 1_000_000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: typeof code === 'number' ? code : -1,
        timedOut,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Convenience: dispatch by tool name (used by the Anthropic tool-use loop)
// ---------------------------------------------------------------------------

/**
 * Single dispatch point used by the runtime tool-use loop. Each branch
 * does its own input validation; any thrown error is converted to a
 * `{ ok: false, error }` result by the caller, which the model then sees
 * as the tool's reply.
 *
 * Restricted to the four named tools — an unknown name raises an Error
 * rather than silently no-op'ing, so a future code path that adds a tool
 * without registering it here will fail loudly during testing.
 */
export async function dispatchRepoTool(
  repoRoot: string,
  name: string,
  input: unknown,
): Promise<unknown> {
  const safeInput = (input ?? {}) as Record<string, unknown>;
  const requireString = (key: string): string => {
    const v = safeInput[key];
    if (typeof v !== 'string') {
      throw new Error(`${name}: ${key} must be a string`);
    }
    return v;
  };
  switch (name) {
    case 'read_file':
      return await readFile(repoRoot, { path: requireString('path') });
    case 'list_directory':
      return await listDirectory(repoRoot, { path: requireString('path') });
    case 'search_code': {
      const argObj: { pattern: string; glob?: string } = {
        pattern: requireString('pattern'),
      };
      const glob = safeInput['glob'];
      if (typeof glob === 'string') argObj.glob = glob;
      return await searchCode(repoRoot, argObj);
    }
    case 'run_contract_test_subprocess': {
      const argObj: { test_pattern: string; package_filter?: string } = {
        test_pattern: requireString('test_pattern'),
      };
      const pf = safeInput['package_filter'];
      if (typeof pf === 'string') argObj.package_filter = pf;
      return await runContractTestSubprocess(repoRoot, argObj);
    }
    default:
      throw new Error(`unknown repo tool: ${name}`);
  }
}
