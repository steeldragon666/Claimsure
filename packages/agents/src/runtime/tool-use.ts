import type Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import type { ToolDef } from './types.js';

/**
 * Minimal zod -> JSON schema converter.
 *
 * Only handles the subset the classifier prompt needs (object root, string +
 * maxLength, number + min/max, enum, nullable, optional). Add more cases only
 * when a future test fails — keeping this small avoids pulling in
 * `zod-to-json-schema` as a dependency.
 *
 * The `(schema as { _def: ... })._def` access is necessary because zod does
 * not export the internal definition shape; the cast is the documented escape
 * hatch when introspecting schemas.
 */
function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = (schema as { _def: { typeName: string } })._def;
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = (schema as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        properties[k] = zodToJsonSchema(v);
        if (!(v.isOptional() || v.isNullable())) required.push(k);
      }
      const obj: Record<string, unknown> = { type: 'object', properties, required };
      // Honor `.strict()` — Zod sets `unknownKeys: 'strict'` on the def,
      // which means "reject unknown keys" at parse time. The equivalent
      // JSON-Schema signal to the model is `additionalProperties: false`.
      // This matters for tool-use forcing functions (e.g. preventing the
      // model from double-wrapping a discriminated-union payload). Other
      // unknownKeys values (`strip` / `passthrough`) leave additionalProperties
      // unspecified so the model isn't constrained when the Zod side won't be.
      const unknownKeys = (def as { unknownKeys?: string }).unknownKeys;
      if (unknownKeys === 'strict') obj.additionalProperties = false;
      return obj;
    }
    case 'ZodDiscriminatedUnion':
    case 'ZodUnion': {
      // Anthropic's tool API does NOT accept `oneOf`/`anyOf`/`allOf` at
      // any level of the `input_schema` (returns 400). So we flatten
      // unions-of-objects into a single object schema with merged
      // properties — losing some structural enforcement but the Zod
      // post-parse re-validates the discriminated invariants.
      //
      // For mixed unions (rare; non-object branches) we fall back to
      // emitting `oneOf` — that won't work as a tool root but might be
      // accepted in non-Anthropic JSON-Schema contexts. The shared
      // `callWithToolUse` callers should design tool roots as object
      // (or discriminated-union-of-objects).
      const options = (def as unknown as { options: z.ZodTypeAny[] }).options;
      const branches = options.map((o) => zodToJsonSchema(o));
      const allObjects = branches.every((b) => b['type'] === 'object');
      if (!allObjects) return { oneOf: branches };

      // Flatten union of objects.
      //   - Discriminator key: every branch has a `const` here → render
      //     as `{ type, enum: [val, ...] }` so the model sees the
      //     allowed values rather than just one branch's literal.
      //   - Branch-specific keys: included, marked optional.
      //   - Shared keys with identical sub-shapes: kept as-is.
      //   - Shared keys with conflicting sub-shapes: last-wins (rare;
      //     Zod re-validates so this is just a model hint).
      //   - Required: only keys present in `required` of EVERY branch.
      //   - `additionalProperties: false` if every branch has it.
      const properties: Record<string, Record<string, unknown>> = {};
      const requiredCounts = new Map<string, number>();
      let allStrict = true;
      for (const b of branches) {
        const props = (b['properties'] ?? {}) as Record<string, Record<string, unknown>>;
        const req = (b['required'] ?? []) as string[];
        for (const [k, v] of Object.entries(props)) properties[k] = v;
        for (const k of req) requiredCounts.set(k, (requiredCounts.get(k) ?? 0) + 1);
        if (b['additionalProperties'] !== false) allStrict = false;
      }
      // Discriminator detection: keys where every branch's sub-schema
      // has a `const` value. Hoist those to an enum.
      for (const k of Object.keys(properties)) {
        const consts: unknown[] = [];
        for (const b of branches) {
          const props = (b['properties'] ?? {}) as Record<string, Record<string, unknown>>;
          const v = props[k];
          if (v && 'const' in v) consts.push(v.const);
        }
        if (consts.length === branches.length) {
          const t = typeof consts[0];
          properties[k] =
            t === 'string'
              ? { type: 'string', enum: consts }
              : t === 'number'
                ? { type: 'number', enum: consts }
                : t === 'boolean'
                  ? { type: 'boolean', enum: consts }
                  : { enum: consts };
        }
      }
      const merged: Record<string, unknown> = {
        type: 'object',
        properties,
        required: Array.from(requiredCounts.entries())
          .filter(([, count]) => count === branches.length)
          .map(([k]) => k),
      };
      if (allStrict) merged['additionalProperties'] = false;
      return merged;
    }
    case 'ZodString': {
      const checks = (def as { checks?: { kind: string; value?: number }[] }).checks ?? [];
      const obj: Record<string, unknown> = { type: 'string' };
      for (const c of checks) if (c.kind === 'max' && c.value) obj.maxLength = c.value;
      return obj;
    }
    case 'ZodNumber': {
      const checks = (def as { checks?: { kind: string; value?: number }[] }).checks ?? [];
      const obj: Record<string, unknown> = { type: 'number' };
      for (const c of checks) {
        if (c.kind === 'min' && c.value !== undefined) obj.minimum = c.value;
        if (c.kind === 'max' && c.value !== undefined) obj.maximum = c.value;
      }
      return obj;
    }
    case 'ZodEnum': {
      return { type: 'string', enum: (def as unknown as { values: string[] }).values };
    }
    case 'ZodNullable': {
      const inner = zodToJsonSchema((def as unknown as { innerType: z.ZodTypeAny }).innerType);
      return { ...inner, nullable: true };
    }
    case 'ZodOptional': {
      return zodToJsonSchema((def as unknown as { innerType: z.ZodTypeAny }).innerType);
    }
    case 'ZodArray': {
      const itemDef = (def as unknown as { type: z.ZodTypeAny }).type;
      const obj: Record<string, unknown> = {
        type: 'array',
        items: zodToJsonSchema(itemDef),
      };
      // Array-level checks: { kind: 'min', value }, { kind: 'max', value }.
      const checks = def as unknown as {
        minLength?: { value: number };
        maxLength?: { value: number };
      };
      if (checks.minLength) obj.minItems = checks.minLength.value;
      if (checks.maxLength) obj.maxItems = checks.maxLength.value;
      return obj;
    }
    case 'ZodBoolean': {
      return { type: 'boolean' };
    }
    case 'ZodLiteral': {
      const value = (def as unknown as { value: unknown }).value;
      return { const: value };
    }
    case 'ZodEffects': {
      // `.refine()` / `.transform()` wrap the underlying schema in a
      // ZodEffects layer. The model can't see the runtime predicate anyway,
      // so we strip the effect and emit JSON Schema for the inner shape.
      // Validation-side, the runtime still parses through the full schema
      // (including the refinement) — see `args.tool.input_schema.parse`
      // below — so any model output that violates the predicate fails there.
      const inner = (def as unknown as { schema: z.ZodTypeAny }).schema;
      return zodToJsonSchema(inner);
    }
    default:
      throw new Error(`zodToJsonSchema: unsupported type ${def.typeName}`);
  }
}

/**
 * Thin wrapper over `Anthropic.messages.create` that forces structured output
 * via tool-use and parses the result through the supplied zod schema.
 *
 * Steps:
 * 1. Convert the zod schema in `args.tool.input_schema` to JSON schema (inline
 *    minimal impl above).
 * 2. Issue a `messages.create` call with `tool_choice: { type: 'tool', name }`
 *    so the model is required to invoke the named tool.
 * 3. Find the `tool_use` content block; throw with a recognisable message if
 *    the model declined to invoke the tool (defensive — `tool_choice` makes
 *    this rare but not impossible).
 * 4. Re-parse `block.input` through the zod schema as a final safety check
 *    against the model returning JSON that doesn't match the declared shape.
 */
export async function callWithToolUse<O>(
  client: Anthropic,
  args: {
    model: string;
    system: string;
    user: string;
    tool: ToolDef<O>;
    max_tokens?: number;
    /**
     * Optional per-call abort signal — passed through to the Anthropic SDK as
     * a request-level cancellation. Use this when the caller has a tighter
     * latency budget than the SDK's default 30s (e.g. the signup pipeline,
     * which has a 2s budget). If the signal fires the SDK rejects with an
     * AbortError; callers should catch and route to a permissive fallback.
     */
    signal?: AbortSignal;
  },
): Promise<{ output: O; tokens_in: number; tokens_out: number }> {
  const res = await client.messages.create(
    {
      model: args.model,
      max_tokens: args.max_tokens ?? 1024,
      system: args.system,
      messages: [{ role: 'user', content: args.user }],
      tools: [
        {
          name: args.tool.name,
          description: args.tool.description,
          // The Anthropic SDK's `Tool['input_schema']` is structurally a JSON
          // schema with `type: 'object'`; our minimal converter satisfies that
          // contract but TS can't verify it through the generic plumbing. Cast.
          input_schema: zodToJsonSchema(args.tool.input_schema) as Anthropic.Tool['input_schema'],
        },
      ],
      tool_choice: { type: 'tool', name: args.tool.name },
    },
    args.signal ? { signal: args.signal } : undefined,
  );
  const block = res.content.find((c) => c.type === 'tool_use');
  if (!block) throw new Error('classifier did not invoke the structured-output tool');
  const parsed = args.tool.input_schema.parse(block.input);
  return { output: parsed, tokens_in: res.usage.input_tokens, tokens_out: res.usage.output_tokens };
}
