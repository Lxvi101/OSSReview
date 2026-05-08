import { zodToJsonSchema } from 'zod-to-json-schema';
import { SubmitFindingsInputSchema } from '../claude/findingsSchema.js';

/**
 * JSON Schema for the Codex CLI `--output-schema` flag.
 *
 * Generated from the same zod schema the Claude adapter uses, so the two
 * providers stay in lock-step automatically. Codex's structured-output
 * machinery is JSON-Schema-shaped; this is the bridge.
 */
export const FINDINGS_JSON_SCHEMA = zodToJsonSchema(SubmitFindingsInputSchema, {
  $refStrategy: 'none',
  target: 'jsonSchema7',
});
