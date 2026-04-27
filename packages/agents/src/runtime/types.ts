import type { z } from 'zod';

export type ToolDef<O> = {
  name: string;
  description: string;
  input_schema: z.ZodType<O>;
};

export type PromptDefinition<O> = {
  name: string;
  version: string; // semver, e.g. '1.0.0'
  system: string;
  tool: ToolDef<O>;
};

export type AgentSpanAttrs = {
  agent_name: string;
  prompt_version: string;
  model: string;
  tenant_id?: string;
  subject_tenant_id?: string;
  tokens_in?: number;
  tokens_out?: number;
  cache_hit?: boolean;
  classification_kind?: string;
  classification_confidence?: number;
};
