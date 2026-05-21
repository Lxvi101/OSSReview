import { z } from 'zod';

/**
 * Bootstrap schema. Required fields are required at boot, period — exit 78
 * with a single human-readable block listing every offending var.
 */

const HEX_32 = /^[0-9a-fA-F]{64}$/;

export const BootEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_URL: z.string().url(),
  DATABASE_PATH: z.string().min(1).default('./data/gcr.sqlite'),
  /** Optional override for the React dashboard build dir. Empty = use default
   * resolution (next to apps/server/dist in the Docker image, ../dashboard/dist in dev). */
  DASHBOARD_DIST: z.string().default(''),

  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 chars'),
  SECRETS_KEY: z
    .string()
    .regex(
      HEX_32,
      'SECRETS_KEY must be 32-byte hex (64 hex chars). Generate with: openssl rand -hex 32',
    ),

  REVIEWER_PROVIDER: z.enum(['claude', 'codex', 'acp']).default('claude'),
  REVIEWER_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(20 * 60 * 1000),
  CLAUDE_CODE_BINARY: z.string().min(1).default('claude'),
  CLAUDE_CODE_HOME: z.string().default(''),
  CLAUDE_CODE_MODEL: z.string().min(1).default('claude-sonnet-4-5'),
  CODEX_BINARY: z.string().min(1).default('codex'),
  CODEX_HOME: z.string().default(''),
  CODEX_MODEL: z.string().min(1).default('gpt-5-codex'),

  // Generic Agent Client Protocol reviewer. Drives any ACP-compliant agent
  // as a subprocess. `github-copilot` runs `copilot --acp`; `custom` takes
  // command/args entirely from ACP_AGENT_COMMAND / ACP_AGENT_ARGS.
  ACP_AGENT: z.enum(['github-copilot', 'custom']).default('github-copilot'),
  ACP_AGENT_COMMAND: z.string().default(''),
  ACP_AGENT_ARGS: z.string().default(''),
  ACP_AGENT_HOME: z.string().default(''),
  ACP_MODEL: z.string().default(''),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  METRICS_BIND: z
    .string()
    .regex(/^.+:\d+$/, 'METRICS_BIND must be host:port')
    .default('127.0.0.1:9090'),

  // Fastify trustProxy value. Defaults to 'loopback' (127.0.0.1, ::1) which
  // is correct for the bundled compose setup. Set to your reverse proxy's
  // IP or CIDR when deploying behind one; never use 'true' from the
  // open internet.
  TRUSTED_PROXY_IPS: z.string().min(1).default('loopback'),
});

export type BootEnv = z.infer<typeof BootEnvSchema>;
