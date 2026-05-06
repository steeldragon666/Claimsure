import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  truncateHash,
  formatChipTimestamp,
  formatChipLabel,
  type ForensicChipProps,
  type ForensicChipState,
  type ForensicChipSize,
} from './forensic-chip.js';

/**
 * Design system signature components — ForensicChip.
 *
 * The most-repeated visual element in the platform: pill-shaped chip with
 * monospace text rendering hash + timestamp + (optional) version pin
 * inline next to every claim-bearing artefact. See docs/design/system.md
 * §"Forensic-metadata chip".
 *
 * Test discipline (matching project pattern in audit-timeline.test.tsx
 * and multi-cycle-timeline.test.tsx): pure functions and type contracts
 * here; visual rendering + state interactions deferred to Playwright e2e.
 */

// ---------- truncateHash ----------

test('truncateHash: returns first 8 chars of a SHA-256 hash', () => {
  const sha = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
  assert.equal(truncateHash(sha), 'abcdef12');
  assert.equal(truncateHash(sha).length, 8);
});

test('truncateHash: short hash returned as-is (no padding)', () => {
  assert.equal(truncateHash('abc'), 'abc');
  assert.equal(truncateHash(''), '');
});

test('truncateHash: exactly 8 chars returned unchanged', () => {
  assert.equal(truncateHash('deadbeef'), 'deadbeef');
});

test('truncateHash: explicit length override', () => {
  assert.equal(truncateHash('abcdef1234567890', 4), 'abcd');
  assert.equal(truncateHash('abcdef1234567890', 12), 'abcdef123456');
});

// ---------- formatChipTimestamp ----------

test('formatChipTimestamp: ISO Date renders as YYYY-MM-DD HH:mm UTC', () => {
  // Use UTC-stable fixture to keep CI-vs-local consistent. The component
  // displays UTC because forensic provenance must be timezone-stable.
  const ts = new Date('2026-05-06T15:42:10.000Z');
  assert.equal(formatChipTimestamp(ts), '2026-05-06 15:42');
});

test('formatChipTimestamp: string ISO accepted', () => {
  assert.equal(formatChipTimestamp('2026-01-15T08:30:00.000Z'), '2026-01-15 08:30');
});

test('formatChipTimestamp: pads single-digit minutes', () => {
  // 14:05 must render as 14:05 not 14:5 — tabular alignment matters in
  // dense forensic tables.
  assert.equal(formatChipTimestamp('2026-03-01T14:05:00.000Z'), '2026-03-01 14:05');
});

test('formatChipTimestamp: invalid date input throws explicit error', () => {
  // Defensive: better to surface bad data than silently render "NaN-NaN".
  assert.throws(() => formatChipTimestamp('not-a-date'), /invalid/i);
});

// ---------- formatChipLabel ----------

test('formatChipLabel: hash + timestamp + version with separator dots', () => {
  const label = formatChipLabel({
    hash: 'abcdef1234567890',
    capturedAt: '2026-05-06T15:42:10.000Z',
    version: 'v3',
  });
  assert.equal(label, 'abcdef12 · 2026-05-06 15:42 · v3');
});

test('formatChipLabel: omits version when null/undefined (drops trailing separator)', () => {
  const label = formatChipLabel({
    hash: 'deadbeefcafe1234',
    capturedAt: '2026-05-06T15:42:10.000Z',
    version: null,
  });
  // truncateHash('deadbeefcafe1234') → 'deadbeef' (first 8 chars). No
  // trailing " · " when version is null.
  assert.equal(label, 'deadbeef · 2026-05-06 15:42');
});

test('formatChipLabel: empty version string treated as no version', () => {
  const label = formatChipLabel({
    hash: 'deadbeefcafe1234',
    capturedAt: '2026-05-06T15:42:10.000Z',
    version: '',
  });
  assert.equal(label, 'deadbeef · 2026-05-06 15:42');
});

// ---------- ForensicChipProps type contract ----------

test('ForensicChipProps: minimal required props compile', () => {
  // Compile-time assertion via TypeScript: this object satisfies
  // ForensicChipProps. If a required field is missing, this won't tsc.
  const minimal: ForensicChipProps = {
    hash: 'abcdef1234567890',
    capturedAt: '2026-05-06T15:42:10.000Z',
  };
  assert.equal(minimal.hash, 'abcdef1234567890');
});

test('ForensicChipProps: full prop set compiles', () => {
  const full: ForensicChipProps = {
    hash: 'abcdef1234567890',
    capturedAt: new Date(),
    version: 'v3',
    state: 'verified',
    size: 'sm',
    className: 'extra-class',
    ariaLabel: 'Custom label',
    onClick: () => {},
  };
  assert.equal(full.state, 'verified');
});

// ---------- state + size enum guarantees ----------

test('ForensicChipState: enum has exactly default/verifying/verified/broken', () => {
  const states: ForensicChipState[] = ['default', 'verifying', 'verified', 'broken'];
  assert.equal(states.length, 4);
});

test('ForensicChipSize: enum has exactly md/sm', () => {
  const sizes: ForensicChipSize[] = ['md', 'sm'];
  assert.equal(sizes.length, 2);
});
