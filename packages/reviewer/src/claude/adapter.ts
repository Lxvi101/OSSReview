/**
 * Claude Code SDK adapter for the `Reviewer` port.
 *
 * This adapter runs in-process in the worker and drives the locally installed
 * `claude` executable through `@anthropic-ai/claude-agent-sdk`. Auth comes
 * from the same Claude Code home that the worker process can read.
 *
 * Usage with an SDK stub:
 *   const reviewer = new ClaudeReviewer({ defaultModel, driver });
 *   const result = await reviewer.review(input);
 *
 * The legacy Docker/API-key sandbox still imports this adapter through
 * `../sandbox/entrypoint.ts`, which is why `apiKey` remains optional here.
 */

import {
  type ReviewFinding,
  type ReviewResult,
  type Reviewer,
  type ReviewerInput,
} from '../port.js';
import {
  type SubmitFindingsInput,
  SubmitFindingsInputSchema,
} from './findingsSchema.js';
import { PROMPT_VERSION, SYSTEM_PROMPT, buildUserPrompt } from './prompt.js';

/** Optional injection point: a function returning the SDK driver. */
export type ClaudeDriver = (req: ClaudeDriverRequest) => Promise<ClaudeDriverResponse>;

export interface ClaudeDriverRequest {
  readonly apiKey?: string;
  readonly binaryPath?: string;
  readonly homePath?: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly workspaceDir: string;
  readonly toolSchema: unknown;
  readonly maxTurns: number;
  readonly maxOutputTokens: number;
  readonly walClockMs: number;
  readonly signal: AbortSignal;
}

export interface ClaudeDriverResponse {
  readonly toolInput: unknown;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly costUsdMicros?: number;
  readonly durationMs: number;
}

export interface ClaudeReviewerOptions {
  readonly apiKey?: string;
  readonly binaryPath?: string;
  readonly homePath?: string;
  readonly defaultModel: string;
  /** Override the SDK driver (real implementation lives in `./driver.ts`). */
  readonly driver?: ClaudeDriver;
}

export class ClaudeReviewer implements Reviewer {
  readonly name = 'claude-code';
  readonly version = PROMPT_VERSION;
  private readonly driver: ClaudeDriver;

  constructor(private readonly opts: ClaudeReviewerOptions) {
    this.driver = opts.driver ?? defaultDriver;
  }

  async review(input: ReviewerInput): Promise<ReviewResult> {
    const model = input.settings.model ?? this.opts.defaultModel;
    const userPrompt = buildUserPrompt({
      pr: input.pr,
      diff: input.diff,
      ...(input.settings.promptAddendum !== undefined ? { addendum: input.settings.promptAddendum } : {}),
    });

    const baseRequest: ClaudeDriverRequest = {
      ...(this.opts.apiKey !== undefined ? { apiKey: this.opts.apiKey } : {}),
      ...(this.opts.binaryPath !== undefined ? { binaryPath: this.opts.binaryPath } : {}),
      ...(this.opts.homePath !== undefined ? { homePath: this.opts.homePath } : {}),
      model,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      workspaceDir: input.workspaceDir,
      toolSchema: SubmitFindingsInputSchema,
      maxTurns: input.settings.maxTurns ?? 30,
      maxOutputTokens: input.settings.maxOutputTokens ?? 64_000,
      walClockMs: input.settings.walClockMs ?? 20 * 60 * 1000,
      signal: input.signal,
    };

    let attempt = 0;
    // One repair turn allowed if validation fails the first time.
    let lastError: unknown = null;
    while (attempt < 2) {
      attempt++;
      const response = await this.driver(
        attempt === 1
          ? baseRequest
          : {
              ...baseRequest,
              userPrompt: `${userPrompt}\n\n## Previous attempt failed validation\n${String(lastError)}\n\nCall \`submit_findings\` again with valid input.`,
            },
      );

      const parsed = SubmitFindingsInputSchema.safeParse(response.toolInput);
      if (!parsed.success) {
        lastError = parsed.error.message;
        continue;
      }

      return finalize(parsed.data, response, model, this.name, this.version);
    }

    throw new Error(`Claude reviewer: tool input failed schema validation after retry: ${String(lastError)}`);
  }
}

function finalize(
  data: SubmitFindingsInput,
  meta: ClaudeDriverResponse,
  model: string,
  name: string,
  version: string,
): ReviewResult {
  const findings: ReviewFinding[] = data.findings.map((f) => {
    const out: Mutable<ReviewFinding> = {
      filePath: f.filePath,
      severity: f.severity,
      body: f.body,
    };
    if (f.lineStart !== undefined) out.lineStart = f.lineStart;
    if (f.lineEnd !== undefined) out.lineEnd = f.lineEnd;
    if (f.suggestion !== undefined) out.suggestion = f.suggestion;
    if (f.category !== undefined) out.category = f.category;
    return out;
  });

  const result: Mutable<ReviewResult> = {
    summary: data.summary,
    findings,
    meta: {
      reviewerName: name,
      reviewerVersion: version,
      model,
      durationMs: meta.durationMs,
    } as ReviewResult['meta'],
  };
  if (meta.inputTokens !== undefined) (result.meta as Mutable<ReviewResult['meta']>).inputTokens = meta.inputTokens;
  if (meta.outputTokens !== undefined) (result.meta as Mutable<ReviewResult['meta']>).outputTokens = meta.outputTokens;
  if (meta.cachedInputTokens !== undefined) (result.meta as Mutable<ReviewResult['meta']>).cachedInputTokens = meta.cachedInputTokens;
  if (meta.costUsdMicros !== undefined) (result.meta as Mutable<ReviewResult['meta']>).costUsdMicros = meta.costUsdMicros;
  return result;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * The default driver — calls the Claude Code SDK (`@anthropic-ai/claude-agent-sdk`).
 *
 * Implemented as a separate function (`./driver.ts`) so tests inject a fake
 * without ever loading the SDK module — useful when the SDK takes a moment
 * to boot, or when a contributor without local Claude auth wants to run the
 * suite.
 */
async function defaultDriver(req: ClaudeDriverRequest): Promise<ClaudeDriverResponse> {
  // Lazy import: keeps the SDK out of the import graph for callers that
  // always inject their own driver (FakeReviewer-based tests, the storage
  // package, the queue, etc.).
  const { realClaudeDriver } = await import('./driver.js');
  return realClaudeDriver(req);
}
