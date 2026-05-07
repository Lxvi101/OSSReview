export const FINDINGS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'findings'],
  properties: {
    summary: {
      type: 'object',
      additionalProperties: false,
      required: ['body', 'verdict'],
      properties: {
        body: { type: 'string', minLength: 1, maxLength: 20_000 },
        verdict: { enum: ['approve', 'request_changes', 'comment'] },
      },
    },
    findings: {
      type: 'array',
      maxItems: 200,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['filePath', 'severity', 'body'],
        properties: {
          filePath: { type: 'string', minLength: 1 },
          lineStart: { type: 'integer', minimum: 1 },
          lineEnd: { type: 'integer', minimum: 1 },
          severity: { enum: ['blocker', 'warning', 'suggestion', 'nit', 'praise'] },
          body: { type: 'string', minLength: 1, maxLength: 20_000 },
          suggestion: { type: 'string', maxLength: 30_000 },
          category: { type: 'string', maxLength: 80 },
        },
      },
    },
  },
} as const;
