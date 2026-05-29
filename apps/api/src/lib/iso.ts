/**
 * Coerce a Postgres timestamp into a canonical ISO-8601 string.
 *
 * postgres-js in this codebase returns `timestamp`/`timestamptz` columns as
 * STRINGS (not JS Date objects), so calling `.toISOString()` directly on a
 * value read back from the database throws `toISOString is not a function`
 * and 500s the request. This helper accepts either a string or a Date (route
 * code sometimes passes a JS-computed Date) and always returns ISO-8601.
 *
 * Use `toIso` for nullable columns (returns null for null/undefined) and
 * `toIsoRequired` for NOT-NULL values where a string is guaranteed.
 */
export function toIso(v: Date | string | null | undefined): string | null {
  return v == null ? null : new Date(v).toISOString();
}

export function toIsoRequired(v: Date | string): string {
  return new Date(v).toISOString();
}
