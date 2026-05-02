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
      return { type: 'object', properties, required };
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
  args: { model: string; system: string; user: string; tool: ToolDef<O>; max_tokens?: number },
): Promise<{ output: O; tokens_in: number; tokens_out: number }> {
  const res = await client.messages.create({
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
  });
  const block = res.content.find((c) => c.type === 'tool_use');
  if (!block) throw new Error('classifier did not invoke the structured-output tool');
  const parsed = args.tool.input_schema.parse(block.input);
  return { output: parsed, tokens_in: res.usage.input_tokens, tokens_out: res.usage.output_tokens };
}
