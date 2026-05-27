/**
 * `{{var}}`-style template renderer for the engagement letter and any
 * other per-tenant text-with-placeholders surfaces.
 *
 * **Scope:** the simplest substitution that gets the job done — match
 * `{{name}}` (optional whitespace inside the braces) and replace with
 * `vars[name]` if the key is present, otherwise leave the placeholder
 * untouched. No conditionals, no loops, no nested objects, no escape
 * syntax — anything richer is a sign we should be reaching for a real
 * templating engine.
 *
 * **Why pure / no I/O:** this is called at engagement-letter send time
 * inside a transaction. A throwing template engine (file-system access,
 * partial loading, schema validation) would smear failure modes across
 * the request boundary. Keep it deterministic: same input → same output,
 * never throws.
 *
 * **Variable names** must be valid JS-ish identifiers
 * (`[A-Za-z_][A-Za-z0-9_]*`). Anything more permissive opens up
 * injection ambiguity (e.g. `{{ foo.bar }}` would look like a property
 * path but isn't supported); reject by simply not matching.
 *
 * **Missing keys** leave the placeholder in place. This is deliberate:
 * silently emitting an empty string would erase the placeholder and
 * make typos invisible at QA time. Operators who upload a template with
 * an unknown `{{xxx}}` see it verbatim in the rendered output and can
 * trace it back.
 *
 * **No HTML escaping** — the output is markdown headed to a PDF
 * renderer, not directly to a browser. The downstream renderer is
 * responsible for any escaping it needs.
 */

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export function renderTemplate(md: string, vars: Record<string, string>): string {
  return md.replace(PLACEHOLDER_RE, (match, name: string) => {
    const value = vars[name];
    // `Object.prototype.hasOwnProperty` is robust against `vars` being a
    // null-prototype object too (`Object.create(null)`), which is a
    // legitimate caller pattern when the variable bag comes straight off
    // a DB row.
    if (Object.prototype.hasOwnProperty.call(vars, name) && typeof value === 'string') {
      return value;
    }
    return match;
  });
}
