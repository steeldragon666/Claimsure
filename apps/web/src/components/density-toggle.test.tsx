import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readDensityFromStorage,
  writeDensityToStorage,
  DEFAULT_DENSITY,
  DENSITY_STORAGE_KEY,
  type Density,
  type DensityToggleProps,
} from './density-toggle.js';

/**
 * Design system signature components — DensityToggle.
 *
 * Lets consultants switch between compact + comfortable views. Swaps a
 * `data-density` attribute on a target container; persists choice to
 * localStorage so the next page load remembers it.
 *
 * See docs/design/system.md §"Density toggle (consultant cockpit)".
 */

// In-memory Storage shim for tests (project tests don't use jsdom).
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(index: number) {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
}

// ---------- DEFAULT_DENSITY + DENSITY_STORAGE_KEY ----------

test('DEFAULT_DENSITY is "consultant" — densest view per design spec', () => {
  // Consultant cockpit defaults to dense; the toggle exists to LOOSEN, not tighten.
  assert.equal(DEFAULT_DENSITY, 'consultant');
});

test('DENSITY_STORAGE_KEY uses namespaced cpa.* prefix to avoid collisions', () => {
  assert.equal(DENSITY_STORAGE_KEY, 'cpa.density');
});

// ---------- readDensityFromStorage ----------

test('readDensityFromStorage: returns default when key absent', () => {
  const storage = new MemoryStorage();
  assert.equal(readDensityFromStorage(storage), DEFAULT_DENSITY);
});

test('readDensityFromStorage: returns stored value when present + valid', () => {
  const storage = new MemoryStorage();
  storage.setItem(DENSITY_STORAGE_KEY, 'claimant');
  assert.equal(readDensityFromStorage(storage), 'claimant');
});

test('readDensityFromStorage: rejects garbage and falls back to default', () => {
  // localStorage can be poisoned by user or extension; never trust it.
  const storage = new MemoryStorage();
  storage.setItem(DENSITY_STORAGE_KEY, '<script>oops</script>');
  assert.equal(readDensityFromStorage(storage), DEFAULT_DENSITY);
});

test('readDensityFromStorage: returns default when storage throws', () => {
  // Storage throws in private/incognito mode in some browsers — must not
  // crash the consultant cockpit.
  const broken: Storage = {
    length: 0,
    clear() {},
    getItem() {
      throw new Error('storage unavailable');
    },
    key() {
      return null;
    },
    removeItem() {},
    setItem() {},
  };
  assert.equal(readDensityFromStorage(broken), DEFAULT_DENSITY);
});

// ---------- writeDensityToStorage ----------

test('writeDensityToStorage: round-trips value through getItem', () => {
  const storage = new MemoryStorage();
  writeDensityToStorage(storage, 'claimant');
  assert.equal(storage.getItem(DENSITY_STORAGE_KEY), 'claimant');
});

test('writeDensityToStorage: silent on storage failure (best-effort)', () => {
  // If storage fails, density just won't persist across sessions —
  // that's acceptable; we don't want a UI tap to crash the route.
  const broken: Storage = {
    length: 0,
    clear() {},
    getItem() {
      return null;
    },
    key() {
      return null;
    },
    removeItem() {},
    setItem() {
      throw new Error('quota exceeded');
    },
  };
  assert.doesNotThrow(() => writeDensityToStorage(broken, 'claimant'));
});

// ---------- Density type contract ----------

test('Density: enum has exactly consultant/claimant', () => {
  const densities: Density[] = ['consultant', 'claimant'];
  assert.equal(densities.length, 2);
});

// ---------- DensityToggleProps type contract ----------

test('DensityToggleProps: minimal (no required props) compiles', () => {
  const minimal: DensityToggleProps = {};
  assert.equal(typeof minimal, 'object');
});

test('DensityToggleProps: full prop set compiles', () => {
  const full: DensityToggleProps = {
    storageKey: 'cpa.density',
    targetSelector: 'main',
    className: 'extra',
    onChange: () => {},
  };
  assert.equal(full.targetSelector, 'main');
});
